import path from "node:path";
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
      "all",
    ));
  const context = captureSubagentListReadContext(
    params.runs,
    buildSubagentRunReadIndexFromRuns({ runs: readSnapshot, inMemoryRuns: subagentRuns.values() }),
    subagentRuns,
    params.recentMinutes,
  );
  return buildSubagentList({
    context,
    sessionEntries: await readSubagentListSessionEntries(params.cfg, context),
    taskMaxChars: params.taskMaxChars,
  });
}

/**
 * The directory exactly as the shared-cwd advisory reports it. The advisory keeps the last 72
 * characters behind a `...` marker, which a long temp root (nested runner directories) reaches.
 */
export function expectedSharedCwdPath(dir: string) {
  const resolved = path.resolve(dir);
  return resolved.length <= 72 ? resolved : `...${resolved.slice(-69)}`;
}
