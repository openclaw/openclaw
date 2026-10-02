import path from "node:path";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import { openSqliteWorkerStore } from "openclaw/plugin-sdk/sqlite-runtime";
import type { QaSuiteRuntimeEnv } from "./suite-runtime-types.js";

export type QaExecutionIdentityStorageOperations = {
  subagentRuns: {
    input: { requesterSessionKey?: string };
    output: QaNativeSubagentRun[];
  };
  counts: {
    input: { actionFamily: string; reasonCode: string; runId: string } | undefined;
    output: { contextCount: number; decisionCount: number };
  };
};

/** Native persistence facts only; channel/history RPCs still prove public delivery and access. */
export type QaNativeSubagentRun = {
  runId: string;
  childSessionKey: string;
  requesterSessionKey: string;
  createdAt: number;
  label?: string;
  execution: { status: string; endedAt?: number; outcome?: { status: string } };
  delivery?: { status: string; disposition?: string };
};

/** Return only bounded row counts for deterministic no-synthetic-run proof. */
export async function inspectQaExecutionIdentityStorage(
  env: Pick<QaSuiteRuntimeEnv, "gateway">,
  decisionFilter?: QaExecutionIdentityStorageOperations["counts"]["input"],
): Promise<QaExecutionIdentityStorageOperations["counts"]["output"]> {
  const store = await openQaInspectionStore(env);
  try {
    return await store.execute({ type: "counts", input: decisionFilter });
  } finally {
    await store.close();
  }
}

export async function readNativeQaSubagentRuns(
  env: Pick<QaSuiteRuntimeEnv, "gateway">,
  requesterSessionKey?: string,
): Promise<QaNativeSubagentRun[]> {
  const store = await openQaInspectionStore(env);
  try {
    return await store.execute({ type: "subagentRuns", input: { requesterSessionKey } });
  } finally {
    await store.close();
  }
}

async function openQaInspectionStore(env: Pick<QaSuiteRuntimeEnv, "gateway">) {
  const stateDir = env.gateway.runtimeEnv.OPENCLAW_STATE_DIR?.trim();
  if (!stateDir) {
    throw new Error("QA Gateway did not expose its isolated state directory");
  }
  return await openSqliteWorkerStore<QaExecutionIdentityStorageOperations>({
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
}
