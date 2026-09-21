import { randomUUID } from "node:crypto";
import { createSqliteWorkerOperationAdmission } from "../../../infra/sqlite-worker-operation-admission.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import { runOpenClawStateWorkerOperation } from "../../../state/openclaw-state-worker-store.js";
import { normalizeSubagentRunState } from "./subagent-delivery-state.js";
import { bindSubagentRunRecord } from "./subagent-registry.store.codec.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type PendingRegistryWrite = { runIds: Set<string>; superseded: Set<string> };
const pendingWrites = new Set<PendingRegistryWrite>();

/** Synchronous writers invalidate pending row authority before waiting for their write lock. */
export function supersedePendingSubagentRegistryWrites(runIds?: readonly string[]): void {
  for (const pending of pendingWrites) {
    for (const runId of runIds ?? pending.runIds) {
      if (pending.runIds.has(runId)) {
        pending.superseded.add(runId);
      }
    }
  }
}

export class SubagentRegistryWriteError extends Error {
  constructor(
    readonly outcome: "not-committed" | "committed" | "unknown",
    cause: unknown,
  ) {
    super("Queued subagent registry persistence failed", { cause });
    this.name = "SubagentRegistryWriteError";
  }
}

export type SubagentRegistryWriteOptions = {
  context: OpenClawStateWorkerContext;
  assertCurrent?: () => void;
  onCommitted?: () => void;
};

/** Retains captured rows, original database admission, and publication through actor settlement. */
export async function persistSubagentRegistryChangesAsync(
  runs: Map<string, SubagentRunRecord>,
  changedRunIds: readonly string[],
  options: SubagentRegistryWriteOptions,
  publish: (snapshot: Map<string, SubagentRunRecord>, runIds: readonly string[]) => void,
): Promise<void> {
  const runIds = [...new Set(changedRunIds.map((id) => id.trim()).filter(Boolean))];
  const pending: PendingRegistryWrite = { runIds: new Set(runIds), superseded: new Set() };
  let commitGranted = false;
  let acknowledged = false;
  pendingWrites.add(pending);
  try {
    const snapshot = new Map<string, SubagentRunRecord>();
    for (const runId of runIds) {
      const entry = runs.get(runId);
      if (entry) {
        snapshot.set(runId, normalizeSubagentRunState(structuredClone(entry)));
      }
    }
    const write = {
      writeId: randomUUID(),
      values: [...snapshot.values()].map(bindSubagentRunRecord),
      deleteRunIds: runIds.filter((runId) => !snapshot.has(runId)),
    };
    const { context } = options;
    const assertDatabase = () => {
      context.admission.assertCurrent();
      if (
        captureOpenClawStateWorkerContext().admission.identity.key !==
        context.admission.identity.key
      ) {
        throw new Error("Queued registry write lost its original database");
      }
    };
    const assertCurrent = () => {
      assertDatabase();
      options.assertCurrent?.();
      if (pending.superseded.size > 0) {
        throw new Error("Queued registry write was superseded");
      }
    };
    await runOpenClawStateWorkerOperation(
      context,
      async (scope) => {
        const receipt = await scope.execute({ type: "subagents.persistChanges", input: write });
        if (receipt.writeId !== write.writeId) {
          throw new Error("Queued registry acknowledgement identifies another write");
        }
        acknowledged = true;
        assertDatabase();
        const currentIds = runIds.filter((runId) => !pending.superseded.has(runId));
        if (currentIds.length > 0) {
          publish(snapshot, currentIds);
        }
      },
      {
        assertCurrent,
        createAdmission: () => {
          let phase: "waiting" | "transaction" | "commit" = "waiting";
          return {
            nativeLocations: [
              context.admission.databasePath,
              context.admission.identity.canonicalPath,
            ],
            admission: createSqliteWorkerOperationAdmission((request, grant) => {
              if (
                request.facts !== write.writeId ||
                !(
                  (phase === "waiting" && request.stage === "transaction") ||
                  (phase === "transaction" && request.stage === "commit")
                )
              ) {
                throw new Error("Queued registry write authority requested out of order");
              }
              assertCurrent();
              if (!grant()) {
                throw new Error("Queued registry write authority expired");
              }
              phase = request.stage === "transaction" ? "transaction" : "commit";
              commitGranted = phase === "commit";
            }),
          };
        },
      },
    );
  } catch (error) {
    throw new SubagentRegistryWriteError(
      acknowledged ? "committed" : commitGranted ? "unknown" : "not-committed",
      error,
    );
  } finally {
    pendingWrites.delete(pending);
  }
}
