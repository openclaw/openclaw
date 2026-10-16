import { getRuntimeConfig } from "../../../config/config.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import { resolveSubagentRequesterAgentId } from "../../subagent-requester-owner.js";
import { resolveSubagentChildAuthority } from "./subagent-child-owner-match.js";
import { updateSubagentArchiveAtMs } from "./subagent-registry-helpers.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export async function restoreSubagentRunMetadata(
  runs: Map<string, SubagentRunRecord>,
  context: OpenClawStateWorkerContext,
  assertCurrent: () => void,
) {
  const cfg = getRuntimeConfig();
  const plan = (rows: ReadonlyMap<string, SubagentRunRecord>) => {
    const postimages = new Map<string, SubagentRunRecord>();
    for (const [runId, entry] of rows) {
      const authority = resolveSubagentChildAuthority(entry);
      if (authority.status === "mismatch") {
        continue;
      }
      const draft = { ...entry };
      const requesterAgentId = resolveSubagentRequesterAgentId(cfg, draft);
      const ownerChanged =
        authority.status === "verified" &&
        !draft.requesterAgentId &&
        requesterAgentId !== undefined;
      if (ownerChanged) {
        draft.requesterAgentId = requesterAgentId;
      }
      if (updateSubagentArchiveAtMs(draft, cfg) || ownerChanged) {
        postimages.set(runId, draft);
      }
    }
    return { value: undefined, postimages };
  };
  // Retained rows keep text in SQLite; only changed metadata needs a full write payload.
  const runIds = [...plan(runs).postimages.keys()];
  if (runIds.length > 0) {
    await mutateSubagentRuns(runIds, plan, { runs, context, assertCurrent });
  }
}
