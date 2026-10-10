import { normalizeAgentId } from "../routing/session-key.js";

export class AgentSharedStoreOwnerError extends Error {}

export function assertAgentSessionStoreDeletionBlocker(
  agentId: string,
  blocker: string | undefined,
): void {
  if (blocker !== undefined) {
    throw new AgentSharedStoreOwnerError(
      `Agent "${normalizeAgentId(agentId)}" owns the session database still used by agent "${blocker}" and cannot be deleted. Keep this owner configured until shared history can be moved with a supported migration; no such migration is currently available.`,
    );
  }
}
