import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveSessionAgentId } from "../../agent-scope.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

/** Raw child keys need the agent captured when their run was registered. */
export function resolveSubagentChildSessionOwner(
  entry: Pick<SubagentRunRecord, "childSessionKey" | "childAgentId">,
  cfg: OpenClawConfig,
): { agentId: string; storePath: string } {
  const agentId =
    entry.childAgentId ?? resolveSessionAgentId({ config: cfg, sessionKey: entry.childSessionKey });
  return { agentId, storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId }) };
}
