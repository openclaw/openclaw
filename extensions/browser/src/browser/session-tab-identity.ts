import { createHash } from "node:crypto";
import { normalizeAgentIdStrict, parseAgentSessionKey } from "openclaw/plugin-sdk/routing";

export function resolveBrowserSessionKey(
  sessionKey: string | undefined,
  agentId?: string,
): string | undefined {
  const raw = sessionKey?.trim();
  if (!raw) {
    return undefined;
  }
  const parsed = parseAgentSessionKey(raw);
  const owner = parsed?.agentId ?? agentId?.trim().toLowerCase();
  const normalized = normalizeAgentIdStrict(owner);
  if (!normalized.ok || normalized.value !== owner) {
    return undefined;
  }
  const scoped =
    parsed ??
    (!raw.toLowerCase().startsWith("agent:")
      ? parseAgentSessionKey(`agent:${normalized.value}:${raw}`)
      : undefined);
  return scoped ? `agent:${scoped.agentId}:${scoped.rest}` : undefined;
}

export function browserSessionTabStorageKey(record: {
  sessionKey: string;
  nativeTargetId: string;
  profileFingerprint: string;
  browserInstanceFingerprint: string;
}): string {
  return `sha256:${createHash("sha256")
    .update(
      JSON.stringify([
        record.sessionKey,
        record.nativeTargetId,
        record.profileFingerprint,
        record.browserInstanceFingerprint,
      ]),
    )
    .digest("hex")}`;
}

export function browserSessionTabNativeIdentity(record: {
  sessionKey: string;
  profile: string;
  nativeTargetId: string;
}): string {
  return `${record.sessionKey}\u0000${record.profile}\u0000${record.nativeTargetId}`;
}
