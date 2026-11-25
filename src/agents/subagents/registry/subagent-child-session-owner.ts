import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveSubagentChildAgentId } from "./subagent-child-owner-match.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

/** Raw child keys need the agent captured when their run was registered. */
export function resolveSubagentChildSessionOwner(
  entry: Pick<SubagentRunRecord, "childSessionKey" | "childAgentId">,
  cfg: OpenClawConfig,
): { agentId: string; storePath: string } {
  const agentId = resolveSubagentChildAgentId(entry);
  if (!agentId) {
    throw new Error("Subagent owning agent is unresolved; inspect the retained execution record.");
  }
  return { agentId, storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId }) };
}
