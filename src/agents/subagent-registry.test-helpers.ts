import { resetAnnounceQueuesForTests } from "./subagent-announce-queue.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { listRunsForRequesterFromRuns } from "./subagent-registry-queries.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export function resetSubagentRegistryForTests() {
  subagentRuns.clear();
  resetAnnounceQueuesForTests();
}

export function addSubagentRunForTests(entry: SubagentRunRecord) {
  subagentRuns.set(entry.runId, entry);
}

export function listSubagentRunsForRequester(
  requesterSessionKey: string,
  options?: { requesterRunId?: string },
) {
  return listRunsForRequesterFromRuns(subagentRuns, requesterSessionKey, options);
}
