import { openEngineWorkerStore } from "openclaw/plugin-sdk/database-engine-runtime";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import { unwrapWorkboardSqliteResult } from "../sqlite-store-errors.js";
import { createWorkboardDatabase } from "../sqlite-store-schema.js";
import type {
  PostgresFixtureInput,
  PostgresFixtureOperations,
  PostgresFixtureRequest,
  PostgresStatement,
} from "./postgres-fixture-contract.js";

export function openPostgresFixture(input: PostgresFixtureInput) {
  const url = resolveRuntimeWorkerUrl({
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "postgres-fixture-worker.test-support",
    distWorkerPath: "extensions/workboard/src/test/postgres-fixture-worker.test-support.js",
  });
  const opened = openEngineWorkerStore<PostgresFixtureOperations>(
    { moduleUrl: url, databasePath: input.dbPath, input },
    input.postgresInput,
  );
  void opened.catch(() => {});
  let closing: Promise<void> | undefined;
  async function request(operation: PostgresFixtureRequest["operation"]) {
    const store = await opened;
    return await store.execute({ type: "fixture", input: operation });
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
    close() {
      closing ??= opened.then((store) => store.close());
      return closing;
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
