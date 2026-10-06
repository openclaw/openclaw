import { getAsyncWorkSignal } from "../../../shared/async-work-scope.js";
import {
  executeExistingOpenClawStateRead,
  withOpenClawStateDatabaseReadSnapshot,
} from "../../../state/openclaw-state-db-readonly.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import { immutableSubagentRun } from "./subagent-registry-memory.js";
import { rememberSubagentRunVersion } from "./subagent-registry.store.codec.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

/** Canonical restoration keeps one snapshot while bounding each worker-to-host transfer. */
export function readAllSubagentRunsInWorker(
  context: OpenClawStateWorkerContext,
): Promise<Map<string, SubagentRunRecord>> {
  const options = { path: context.admission.databasePath, env: context.environment };
  return withOpenClawStateDatabaseReadSnapshot(
    async () => {
      const runs = new Map<string, SubagentRunRecord>();
      const order: Array<readonly [string, number]> = [];
      let after: string | undefined;
      do {
        getAsyncWorkSignal()?.throwIfAborted();
        context.maintenanceScope?.assertAdmission();
        context.admission.assertCurrent();
        const reply = await executeExistingOpenClawStateRead(
          options,
          { type: "subagents.runs", scope: { kind: "page", after } },
          { context },
        );
        if (!reply) {
          return runs;
        }
        if (
          !reply.ok ||
          reply.type !== "subagents.runs" ||
          reply.projection ||
          !reply.page ||
          !reply.versions
        ) {
          throw new Error("Subagent restore omitted its registry page");
        }
        for (const [runId, version] of reply.versions) {
          const entry = reply.runs.get(runId);
          if (version !== null && !entry) {
            throw new Error("Canonical subagent restore found an unreadable durable row");
          }
          if (entry && version) {
            rememberSubagentRunVersion(entry, version);
            runs.set(runId, immutableSubagentRun(entry));
          }
        }
        order.push(...reply.page.order);
        after = reply.page.nextRunId ?? undefined;
      } while (after !== undefined);
      // Preserve SQLite's created_at/run_id order without repeatedly sorting the table.
      order.sort((a, b) => a[1] - b[1] || Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])));
      return new Map(
        order.flatMap(([runId]) => {
          const entry = runs.get(runId);
          return entry ? [[runId, entry] as const] : [];
        }),
      );
    },
    options,
    { fresh: true },
  );
}
