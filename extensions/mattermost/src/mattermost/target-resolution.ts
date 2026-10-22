import { createStaleWhileRevalidateCache } from "openclaw/plugin-sdk/collection-runtime";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveMattermostAccount } from "./accounts.js";
import {
  createMattermostClient,
  fetchMattermostChannel,
  fetchMattermostUser,
  normalizeMattermostBaseUrl,
  parseMattermostApiStatus,
  type MattermostClient,
} from "./client.js";
import { resolveMattermostTrustedChatKind } from "./monitor-auth.js";
import type { OpenClawConfig } from "./runtime-api.js";

type MattermostOpaqueTargetResolution = {
  kind: "user" | "channel" | "group";
  id: string;
  to: string;
};

export type MattermostTarget =
  | { kind: "channel"; id: string }
  | { kind: "channel-name"; name: string }
  | { kind: "user"; id?: string; username?: string };

const mattermostOpaqueTargetCache = createStaleWhileRevalidateCache<
  MattermostOpaqueTargetResolution["kind"] | undefined
>({
  maxEntries: 1024,
  maxPending: Number.POSITIVE_INFINITY,
  ttlMs: 5 * 60 * 1000,
  cacheable: (kind) => kind !== undefined,
});

function cacheKey(baseUrl: string, token: string, id: string): string {
  return `${baseUrl}::${token}::${id}`;
}

/** Mattermost IDs are 26-character lowercase alphanumeric strings. */
function isMattermostId(value: string): boolean {
  return /^[a-z0-9]{26}$/.test(value);
}

export function parseMattermostTarget(raw: string): MattermostTarget {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Recipient is required for Mattermost sends");
  }
  const lower = normalizeLowercaseStringOrEmpty(trimmed);
  if (lower.startsWith("channel:")) {
    const id = trimmed.slice("channel:".length).trim();
    if (!id) {
      throw new Error("Channel id is required for Mattermost sends");
    }
    if (id.startsWith("#")) {
      const name = id.slice(1).trim();
      if (!name) {
        throw new Error("Channel name is required for Mattermost sends");
      }
      return { kind: "channel-name", name };
    }
    if (!isMattermostId(id)) {
      return { kind: "channel-name", name: id };
    }
    return { kind: "channel", id };
  }
  if (lower.startsWith("user:") || lower.startsWith("mattermost:")) {
    const id = trimmed.slice(trimmed.indexOf(":") + 1).trim();
    if (!id) {
      throw new Error("User id is required for Mattermost sends");
    }
    return { kind: "user", id };
  }
  if (trimmed.startsWith("@")) {
    const username = trimmed.slice(1).trim();
    if (!username) {
      throw new Error("Username is required for Mattermost sends");
    }
    return { kind: "user", username };
  }
  if (trimmed.startsWith("#")) {
    const name = trimmed.slice(1).trim();
    if (!name) {
      throw new Error("Channel name is required for Mattermost sends");
    }
    return { kind: "channel-name", name };
  }
  if (!isMattermostId(trimmed)) {
    return { kind: "channel-name", name: trimmed };
  }
  return { kind: "channel", id: trimmed };
}

export async function resolveMattermostOpaqueTarget(
  params: { input: string } & (
    | { cfg: OpenClawConfig; accountId?: string | null }
    | { client: MattermostClient }
  ),
): Promise<MattermostOpaqueTargetResolution | null> {
  const input = params.input.trim();
  if (!isMattermostId(input)) {
    return null;
  }

  let client: MattermostClient;
  if ("client" in params) {
    client = params.client;
  } else {
    const account = resolveMattermostAccount({ cfg: params.cfg, accountId: params.accountId });
    if (!account.enabled) {
      throw new Error(`Mattermost account "${account.accountId}" is disabled`);
    }
    const token = normalizeOptionalString(account.botToken);
    const baseUrl = normalizeMattermostBaseUrl(account.baseUrl);
    if (!token || !baseUrl) {
      return null;
    }
    client = createMattermostClient({
      baseUrl,
      botToken: token,
      allowPrivateNetwork: account.config.network?.dangerouslyAllowPrivateNetwork === true,
    });
  }

  const key = cacheKey(client.baseUrl, client.token, input);
  const { value } = await mattermostOpaqueTargetCache.read(
    key,
    async () => {
      try {
        await fetchMattermostUser(client, input);
        return "user";
      } catch (err) {
        if (parseMattermostApiStatus(err) !== 404) {
          return undefined;
        }
      }
      // Cache only authoritative lookups: transient fallbacks must not fork private sessions.
      try {
        const channel = await fetchMattermostChannel(client, input);
        return resolveMattermostTrustedChatKind({ channelType: channel.type }) === "group"
          ? "group"
          : "channel";
      } catch {
        return undefined;
      }
    },
    { allowStale: false },
  );
  const kind = value ?? "channel";
  return { kind, id: input, to: `${kind === "user" ? "user" : "channel"}:${input}` };
}
