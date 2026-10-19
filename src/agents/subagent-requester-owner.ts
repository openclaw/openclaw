import { tryResolveLegacyCompatibilityAgentId } from "../config/legacy.default-agent-owner.js";
import { resolvePersistedSessionStoreOwnerForKey } from "../config/sessions/session-store-owner.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseAgentSessionKey } from "../routing/session-key.js";

/** Resolves the durable requester owner for legacy rows that predate requesterAgentId. */
export function resolveSubagentRequesterAgentId(
  cfg: OpenClawConfig,
  entry: { requesterSessionKey: string; requesterAgentId?: string },
): string | undefined {
  if (entry.requesterAgentId) {
    return entry.requesterAgentId;
  }
  const parsedAgentId = parseAgentSessionKey(entry.requesterSessionKey)?.agentId;
  if (parsedAgentId) {
    return parsedAgentId;
  }
  const persisted = resolvePersistedSessionStoreOwnerForKey(cfg, entry.requesterSessionKey);
  return persisted.kind === "configured"
    ? persisted.agentId
    : persisted.kind === "none"
      ? tryResolveLegacyCompatibilityAgentId(cfg)
      : undefined;
}
