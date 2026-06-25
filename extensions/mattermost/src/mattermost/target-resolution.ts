// Mattermost plugin module implements target resolution behavior.
import { isPrivateNetworkOptInEnabled } from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveMattermostAccount } from "./accounts.js";
import {
  createMattermostClient,
  fetchMattermostChannel,
  fetchMattermostUser,
  normalizeMattermostBaseUrl,
} from "./client.js";
import { mapMattermostChannelTypeToChatType } from "./monitor-gating.js";
import type { OpenClawConfig } from "./runtime-api.js";

export type MattermostOpaqueTargetResolution = {
  kind: "user" | "channel" | "group";
  id: string;
  to: string;
};

type MattermostOpaqueTargetKind = MattermostOpaqueTargetResolution["kind"];

const mattermostOpaqueTargetCache = new Map<string, MattermostOpaqueTargetKind>();

function cacheKey(baseUrl: string, token: string, id: string): string {
  return `${baseUrl}::${token}::${id}`;
}

/** Mattermost IDs are 26-character lowercase alphanumeric strings. */
export function isMattermostId(value: string): boolean {
  return /^[a-z0-9]{26}$/.test(value);
}

export function isExplicitMattermostTarget(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }
  return (
    /^(channel|user|mattermost):/i.test(trimmed) ||
    trimmed.startsWith("@") ||
    trimmed.startsWith("#")
  );
}

export function parseMattermostApiStatus(err: unknown): number | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  const msg = "message" in err && typeof err.message === "string" ? err.message : "";
  const match = /Mattermost API (\d{3})\b/.exec(msg);
  if (!match) {
    return undefined;
  }
  const code = Number(match[1]);
  return Number.isFinite(code) ? code : undefined;
}

export async function resolveMattermostOpaqueTarget(params: {
  input: string;
  cfg?: OpenClawConfig;
  accountId?: string | null;
  token?: string;
  baseUrl?: string;
}): Promise<MattermostOpaqueTargetResolution | null> {
  const input = params.input.trim();
  if (!input || isExplicitMattermostTarget(input) || !isMattermostId(input)) {
    return null;
  }

  const account =
    params.cfg && (!params.token || !params.baseUrl)
      ? resolveMattermostAccount({ cfg: params.cfg, accountId: params.accountId })
      : null;
  const token = normalizeOptionalString(params.token) ?? normalizeOptionalString(account?.botToken);
  const baseUrl = normalizeMattermostBaseUrl(params.baseUrl ?? account?.baseUrl);
  if (!token || !baseUrl) {
    return null;
  }

  const key = cacheKey(baseUrl, token, input);
  const cached = mattermostOpaqueTargetCache.get(key);
  if (cached === "user") {
    return { kind: "user", id: input, to: `user:${input}` };
  }
  if (cached === "channel" || cached === "group") {
    return { kind: cached, id: input, to: `channel:${input}` };
  }

  const client = createMattermostClient({
    baseUrl,
    botToken: token,
    allowPrivateNetwork: isPrivateNetworkOptInEnabled(account?.config),
  });
  try {
    await fetchMattermostUser(client, input);
    mattermostOpaqueTargetCache.set(key, "user");
    return { kind: "user", id: input, to: `user:${input}` };
  } catch (err) {
    if (parseMattermostApiStatus(err) !== 404) {
      // Unknown lookup error: stay best-effort and do not cache the result.
      return { kind: "channel", id: input, to: `channel:${input}` };
    }
    // 404 => not a user, so it is a channel. Resolve its kind so a private channel
    // or group DM (`P`/`G`) is keyed as `group`, not `channel` (#95646). The wire
    // target stays `channel:<id>` — Mattermost posts to the channel id either way.
    const channelKind = await resolveMattermostChannelKind(client, input);
    mattermostOpaqueTargetCache.set(key, channelKind);
    return { kind: channelKind, id: input, to: `channel:${input}` };
  }
}

async function resolveMattermostChannelKind(
  client: ReturnType<typeof createMattermostClient>,
  channelId: string,
): Promise<"channel" | "group"> {
  try {
    const channel = await fetchMattermostChannel(client, channelId);
    return mapMattermostChannelTypeToChatType(channel.type) === "group" ? "group" : "channel";
  } catch {
    // Channel lookup failed; fall back to the non-group default.
    return "channel";
  }
}

export function resetMattermostOpaqueTargetCacheForTests(): void {
  mattermostOpaqueTargetCache.clear();
}
