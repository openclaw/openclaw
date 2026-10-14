import { getRuntimeConfig } from "../../../config/config.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import { resolveSubagentRequesterAgentId } from "../../subagent-requester-owner.js";
import { resolveSubagentChildAuthority } from "./subagent-child-owner-match.js";
import { updateSubagentArchiveAtMs } from "./subagent-registry-helpers.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export function restoreSubagentRunMetadata(
  runs: Map<string, SubagentRunRecord>,
  context: OpenClawStateWorkerContext,
  assertCurrent: () => void,
) {
  const cfg = getRuntimeConfig();
  return mutateSubagentRuns(
    [...runs.keys()],
    (rows) => {
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
    },
    { runs, context, assertCurrent },
  );
}
