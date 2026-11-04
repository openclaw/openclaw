import "./service-http-mock.test-support.js";
import "./session-authority.test-support.js";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getEnvironmentData } from "node:worker_threads";
import type {
  OpenAsyncKeyedStoreOptions,
  OpenKeyedStoreOptions,
  PluginStateActionAuthority,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import * as state from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getClickClackDiscussionBindingStore } from "./binding-store.js";
import { captureDiscussionRegistration } from "./register.test-support.js";
import { resolveClickClackDiscussionRoute } from "./routing.js";
import { createHarness } from "./service-test-support.js";

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const tempDirs = useAutoCleanupTempDirTracker(afterAll);

describe.skipIf(!connection)("ClickClack public discussion flow on PostgreSQL state", () => {
  const client = new pg.Client({ connectionString: connection });
  const stateDir = tempDirs.make("clickclack-revoked-postgres-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const f = createHarness(
    { label: "PostgreSQL discussion" },
    {
      openSyncKeyedStore: <T>(options: OpenKeyedStoreOptions) =>
        state.createPluginStateSyncKeyedStoreForTests<T>("clickclack", { ...options, env }),
    },
  );
  f.runtime.state.openKeyedStoreV2 = <T>(
    options: OpenAsyncKeyedStoreOptions,
    authority?: PluginStateActionAuthority,
  ) =>
    state.createPluginStateKeyedStoreForTests<T>("clickclack", { ...options, env }).withCurrent!(
      authority ?? { assertCurrent() {} },
    );
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
      await f.service.cleanup();
      await closeOpenClawStateDatabaseAsync();
      using anchor = new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"), {
        readOnly: true,
      });
      const row = anchor.prepare("SELECT schema FROM openclaw_engine_anchor").get() as
        | { schema: string }
        | undefined;
      if (row) {
        await client.query(
          'DROP SCHEMA IF EXISTS "' + row.schema.replaceAll('"', '""') + '" CASCADE',
        );
      }
    } finally {
      await client.end();
    }
  });
  it("opens, routes, discloses history, retires the binding, and reopens", async () => {
    await withPostgres(async () => {
      const sessionKey = "agent:main:postgres-discussion";
      await expect(f.service.provider.open({ sessionKey, agentId: "main" })).resolves.toMatchObject(
        {
          state: "open",
        },
      );
      expect(f.createChannel).toHaveBeenCalledOnce();
      const store = getClickClackDiscussionBindingStore(f.runtime);
      const binding = await store.getAsync(sessionKey);
      expect(binding).toBeDefined();
      if (!binding) {
        throw new Error("Public open did not persist a binding");
      }
      const routeInput = { runtime: f.runtime, ...binding };
      const route = await resolveClickClackDiscussionRoute(routeInput);
      expect(route.state).toBe("active");
      if (route.state !== "active") {
        throw new Error("Public route was not active");
      }
      const registration = captureDiscussionRegistration(f.runtime);
      await expect(
        registration.run(
          { toolName: "sessions_history", params: { sessionKey } },
          { toolName: "sessions_history", sessionKey: route.route.sessionKey },
        ),
      ).resolves.toBeUndefined();
      await expect(f.service.readLatestMessages(sessionKey, 5)).resolves.toMatchObject({ binding });
      expect(f.messagePage).toHaveBeenCalledOnce();
      // Changing the selector retires the old local binding through the public info path.
      // ClickClack owns the remote room lifecycle; there is no separate public close method.
      f.config.channels!.clickclack!.discussions!.workspace = "wsp_team";
      await expect(f.service.provider.info({ sessionKey, agentId: "main" })).resolves.toEqual({
        state: "available",
      });
      expect(await store.getAsync(sessionKey)).toBeUndefined();
      await expect(resolveClickClackDiscussionRoute(routeInput)).resolves.toEqual({
        state: "revoked",
      });
      await expect(
        registration.run(
          { toolName: "sessions_history", params: { sessionKey } },
          { toolName: "sessions_history", sessionKey: route.route.sessionKey },
        ),
      ).resolves.toMatchObject({ block: true });
      await expect(f.service.provider.open({ sessionKey, agentId: "main" })).resolves.toMatchObject(
        {
          state: "open",
        },
      );
      expect(f.createChannel).toHaveBeenCalledTimes(2);
      await expect(resolveClickClackDiscussionRoute(routeInput)).resolves.toMatchObject({
        state: "active",
      });
    });
  });
});
