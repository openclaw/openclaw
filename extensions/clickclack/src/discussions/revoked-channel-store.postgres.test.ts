import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getEnvironmentData } from "node:worker_threads";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenAsyncKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import * as state from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  clearClickClackDiscussionChannelRevoked,
  isClickClackDiscussionChannelRevokedAsync,
  markClickClackDiscussionChannelIdentityRevoked,
} from "./revoked-channel-store.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const tempDirs = useAutoCleanupTempDirTracker(afterAll);

describe.skipIf(!connection)("ClickClack revoked channels on PostgreSQL state", () => {
  const client = new pg.Client({ connectionString: connection });
  const stateDir = tempDirs.make("clickclack-revoked-postgres-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const runtime = createPluginRuntimeMock({
    state: {
      openKeyedStoreV2: <T>(options: OpenAsyncKeyedStoreOptions) =>
        state.createPluginStateKeyedStoreForTests<T>("clickclack", { ...options, env })
          .withCurrent!({ assertCurrent: () => {} }),
    },
  });

  const withPostgres = <T>(run: () => Promise<T>) =>
    state.withDatabaseEngineSelection(
      {
        effectiveEngines: state.resolveDatabaseFamilyEngines({
          database: { engine: "sqlite", families: { state: { engine: "postgres" } } },
        }),
        postgres: { connection: connection!, schemaPrefix: "clickclack_conformance" },
      },
      run,
    );

  beforeAll(async () => {
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
      await client.end();
    }
  });

  it("records, reads, and clears a revoked discussion channel", async () => {
    const channel = { serverBaseUrl: "https://clickclack.example/", channelId: "chn_room" };
    await withPostgres(async () => {
      await markClickClackDiscussionChannelIdentityRevoked({
        runtime,
        accountId: "default",
        ...channel,
      });
      await expect(
        isClickClackDiscussionChannelRevokedAsync({ runtime, ...channel }),
      ).resolves.toBe(true);
      await clearClickClackDiscussionChannelRevoked({ runtime, ...channel });
      await expect(
        isClickClackDiscussionChannelRevokedAsync({ runtime, ...channel }),
      ).resolves.toBe(false);
    });
  });
});
