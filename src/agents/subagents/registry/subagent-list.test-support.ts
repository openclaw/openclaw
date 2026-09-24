import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  buildSubagentList,
  captureSubagentListReadContext,
  readSubagentListSessionEntries,
} from "./subagent-list.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { buildSubagentRunReadIndexFromRuns } from "./subagent-registry-queries.js";
import type { SubagentRunReadRecord } from "./subagent-registry-read.types.js";
import { withSubagentRunReadSnapshot } from "./subagent-registry-state.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export async function buildSubagentListForTests(params: {
  cfg: OpenClawConfig;
  runs: SubagentRunRecord[];
  recentMinutes: number;
  taskMaxChars?: number;
  readSnapshot?: Map<string, SubagentRunReadRecord>;
}) {
  const readSnapshot =
    params.readSnapshot ??
    (await withSubagentRunReadSnapshot(
      subagentRuns,
      (snapshot) => ({ snapshot, runIds: [], sessionKeys: [] }),
      ({ snapshot }) => snapshot,
    ));
  const context = captureSubagentListReadContext(
    params.runs,
    buildSubagentRunReadIndexFromRuns({ runs: readSnapshot, inMemoryRuns: subagentRuns.values() }),
    subagentRuns,
    params.recentMinutes,
  );
  return buildSubagentList({
    context,
    sessionEntries: readSubagentListSessionEntries(params.cfg, context),
    taskMaxChars: params.taskMaxChars,
  });
}
