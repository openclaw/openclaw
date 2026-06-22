// Mattermost plugin module implements target resolution behavior.
import { isPrivateNetworkOptInEnabled } from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveMattermostAccount } from "./accounts.js";
import {
  isMattermostId,
  recordMattermostChannelChatType,
  resetMattermostChatTypeCacheForTests,
} from "./chat-type-cache.js";
import {
  createMattermostClient,
  fetchMattermostChannel,
  fetchMattermostUser,
  normalizeMattermostBaseUrl,
} from "./client.js";
import { mapMattermostChannelTypeToChatType } from "./monitor-gating.js";
import type { OpenClawConfig } from "./runtime-api.js";

export { isMattermostId };

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

function parseExplicitMattermostTarget(raw: string):
  | {
      kind: MattermostOpaqueTargetKind;
      id: string;
    }
  | undefined {
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("user:")) {
    return { kind: "user", id: trimmed.slice("user:".length).trim() };
  }
  if (lower.startsWith("mattermost:")) {
    return { kind: "user", id: trimmed.slice("mattermost:".length).trim() };
  }
  if (lower.startsWith("group:")) {
    return { kind: "group", id: trimmed.slice("group:".length).trim() };
  }
  if (lower.startsWith("channel:")) {
    return { kind: "channel", id: trimmed.slice("channel:".length).trim() };
  }
  return undefined;
}

function buildMattermostOpaqueTarget(
  kind: MattermostOpaqueTargetKind,
  id: string,
): MattermostOpaqueTargetResolution {
  return {
    kind,
    id,
    to: kind === "user" ? `user:${id}` : `channel:${id}`,
  };
}

function mapMattermostChannelTargetKind(channelType?: string | null): "channel" | "group" {
  return mapMattermostChannelTypeToChatType(channelType) === "group" ? "group" : "channel";
}

export async function resolveMattermostOpaqueTarget(params: {
  input: string;
  cfg?: OpenClawConfig;
  accountId?: string | null;
  token?: string;
  baseUrl?: string;
}): Promise<MattermostOpaqueTargetResolution | null> {
  const input = params.input.trim();
  if (!input) {
    return null;
  }
  const explicit = parseExplicitMattermostTarget(input);
  const lookupId = explicit?.id ?? input;
  if (!lookupId || !isMattermostId(lookupId)) {
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

  if (explicit?.kind === "user" || explicit?.kind === "group") {
    return buildMattermostOpaqueTarget(explicit.kind, lookupId);
  }

  const key = cacheKey(baseUrl, token, lookupId);
  const cached = mattermostOpaqueTargetCache.get(key);
  if (cached) {
    return buildMattermostOpaqueTarget(cached, lookupId);
  }

  const client = createMattermostClient({
    baseUrl,
    botToken: token,
    allowPrivateNetwork: isPrivateNetworkOptInEnabled(account?.config),
  });
  if (!explicit) {
    try {
      await fetchMattermostUser(client, lookupId);
      mattermostOpaqueTargetCache.set(key, "user");
      return buildMattermostOpaqueTarget("user", lookupId);
    } catch (err) {
      if (parseMattermostApiStatus(err) !== 404) {
        return buildMattermostOpaqueTarget("channel", lookupId);
      }
    }
  }

  try {
    const channel = await fetchMattermostChannel(client, lookupId);
    const kind = mapMattermostChannelTargetKind(channel.type);
    mattermostOpaqueTargetCache.set(key, kind);
    recordMattermostChannelChatType(lookupId, channel.type);
    return buildMattermostOpaqueTarget(kind, lookupId);
  } catch (err) {
    if (parseMattermostApiStatus(err) === 404) {
      mattermostOpaqueTargetCache.set(key, "channel");
    }
    return buildMattermostOpaqueTarget("channel", lookupId);
  }
}

export function resetMattermostOpaqueTargetCacheForTests(): void {
  mattermostOpaqueTargetCache.clear();
  resetMattermostChatTypeCacheForTests();
}
