import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import { startAdmittedTestWorker } from "../../../../test/helpers/admitted-worker.js";
import { unwrapWorkboardSqliteResult } from "../sqlite-store-errors.js";
import { createWorkboardDatabase } from "../sqlite-store-schema.js";
import type {
  PostgresFixtureInput,
  PostgresFixtureReply,
  PostgresFixtureRequest,
  PostgresStatement,
} from "./postgres-fixture-contract.js";

export function openPostgresFixture(input: PostgresFixtureInput) {
  const url = resolveRuntimeWorkerUrl({
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "postgres-fixture-worker.test-support",
    distWorkerPath: "extensions/workboard/src/test/postgres-fixture-worker.test-support.js",
  });
  const worker = startAdmittedTestWorker(url, input.dbPath, input);
  let nextId = 0;
  let closed = false;
  let workerFailure: Error | undefined;
  const pending = new Map<number, ReturnType<typeof Promise.withResolvers<PostgresFixtureReply>>>();
  worker.on("message", (reply: PostgresFixtureReply) => {
    pending.get(reply.id)?.resolve(reply);
    pending.delete(reply.id);
  });
  worker.on("error", (error) => {
    workerFailure = error;
    for (const entry of pending.values()) {
      entry.reject(error);
    }
    pending.clear();
  });
  const exited = new Promise<void>((resolve, reject) => {
    worker.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        const error = new Error(`PostgreSQL fixture worker exited ${code}`);
        workerFailure = error;
        for (const entry of pending.values()) {
          entry.reject(error);
        }
        pending.clear();
        reject(error);
      }
    });
  });
  void exited.catch(() => {});
  async function request(operation: PostgresFixtureRequest["operation"]) {
    if (workerFailure) {
      throw workerFailure;
    }
    const id = ++nextId;
    const completion = Promise.withResolvers<PostgresFixtureReply>();
    pending.set(id, completion);
    worker.postMessage({ id, operation } satisfies PostgresFixtureRequest, []);
    return await completion.promise;
  }
  async function execute(operation: PostgresFixtureRequest["operation"]) {
    return unwrapWorkboardSqliteResult((await request(operation)).result);
  }
  return {
    request,
    execute,
    async statements(statements: PostgresStatement[], transaction = false, reject?: string) {
      const values = await execute({ kind: "statements", statements, transaction, reject });
      if (!Array.isArray(values)) {
        throw new Error("PostgreSQL fixture returned invalid statement results");
      }
      return values;
    },
    async state() {
      const value = await execute({ kind: "state" });
      if (
        value === null ||
        typeof value !== "object" ||
        !("schema" in value) ||
        typeof value.schema !== "string" ||
        !("isOpen" in value) ||
        typeof value.isOpen !== "boolean" ||
        !("isTransaction" in value) ||
        typeof value.isTransaction !== "boolean"
      ) {
        throw new Error("PostgreSQL fixture returned invalid connection state");
      }
      return { schema: value.schema, isOpen: value.isOpen, isTransaction: value.isTransaction };
    },
    async close() {
      if (closed) {
        return;
      }
      await execute({ kind: "close" });
      await exited;
      closed = true;
    },
  };
}

export async function runPostgresGroupedRollback(
  input: PostgresFixtureInput,
  operation: Extract<PostgresFixtureRequest["operation"], { kind: "groupedRollback" }>,
) {
  const owner = createWorkboardDatabase(input.dbPath, undefined, input.postgresInput);
  const fixture = openPostgresFixture(input);
  try {
    return await fixture.execute(operation);
  } finally {
    try {
      await fixture.close();
    } finally {
      owner.close();
    }
  }
}
