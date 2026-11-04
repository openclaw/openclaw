import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getEnvironmentData, setEnvironmentData } from "node:worker_threads";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getIMessageRuntime } from "../runtime.js";
import { installIMessageStateRuntimeForTest } from "../test-support/runtime.js";
import { advanceIMessageRecoveryCursor, loadIMessageRecoveryCursor } from "./recovery-cursor.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const DB = "local:/Users/bot/Library/Messages/chat.db";

describe.skipIf(!connection)("iMessage recovery cursor on PostgreSQL state", () => {
  const client = new pg.Client({ connectionString: connection });
  let stateDir: string;

  const previousConnection = getEnvironmentData("openclaw.test.state.connection");

  beforeAll(async () => {
    // Select the existing state engine before the runtime opens stores or starts workers.
    setEnvironmentData("openclaw.test.state.connection", connection);
    installIMessageStateRuntimeForTest();
    stateDir = getIMessageRuntime().state.resolveStateDir();
    await client.connect();
  });

  afterAll(async () => {
    try {
      await closeOpenClawStateDatabaseAsync();
      using anchor = new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"), {
        readOnly: true,
      });
      const row = anchor.prepare("SELECT schema FROM openclaw_engine_anchor").get() as
        | { schema: string }
        | undefined;
      if (row) {
        await client.query(`DROP SCHEMA IF EXISTS "${row.schema.replaceAll('"', '""')}" CASCADE`);
      }
    } finally {
      try {
        await client.end();
      } finally {
        setEnvironmentData("openclaw.test.state.connection", previousConnection);
      }
    }
  });

  it("loads, advances, and reloads the cursor at channel start (#184862)", async () => {
    await expect(loadIMessageRecoveryCursor("default", DB)).resolves.toBeNull();
    await advanceIMessageRecoveryCursor("default", DB, 4321);
    await expect(loadIMessageRecoveryCursor("default", DB)).resolves.toBe(4321);
    await expect(loadIMessageRecoveryCursor("default", `${DB}-other`)).resolves.toBeNull();
  });
});
