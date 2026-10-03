// Settings in Urbit's %settings agent hot-reload without restarting the Gateway.
import { filterStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { UrbitSSEClient } from "./urbit/sse-client.js";

export const TLON_PENDING_APPROVAL_LIMIT = 100;

/** Pending approval request stored for persistence */
export type PendingApproval = {
  id: string;
  type: "dm" | "channel" | "group";
  requestingShip: string;
  channelNest?: string;
  groupFlag?: string;
  messagePreview?: string;
  /** Full message context for processing after approval */
  originalMessage?: {
    messageId: string;
    messageText: string;
    messageContent: unknown;
    timestamp: number;
    /** Authenticated DM peer recorded at admission; absent on legacy approvals. */
    authenticatedSenderShip?: string;
    parentId?: string;
    isThreadReply?: boolean;
  };
  timestamp: number;
};

export type TlonSettingsStore = {
  groupChannels?: string[];
  dmAllowlist?: string[];
  showModelSig?: boolean;
  autoAcceptDmInvites?: boolean;
  autoDiscoverChannels?: boolean;
  autoAcceptGroupInvites?: boolean;
  /** Ships allowed to invite us to groups (when autoAcceptGroupInvites is true) */
  groupInviteAllowlist?: string[];
  channelRules?: Record<
    string,
    {
      mode?: "restricted" | "open";
      allowedShips?: string[];
      requireMentionInBotThreads?: boolean;
    }
  >;
  defaultAuthorizedShips?: string[];
  /** Ship that receives approval requests for DMs, channel mentions, and group invites */
  ownerShip?: string;
  /** Pending approval requests awaiting owner response */
  pendingApprovals?: PendingApproval[];
};

const SETTINGS_DESK = "moltbot";
const SETTINGS_BUCKET = "tlon";

/**
 * Parse channelRules - handles both JSON string and object formats.
 * Settings-store doesn't support nested objects, so we store as JSON string.
 */
function parseChannelRules(value: unknown): TlonSettingsStore["channelRules"] {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  return isChannelRulesObject(parsed) ? parsed : undefined;
}

/**
 * Parse settings from the raw Urbit settings-store response.
 * The response shape is: { [bucket]: { [key]: value } }
 */
function parseSettingsResponse(raw: unknown): TlonSettingsStore {
  if (!raw || typeof raw !== "object") {
    return {};
  }

  const desk = raw as Record<string, unknown>;
  const bucket = desk[SETTINGS_BUCKET];
  if (!bucket || typeof bucket !== "object") {
    return {};
  }

  const settings = bucket as Record<string, unknown>;

  return {
    groupChannels: Array.isArray(settings.groupChannels)
      ? filterStringEntries(settings.groupChannels)
      : undefined,
    dmAllowlist: Array.isArray(settings.dmAllowlist)
      ? filterStringEntries(settings.dmAllowlist)
      : undefined,
    autoDiscoverChannels:
      typeof settings.autoDiscoverChannels === "boolean"
        ? settings.autoDiscoverChannels
        : undefined,
    showModelSig: typeof settings.showModelSig === "boolean" ? settings.showModelSig : undefined,
    autoAcceptDmInvites:
      typeof settings.autoAcceptDmInvites === "boolean" ? settings.autoAcceptDmInvites : undefined,
    autoAcceptGroupInvites:
      typeof settings.autoAcceptGroupInvites === "boolean"
        ? settings.autoAcceptGroupInvites
        : undefined,
    groupInviteAllowlist: Array.isArray(settings.groupInviteAllowlist)
      ? filterStringEntries(settings.groupInviteAllowlist)
      : undefined,
    channelRules: parseChannelRules(settings.channelRules),
    defaultAuthorizedShips: Array.isArray(settings.defaultAuthorizedShips)
      ? filterStringEntries(settings.defaultAuthorizedShips)
      : undefined,
    ownerShip: typeof settings.ownerShip === "string" ? settings.ownerShip : undefined,
    pendingApprovals: parsePendingApprovals(settings.pendingApprovals),
  };
}

function isChannelRulesObject(val: unknown): val is NonNullable<TlonSettingsStore["channelRules"]> {
  if (!val || typeof val !== "object" || Array.isArray(val)) {
    return false;
  }
  for (const [, rule] of Object.entries(val)) {
    if (!rule || typeof rule !== "object") {
      return false;
    }
  }
  return true;
}

/**
 * Parse pendingApprovals - handles both JSON string and array formats.
 * Settings-store stores complex objects as JSON strings.
 */
function parsePendingApprovals(value: unknown): PendingApproval[] | undefined {
  if (!value) {
    return undefined;
  }

  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return undefined;
    }
  }

  if (!Array.isArray(parsed)) {
    return undefined;
  }

  return parsed.filter((item): item is PendingApproval => {
    if (!item || typeof item !== "object") {
      return false;
    }
    const obj = item as Record<string, unknown>;
    return (
      typeof obj.id === "string" &&
      (obj.type === "dm" || obj.type === "channel" || obj.type === "group") &&
      typeof obj.requestingShip === "string" &&
      typeof obj.timestamp === "number"
    );
  });
}

function parseSettingsEvent(event: unknown): { key: string; value: unknown } | null {
  if (!event || typeof event !== "object") {
    return null;
  }

  const evt = event as Record<string, unknown>;

  const operation = evt["put-entry"] ? "put-entry" : "del-entry";
  const entry = evt[operation] as Record<string, unknown> | undefined;
  if (!entry || entry.desk !== SETTINGS_DESK || entry["bucket-key"] !== SETTINGS_BUCKET) {
    return null;
  }
  return {
    key: typeof entry["entry-key"] === "string" ? entry["entry-key"] : "",
    value: operation === "put-entry" ? entry.value : undefined,
  };
}

function applySettingsUpdate(
  current: TlonSettingsStore,
  key: string,
  value: unknown,
): TlonSettingsStore {
  const parsed = parseSettingsResponse({ [SETTINGS_BUCKET]: { [key]: value } });
  return Object.hasOwn(parsed, key)
    ? { ...current, [key]: parsed[key as keyof TlonSettingsStore] }
    : { ...current };
}

export async function putTlonSetting(
  api: Pick<UrbitSSEClient, "poke">,
  key: keyof TlonSettingsStore,
  value: unknown,
): Promise<void> {
  await api.poke({
    app: "settings",
    mark: "settings-event",
    json: {
      "put-entry": {
        desk: SETTINGS_DESK,
        "bucket-key": SETTINGS_BUCKET,
        "entry-key": key,
        value,
      },
    },
  });
}

type SettingsLogger = {
  log?: (msg: string) => void;
  error?: (msg: string) => void;
};

export function createSettingsManager(api: UrbitSSEClient, logger?: SettingsLogger) {
  let current: TlonSettingsStore = {};

  const listeners = new Set<(settings: TlonSettingsStore) => void>();

  const notify = () => {
    for (const listener of listeners) {
      try {
        listener(current);
      } catch (err) {
        logger?.error?.(`[settings] Listener error: ${String(err)}`);
      }
    }
  };

  return {
    async load(): Promise<TlonSettingsStore> {
      try {
        const raw = await api.scry("/settings/all.json");
        // Response shape: { all: { [desk]: { [bucket]: { [key]: value } } } }
        const allData = raw as { all?: Record<string, Record<string, unknown>> };
        const deskData = allData?.all?.[SETTINGS_DESK];
        current = parseSettingsResponse(deskData ?? {});
        logger?.log?.(`[settings] Loaded: ${JSON.stringify(current)}`);
        return current;
      } catch (err) {
        // Settings desk may not exist yet - that's fine, use defaults
        logger?.log?.(`[settings] No settings found (using defaults): ${String(err)}`);
        current = {};
        return current;
      }
    },

    async startSubscription(): Promise<void> {
      await api.subscribe({
        app: "settings",
        path: "/desk/" + SETTINGS_DESK,
        event: (event) => {
          const update = parseSettingsEvent(event);
          if (!update) {
            return;
          }

          logger?.log?.(`[settings] Update: ${update.key} = ${JSON.stringify(update.value)}`);
          current = applySettingsUpdate(current, update.key, update.value);
          notify();
        },
        err: (error) => {
          logger?.error?.(`[settings] Subscription error: ${String(error)}`);
        },
        quit: () => {
          logger?.log?.("[settings] Subscription ended");
        },
      });
      logger?.log?.("[settings] Subscribed to settings updates");
    },

    onChange(listener: (settings: TlonSettingsStore) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
