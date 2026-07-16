import { randomBytes } from "node:crypto";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";

const DAY_MS = 24 * 60 * 60 * 1000;
const DISCORD_EPOCH_MS = 1_420_070_400_000;
const WIDGET_TTL_MS = 7 * DAY_MS;
const SESSION_TTL_MS = 15 * 60 * 1000;
const DOC_TOKEN_TTL_MS = 60 * 1000;

type DiscordActivityWidget = {
  html: string;
  title: string;
  channelId: string;
  accountId: string;
  createdAt: number;
  deliveredMessageId?: string | null;
};

type DiscordActivitySession = {
  discordUserId: string;
  accountId: string;
};

type DiscordActivityDocToken = {
  widgetId: string;
  accountId: string;
};

type AtomicPluginStateKeyedStore<T> = PluginStateKeyedStore<T> & {
  update: NonNullable<PluginStateKeyedStore<T>["update"]>;
};

type DiscordActivityStores = {
  widgets: AtomicPluginStateKeyedStore<DiscordActivityWidget>;
  sessions: PluginStateKeyedStore<DiscordActivitySession>;
  docTokens: PluginStateKeyedStore<DiscordActivityDocToken>;
};

type OpenKeyedStore = <T>(options: {
  namespace: string;
  maxEntries: number;
  overflowPolicy: "evict-oldest";
  defaultTtlMs: number;
}) => PluginStateKeyedStore<T>;

function requireAtomicUpdate<T>(store: PluginStateKeyedStore<T>): AtomicPluginStateKeyedStore<T> {
  if (!store.update) {
    throw new Error("Discord Activities require atomic plugin state updates");
  }
  return store as AtomicPluginStateKeyedStore<T>;
}

export function openDiscordActivityStores(openKeyedStore: OpenKeyedStore): DiscordActivityStores {
  return {
    widgets: requireAtomicUpdate(
      openKeyedStore<DiscordActivityWidget>({
        namespace: "activities-widgets",
        maxEntries: 64,
        overflowPolicy: "evict-oldest",
        defaultTtlMs: WIDGET_TTL_MS,
      }),
    ),
    sessions: openKeyedStore<DiscordActivitySession>({
      namespace: "activities-sessions",
      maxEntries: 256,
      overflowPolicy: "evict-oldest",
      defaultTtlMs: SESSION_TTL_MS,
    }),
    docTokens: openKeyedStore<DiscordActivityDocToken>({
      namespace: "activities-doc-tokens",
      maxEntries: 256,
      overflowPolicy: "evict-oldest",
      defaultTtlMs: DOC_TOKEN_TTL_MS,
    }),
  };
}

export class DiscordActivityStore {
  private lastWidgetCreatedAt = 0;

  constructor(private readonly stores: DiscordActivityStores) {}

  async createWidget(value: DiscordActivityWidget): Promise<string> {
    const id = randomBytes(16).toString("base64url");
    const createdAt = Math.max(value.createdAt, this.lastWidgetCreatedAt + 1);
    this.lastWidgetCreatedAt = createdAt;
    await this.stores.widgets.register(id, { ...value, createdAt, deliveredMessageId: null });
    return id;
  }

  async markWidgetDelivered(id: string, messageId: string): Promise<void> {
    if (!/^\d+$/u.test(messageId)) {
      throw new Error("Discord Activity delivery returned an invalid message ID");
    }
    const updated = await this.stores.widgets.update(id, (widget) =>
      widget ? { ...widget, deliveredMessageId: messageId } : undefined,
    );
    if (!updated) {
      throw new Error("Discord Activity widget disappeared before delivery was recorded");
    }
  }

  async deleteWidget(id: string): Promise<void> {
    await this.stores.widgets.delete(id);
  }

  async lookupWidget(id: string): Promise<DiscordActivityWidget | undefined> {
    return await this.stores.widgets.lookup(id);
  }

  async latestPostedWidgetForChannel(
    accountId: string,
    channelId: string,
  ): Promise<{
    id: string;
    widget: DiscordActivityWidget;
  } | null> {
    const entries = await this.stores.widgets.entries();
    let match: { entry: (typeof entries)[number]; deliveryOrder: bigint } | undefined;
    for (const entry of entries) {
      if (entry.value.accountId !== accountId || entry.value.channelId !== channelId) {
        continue;
      }
      // Discord snowflakes preserve canonical message order even when API responses arrive out of
      // order. Pre-tracking records fall back to their creation time; null marks a pending send.
      if (entry.value.deliveredMessageId === null) {
        continue;
      }
      const deliveryOrder = entry.value.deliveredMessageId
        ? BigInt(entry.value.deliveredMessageId)
        : BigInt(Math.max(0, Math.trunc(entry.value.createdAt - DISCORD_EPOCH_MS))) << 22n;
      if (!match || deliveryOrder > match.deliveryOrder) {
        match = { entry, deliveryOrder };
      }
    }
    return match ? { id: match.entry.key, widget: match.entry.value } : null;
  }

  async createSession(value: DiscordActivitySession): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    await this.stores.sessions.register(token, value);
    return token;
  }

  async lookupSession(token: string): Promise<DiscordActivitySession | undefined> {
    return await this.stores.sessions.lookup(token);
  }

  async createDocToken(value: DiscordActivityDocToken): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    await this.stores.docTokens.register(token, value);
    return token;
  }

  async consumeDocToken(token: string): Promise<DiscordActivityDocToken | undefined> {
    return await this.stores.docTokens.consume(token);
  }
}
