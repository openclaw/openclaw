import { getEnvironmentData } from "node:worker_threads";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { DatabaseEngineInput } from "openclaw/plugin-sdk/database-engine-runtime";
import { vi } from "vitest";
import { createWorkboardSqliteKernel as createKernel } from "../sqlite-store-kernel.js";
import { createWorkboardSqliteStores as createStores } from "../sqlite-store.js";

// mock-isolation: Persistence tests receive a host-selected engine; core conformance proves boot resolution.
vi.mock("openclaw/plugin-sdk/database-engine-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/database-engine-runtime")>();
  const { getEnvironmentData: readEnvironmentData } = await import("node:worker_threads");
  const connection = readEnvironmentData("openclaw.test.workboard.connection");
  if (connection !== undefined && typeof connection !== "string") {
    throw new TypeError("Conformance PostgreSQL connection must be a string");
  }
  const input = connection === undefined ? undefined : { connection, schemaPrefix: "openclaw" };
  return {
    ...actual,
    getDatabaseEngineInput: (family: Parameters<typeof actual.getDatabaseEngineInput>[0]) =>
      family === "workboard" ? input : actual.getDatabaseEngineInput(family),
  };
});

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

export function workboardTestDatabaseInput(): DatabaseEngineInput {
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
  return createStores(options);
}

export function createWorkboardSqliteKernel(dbPath: string) {
  return createKernel(dbPath, undefined, workboardTestDatabaseInput());
}
