import path from "node:path";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import { openSqliteWorkerStore } from "openclaw/plugin-sdk/sqlite-runtime";
import type { QaSuiteRuntimeEnv } from "./suite-runtime-types.js";

export type QaExecutionIdentityStorageOperations = {
  counts: {
    input: { actionFamily: string; reasonCode: string; runId: string } | undefined;
    output: { contextCount: number; decisionCount: number };
  };
};

/** Return only bounded row counts for deterministic no-synthetic-run proof. */
export async function inspectQaExecutionIdentityStorage(
  env: Pick<QaSuiteRuntimeEnv, "gateway">,
  decisionFilter?: QaExecutionIdentityStorageOperations["counts"]["input"],
): Promise<QaExecutionIdentityStorageOperations["counts"]["output"]> {
  const stateDir = env.gateway.runtimeEnv.OPENCLAW_STATE_DIR?.trim();
  if (!stateDir) {
    throw new Error("QA Gateway did not expose its isolated state directory");
  }
  const store = await openSqliteWorkerStore<QaExecutionIdentityStorageOperations>({
    moduleUrl: resolveRuntimeWorkerUrl({
      currentModuleUrl: import.meta.url,
      sourceWorkerName: "execution-identity-storage-inspection.worker",
      distWorkerPath: "extensions/qa-lab/src/execution-identity-storage-inspection.worker.js",
      package: {
        name: "@openclaw/qa-lab",
        distWorkerPath: "src/execution-identity-storage-inspection.worker.js",
      },
    }),
    databasePath: path.join(stateDir, "state", "openclaw.sqlite"),
    input: undefined,
  });
  try {
    return await store.execute({ type: "counts", input: decisionFilter });
  } finally {
    await store.close();
  }
}
