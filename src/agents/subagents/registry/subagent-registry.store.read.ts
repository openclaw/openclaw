import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { getAsyncWorkSignal } from "../../../shared/async-work-scope.js";
import { executeExistingOpenClawStateRead } from "../../../state/openclaw-state-db-readonly.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import { immutableSubagentRun } from "./subagent-registry-memory.js";
import {
  isCanonicalSubagentRunRecord,
  rememberSubagentRunVersion,
} from "./subagent-registry.store.codec.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

/** Restore publishes only after the streamed snapshot and its reader have settled. */
export async function readAllSubagentRunsInWorker(
  context: OpenClawStateWorkerContext,
): Promise<Map<string, SubagentRunRecord>> {
  const runs = new Map<string, SubagentRunRecord>();
  const order: Array<readonly [string, number]> = [];
  const reply = await executeExistingOpenClawStateRead(
    { path: context.admission.databasePath, env: context.environment },
    { type: "subagents.restore" },
    {
      context,
      current: true,
      signal: getAsyncWorkSignal(),
      onChunk(value) {
        if (!Array.isArray(value)) {
          throw new Error("Subagent restore omitted its registry batch");
        }
        for (const item of value) {
          if (
            !isRecord(item) ||
            !isCanonicalSubagentRunRecord(item.entry) ||
            typeof item.version !== "string" ||
            typeof item.createdAt !== "number"
          ) {
            throw new Error("Subagent restore returned an invalid registry row");
          }
          const entry = item.entry;
          rememberSubagentRunVersion(entry, item.version);
          runs.set(entry.runId, immutableSubagentRun(entry));
          order.push([entry.runId, item.createdAt]);
        }
      },
    },
  );
  if (reply && (!reply.ok || reply.type !== "subagents.restore" || reply.count !== runs.size)) {
    throw new Error("Subagent restore did not settle its complete registry snapshot");
  }
  // Preserve SQLite's created_at/run_id order without sorting retained bodies in SQLite.
  order.sort((a, b) => a[1] - b[1] || Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])));
  const restored = new Map(order.map(([runId]) => [runId, runs.get(runId)!]));
  // Publication rechecks its revision after this preparation and installs rows atomically.
  await yieldToEventLoop();
  return restored;
}
