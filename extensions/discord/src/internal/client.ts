import { createHash } from "node:crypto";
import {
  ApplicationCommandType,
  GatewayDispatchEvents,
  Routes,
  type APIApplicationCommand,
  type APIInteraction,
} from "discord-api-types/v10";
import { createPermitPool } from "openclaw/plugin-sdk/concurrency-runtime";
import { asOptionalObjectRecord, asRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { DiscordCommandDeployHashStore } from "../command-deploy-store.js";
import { getGuild, getGuildMember } from "./api.guild.js";
import { getChannel } from "./api.messages.js";
import { getUser } from "./api.users.js";
import type { BaseCommand, DiscordCommand } from "./commands.js";
import { BaseMessageInteractiveComponent, parseCustomId } from "./components.base.js";
import type { Modal } from "./components.modal.js";
import { dispatchInteraction } from "./interaction-dispatch.js";
import type { GatewayPluginContract, VoicePluginContract } from "./plugin-contract.js";
import { RequestClient, type RequestClientOptions } from "./rest.js";
import { Guild, GuildMember, User, channelFactory } from "./structures.js";

type CacheEntry<T> = {
  expiresAt: number;
  value: T;
};

const DEFAULT_REST_CACHE_TTL_MS = 30_000;

const DEFAULT_MAX_ENTRIES = 5_000;

const DEFAULT_SWEEP_INTERVAL_MS = 30_000;

const CACHE_KIND_BY_EVENT = new Map<string, "channel" | "guild" | "guild-emojis" | "member">([
  [GatewayDispatchEvents.ChannelUpdate, "channel"],
  [GatewayDispatchEvents.ChannelDelete, "channel"],
  [GatewayDispatchEvents.ThreadUpdate, "channel"],
  [GatewayDispatchEvents.ThreadDelete, "channel"],
  [GatewayDispatchEvents.GuildUpdate, "guild"],
  [GatewayDispatchEvents.GuildEmojisUpdate, "guild-emojis"],
  [GatewayDispatchEvents.GuildMemberAdd, "member"],
  [GatewayDispatchEvents.GuildMemberRemove, "member"],
  [GatewayDispatchEvents.GuildMemberUpdate, "member"],
]);

type SerializedCommand = ReturnType<BaseCommand["serialize"]>;

const DISCORD_APPLICATION_COMMAND_LIMIT_REACHED = 30032;

function stableCommandKey(command: { name: string; type?: ApplicationCommandType }) {
  return `${command.type ?? ApplicationCommandType.ChatInput}:${command.name}`;
}

function stableCommandSetHash(commands: SerializedCommand[]): string {
  const stable = commands
    .toSorted((a, b) => stableCommandKey(a).localeCompare(stableCommandKey(b)))
    .map((command) => stableComparableObject(command));
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

const unorderedCommandArrayFields = new Set(["channel_types", "contexts", "integration_types"]);
const optionComparisonOmittedFields = new Set([
  "contexts",
  "default_member_permissions",
  "description_localized",
  "integration_types",
  "name_localized",
]);
const nullableLocalizationFields = new Set(["description_localizations", "name_localizations"]);

function comparableCommand(value: unknown): unknown {
  if (!value || typeof value !== "object") {
    return value;
  }
  const omit = new Set([
    "application_id",
    "description_localized",
    "dm_permission",
    "guild_id",
    "id",
    "name_localized",
    "nsfw",
    "version",
    "default_permission",
  ]);
  return stableComparableObject(
    Object.fromEntries(
      Object.entries(value).filter(([key, entry]) => !omit.has(key) && entry !== undefined),
    ),
  );
}

function stableComparableObject(value: unknown, pathValue: string[] = []): unknown {
  if (Array.isArray(value)) {
    const normalized = value.map((entry) => stableComparableObject(entry, pathValue));
    const key = pathValue.at(-1);
    if (
      key &&
      unorderedCommandArrayFields.has(key) &&
      normalized.every(
        (entry) =>
          typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean",
      )
    ) {
      return normalized.toSorted((left, right) => String(left).localeCompare(String(right)));
    }
    return normalized;
  }
  const object = asOptionalObjectRecord(value);
  if (!object) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(object)
      .filter(([key, entry]) => {
        if (entry === undefined) {
          return false;
        }
        if (entry === null && nullableLocalizationFields.has(key)) {
          return false;
        }
        if (pathValue.includes("options") && optionComparisonOmittedFields.has(key)) {
          return false;
        }
        if ((key === "required" || key === "autocomplete") && entry === false) {
          return false;
        }
        return true;
      })
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [
        key,
        typeof entry === "string" &&
        (key === "description" || pathValue.at(-1) === "description_localizations")
          ? normalizeDescriptionForComparison(entry)
          : stableComparableObject(entry, [...pathValue, key]),
      ]),
  );
}

/**
 * Normalize descriptions to match Discord's server-side storage semantics.
 * Discord collapses whitespace and removes whitespace between CJK characters.
 */
function normalizeDescriptionForComparison(description: string): string {
  const collapsed = description.replace(/\s+/g, " ");
  const cjkBoundaryWhitespace =
    /([\u3000-\u303F\u4E00-\u9FFF\uFF00-\uFFEF])\s+([\u3000-\u303F\u4E00-\u9FFF\uFF00-\uFFEF])/g;
  return collapsed
    .replace(cjkBoundaryWhitespace, "$1$2")
    .replace(cjkBoundaryWhitespace, "$1$2")
    .trim();
}

function commandsEqual(a: unknown, b: unknown) {
  return JSON.stringify(comparableCommand(a)) === JSON.stringify(comparableCommand(b));
}

class ComponentRegistry<
  T extends { customId: string; customIdParser?: typeof parseCustomId; type?: number },
> {
  private entries = new Map<string, T[]>();
  private wildcardEntries: T[] = [];

  register(entry: T): void {
    const key = (entry.customIdParser ?? parseCustomId)(entry.customId).key;
    const entries = key === "*" ? this.wildcardEntries : (this.entries.get(key) ?? []);
    if (!entries.includes(entry)) {
      entries.push(entry);
      if (key !== "*") {
        this.entries.set(key, entries);
      }
    }
  }

  resolve(customId: string, options?: { componentType?: number }): T | undefined {
    for (const entries of this.entries.values()) {
      const match = entries.find((entry) => {
        if (options?.componentType !== undefined && entry.type !== options.componentType) {
          return false;
        }
        const parser = entry.customIdParser ?? parseCustomId;
        return parser(entry.customId).key === parser(customId).key;
      });
      if (match) {
        return match;
      }
    }
    return this.wildcardEntries.find(
      (entry) => options?.componentType === undefined || entry.type === options.componentType,
    );
  }
}

export type RegisteredPlugin = (GatewayPluginContract | VoicePluginContract) & {
  registerClient?(client: Client): Promise<void> | void;
};

type AnyListener = {
  type: string;
  handle(data: unknown, client: Client): Promise<void> | void;
};

type DiscordEventQueueOptions = {
  maxQueueSize?: number;
  maxConcurrency?: number;
};

interface ClientOptions {
  clientId: string;
  token: string;
  requestOptions?: RequestClientOptions;
  commandDeployHashStore?: DiscordCommandDeployHashStore;
  eventQueue?: DiscordEventQueueOptions;
}

export class Client {
  plugins: RegisteredPlugin[] = [];
  options: ClientOptions;
  commands: DiscordCommand[];
  listeners: AnyListener[];
  rest: RequestClient;
  componentHandler = new ComponentRegistry<BaseMessageInteractiveComponent>();
  private commandDeployHash: string | undefined;
  private commandDeployHashLoaded = false;
  private readonly entityEntries = new Map<string, CacheEntry<unknown>>();
  private lastEntitySweepAt = 0;
  private eventQueue?: {
    permits: ReturnType<typeof createPermitPool>;
    maxQueueSize: number;
  };
  modalHandler = new ComponentRegistry<Modal>();

  constructor(
    options: ClientOptions,
    handlers: {
      commands?: DiscordCommand[];
      listeners?: AnyListener[];
      components?: BaseMessageInteractiveComponent[];
      modals?: Modal[];
    },
    plugins: RegisteredPlugin[] = [],
  ) {
    if (!options.clientId) {
      throw new Error("Missing Discord application ID");
    }
    if (!options.token) {
      throw new Error("Missing Discord bot token");
    }
    this.options = { ...options };
    this.commands = handlers.commands ?? [];
    this.listeners = handlers.listeners ?? [];
    this.rest = new RequestClient(options.token, options.requestOptions);
    const eventQueue = this.options.eventQueue;
    this.eventQueue = eventQueue
      ? {
          permits: createPermitPool(eventQueue.maxConcurrency ?? 50),
          maxQueueSize: eventQueue.maxQueueSize ?? 10_000,
        }
      : undefined;
    for (const component of handlers.components ?? []) {
      this.componentHandler.register(component);
    }
    for (const modal of handlers.modals ?? []) {
      this.modalHandler.register(modal);
    }
    for (const plugin of plugins) {
      void plugin.registerClient?.(this);
      this.plugins.push(plugin);
    }
  }

  getPlugin(id: "gateway"): GatewayPluginContract | undefined;
  getPlugin(id: "voice"): VoicePluginContract | undefined;
  getPlugin(id: string): RegisteredPlugin | undefined;
  getPlugin(id: string): RegisteredPlugin | undefined {
    return this.plugins.find((plugin) => plugin.id === id);
  }

  async fetchUser(id: string): Promise<User> {
    return await this.fetchCachedEntity(`user:${id}`, async () => {
      const raw = await getUser(this.rest, id);
      return new User(this, raw);
    });
  }

  async fetchChannel(id: string) {
    return await this.fetchCachedEntity(`channel:${id}`, async () => {
      const raw = await getChannel(this.rest, id);
      return channelFactory(this, raw);
    });
  }

  async fetchGuild(id: string): Promise<Guild> {
    return await this.fetchCachedEntity(`guild:${id}`, async () => {
      const raw = await getGuild(this.rest, id);
      return new Guild(this, raw);
    });
  }

  async fetchMember(guildId: string, userId: string): Promise<GuildMember> {
    return await this.fetchCachedEntity(`member:${guildId}:${userId}`, async () => {
      const raw = await getGuildMember(this.rest, guildId, userId);
      return new GuildMember(this, raw);
    });
  }

  async fetchGuildEmojis<T>(guildId: string, fetcher: () => Promise<T>): Promise<T> {
    return await this.fetchCachedEntity(`guild-emojis:${guildId}`, fetcher);
  }

  private invalidateEntityCacheForGatewayEvent(type: string, data: unknown): void {
    const kind = CACHE_KIND_BY_EVENT.get(type);
    if (!kind) {
      return;
    }
    const raw = asRecord(data);
    if (kind === "member") {
      const guildId = raw.guild_id;
      const user = asRecord(raw.user);
      if (typeof guildId === "string" && typeof user.id === "string") {
        this.entityEntries.delete(`member:${guildId}:${user.id}`);
        this.entityEntries.delete(`user:${user.id}`);
      }
    } else {
      const id = kind === "guild-emojis" ? raw.guild_id : raw.id;
      if (typeof id === "string") {
        this.entityEntries.delete(`${kind}:${id}`);
      }
    }
  }

  private async fetchCachedEntity<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
    const now = Date.now();
    // SAFETY: Each private cache key has one entity type, fixed by its fetch caller.
    const cached = this.entityEntries.get(key) as CacheEntry<T> | undefined;
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }
    if (cached) {
      this.entityEntries.delete(key);
    }
    const value = await fetcher();
    this.sweepExpiredEntities(now);
    this.entityEntries.set(key, { expiresAt: now + DEFAULT_REST_CACHE_TTL_MS, value });
    if (this.entityEntries.size > DEFAULT_MAX_ENTRIES) {
      this.entityEntries.delete(this.entityEntries.keys().next().value!);
    }
    return value;
  }

  private sweepExpiredEntities(now: number): void {
    if (now - this.lastEntitySweepAt < DEFAULT_SWEEP_INTERVAL_MS) {
      return;
    }
    this.lastEntitySweepAt = now;
    for (const [key, entry] of this.entityEntries) {
      if (entry.expiresAt <= now) {
        this.entityEntries.delete(key);
      }
    }
  }

  async deployCommands() {
    const commands = this.commands
      .filter((command) => command.name !== "*")
      .map((command) => command.serialize());
    const hash = stableCommandSetHash(commands);
    await this.loadPersistedHash();
    if (this.commandDeployHash === hash) {
      return;
    }
    await this.reconcileGlobalCommands(commands);
    this.commandDeployHash = hash;
    try {
      await this.options.commandDeployHashStore?.register(this.commandDeployCacheKey, hash);
    } catch {
      // Cache persistence must not turn a successful Discord deploy into a startup failure.
    }
  }

  // Shared stores must not let one application's hash suppress another's deploy (#77359).
  private get commandDeployCacheKey(): string {
    return `app:${this.options.clientId}:global:reconcile`;
  }

  private async reconcileGlobalCommands(desired: SerializedCommand[]) {
    const existing = (await this.requestCommandDeploy(
      "get",
      Routes.applicationCommands(this.options.clientId),
    )) as APIApplicationCommand[]; // SAFETY: Discord's command list returns these API rows.
    const existingByKey = new Map(existing.map((command) => [stableCommandKey(command), command]));
    const desiredCommands = desired.map((command) => ({
      command,
      key: stableCommandKey(command),
    }));
    const desiredKeys = new Set(desiredCommands.map(({ key }) => key));
    for (const { command, key } of desiredCommands) {
      const current = existingByKey.get(key);
      if (current && !commandsEqual(current, command)) {
        await this.requestCommandDeploy(
          "patch",
          Routes.applicationCommand(this.options.clientId, current.id),
          command,
        );
      }
    }
    for (const { command, key } of desiredCommands) {
      if (existingByKey.has(key)) {
        continue;
      }
      try {
        await this.requestCommandDeploy(
          "post",
          Routes.applicationCommands(this.options.clientId),
          command,
        );
      } catch (error) {
        if (
          !(
            error !== null &&
            typeof error === "object" &&
            "discordCode" in error &&
            error.discordCode === DISCORD_APPLICATION_COMMAND_LIMIT_REACHED
          )
        ) {
          throw error;
        }
        // Reconcile cannot create before deleting at Discord's hard cap. Bulk
        // overwrite replaces the complete set without an unsafe delete gap.
        await this.requestCommandDeploy(
          "put",
          Routes.applicationCommands(this.options.clientId),
          desired,
        );
        return;
      }
    }
    for (const command of existing) {
      if (!desiredKeys.has(stableCommandKey(command))) {
        await this.requestCommandDeploy(
          "delete",
          Routes.applicationCommand(this.options.clientId, command.id),
        );
      }
    }
  }

  private async loadPersistedHash(): Promise<void> {
    if (this.commandDeployHashLoaded) {
      return;
    }
    this.commandDeployHashLoaded = true;
    try {
      this.commandDeployHash = await this.options.commandDeployHashStore?.lookup(
        this.commandDeployCacheKey,
      );
    } catch {
      // Cache lookup failure is a miss. Reconcile repairs the canonical row after success.
    }
  }

  private async requestCommandDeploy(
    method: "get" | "post" | "put" | "patch" | "delete",
    path: string,
    body?: SerializedCommand | SerializedCommand[],
  ): Promise<unknown> {
    const rest = this.rest;
    const timeoutMs = rest.options.timeout;
    const startedAt = Date.now();
    try {
      return method === "get" || body === undefined
        ? await rest[method](path)
        : await rest[method](path, { body });
    } catch (error) {
      // Annotate only this owner's requests; concurrent startup REST traffic is unrelated.
      if (error && typeof error === "object") {
        if (
          body !== undefined &&
          (!("deployRequestBody" in error) || error.deployRequestBody === undefined)
        ) {
          Object.assign(error, { deployRequestBody: body });
        }
        Object.assign(error, {
          deployRestMethod: method,
          deployRestPath: path,
          deployRequestMs: Date.now() - startedAt,
          ...(Number.isFinite(timeoutMs) ? { deployTimeoutMs: timeoutMs } : {}),
        });
      }
      throw error;
    }
  }

  async handleInteraction(rawData: APIInteraction): Promise<void> {
    await dispatchInteraction(this, rawData);
  }

  async dispatchGatewayEvent(type: string, data: unknown): Promise<void> {
    this.invalidateEntityCacheForGatewayEvent(type, data);
    const listeners = this.listeners.filter((entry) => entry.type === type);
    if (!this.eventQueue) {
      for (const listener of listeners) {
        await listener.handle(data, this);
      }
      return;
    }
    const queue = this.eventQueue;
    await Promise.all(
      listeners.map(async (listener) => {
        if (queue.permits.pendingCount >= queue.maxQueueSize) {
          throw new Error(
            `Discord event queue is full for ${type}; maxQueueSize=${queue.maxQueueSize}`,
          );
        }
        const listenerName = listener.constructor.name || "AnonymousListener";
        const release = await queue.permits.acquire();
        const startedAt = performance.now();
        try {
          await listener.handle(data, this);
          const durationMs = performance.now() - startedAt;
          if (durationMs < 30_000) {
            return;
          }
          console.warn(
            `[EventQueue] Slow listener detected: ${listenerName} took ${durationMs}ms for event ${type}`,
          );
        } catch (error) {
          console.error(`[EventQueue] Listener ${listenerName} failed for event ${type}:`, error);
        } finally {
          release?.();
        }
      }),
    );
  }
}
