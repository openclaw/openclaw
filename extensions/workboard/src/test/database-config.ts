import { getEnvironmentData } from "node:worker_threads";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { WorkboardDatabaseInput } from "../database-config.js";
import { createWorkboardSqliteKernel as createKernel } from "../sqlite-store-kernel.js";
import { createWorkboardSqliteStores as createStores } from "../sqlite-store.js";

// The conformance runner supplies config through worker environment data, never a DSN env var.
export function workboardTestConfig(): OpenClawConfig {
  const connection = getEnvironmentData("openclaw.test.workboard.connection");
  if (connection === undefined) {
    return {};
  }
  if (typeof connection !== "string") {
    throw new TypeError("Conformance PostgreSQL connection must be a string");
  }
  return { database: { engine: "postgres", postgres: { connection } } };
}

export function workboardTestDatabaseInput(): WorkboardDatabaseInput {
  const config = workboardTestConfig();
  const connection = config.database?.postgres?.connection;
  if (config.database?.engine !== "postgres") {
    return undefined;
  }
  if (typeof connection !== "string") {
    throw new Error("Conformance kernel fixtures require a literal test connection");
  }
  return { connection, schemaPrefix: config.database.postgres?.schemaPrefix ?? "openclaw" };
}

export function createWorkboardSqliteStores(options: Parameters<typeof createStores>[0]) {
  return createStores({ config: workboardTestConfig(), ...options });
}

export function createWorkboardSqliteKernel(dbPath: string) {
  return createKernel(dbPath, undefined, workboardTestDatabaseInput());
}
