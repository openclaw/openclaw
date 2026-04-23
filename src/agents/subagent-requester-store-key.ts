import {
  resolveAgentIdFromSessionKey,
  resolveMainSessionKey,
} from "../config/sessions/main-session.js";
import { normalizeMainKey } from "../routing/session-key.js";

type RequesterStoreKeyConfig = {
  session?: { mainKey?: string };
  agents?: { list?: Array<{ id?: string; default?: boolean }> };
};

export function resolveRequesterStoreKey(
  cfg: RequesterStoreKeyConfig | undefined,
  requesterSessionKey: string,
): string {
  const raw = (requesterSessionKey ?? "").trim();
  if (!raw) {
    return raw;
  }
  if (raw === "global" || raw === "unknown") {
    return raw;
  }
  if (raw.startsWith("agent:")) {
    return raw;
  }
  const mainKey = normalizeMainKey(cfg?.session?.mainKey);
  if (raw === "main" || raw === mainKey) {
    return resolveMainSessionKey(cfg);
  }
  const agentId = resolveAgentIdFromSessionKey(raw);
  return `agent:${agentId}:${raw}`;
}
