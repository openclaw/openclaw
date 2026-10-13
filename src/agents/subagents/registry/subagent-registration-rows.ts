import { executeExistingOpenClawStateRead } from "../../../state/openclaw-state-db-readonly.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import {
  assertSubagentRegistryWriteSourceCurrent,
  readVersionedSubagentRows,
} from "./subagent-registry-persistence.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export async function prepareSubagentRegistrationRows(
  childSessionKey: string,
  selectedRunIds: readonly string[],
  context: OpenClawStateWorkerContext,
): Promise<Map<string, SubagentRunRecord>> {
  const reply = await executeExistingOpenClawStateRead(
    { path: context.admission.databasePath, env: context.environment },
    { type: "subagents.forChildSession", childSessionKey },
    { context, current: true },
  );
  assertSubagentRegistryWriteSourceCurrent(context);
  if (!reply) {
    return new Map();
  }
  if (!reply.ok || reply.type !== "subagents.forChildSession") {
    throw new Error(
      "Subagent registration could not read retained child runs; retry after restoring registry access.",
    );
  }
  const runIds = [...new Set([...selectedRunIds, ...reply.runs.map((row) => row.runId)])];
  return (await readVersionedSubagentRows(runIds, context)).runs;
}
