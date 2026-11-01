import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { threadId } from "node:worker_threads";
import pg from "pg";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  installDatabaseProcessRole,
  withEngineStoreAdmission as admit,
} from "../../infra/database-engine/admission-scope.js";
import { installDatabaseEngineSelection } from "../../infra/database-engine/context.js";
import { resolveDatabaseFamilyEngines } from "../../infra/database-engine/registry.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { createRetryController } from "../embedded-agent-runner/run/failover-retry-controller.test-support.js";
import { loadPersistedAuthProfileStore } from "./persisted.js";
import { saveAuthProfileStore } from "./store-runtime.js";
import type { AuthProfileStore } from "./types.js";

assert.equal(threadId, 0);
const connection = process.env.OPENCLAW_TEST_AUTH_INLINE_PG_CONNECTION;
const stateDir = process.env.OPENCLAW_STATE_DIR;
assert(connection);
assert(stateDir);
const engine = process.argv[2] ?? "postgres";
assert(engine === "postgres" || engine === "sqlite");
installDatabaseProcessRole("gateway");
installDatabaseEngineSelection({
  effectiveEngines: resolveDatabaseFamilyEngines({
    database: { engine: "sqlite", families: { agent: { engine } } },
  }),
  ...(engine === "postgres" ? { postgres: { connection, schemaPrefix: "auth_inline" } } : {}),
});
const provider = "fixture-provider";
const config = {
  agents: { ownership: "explicit" as const, entries: { main: {}, voice: {} } },
  models: {
    providers: {
      [provider]: {
        baseUrl: "https://example.invalid/v1",
        api: "openai-completions" as const,
        apiKey: "synthetic-inline-key",
        models: [],
      },
    },
  },
  plugins: { enabled: false },
};
setRuntimeConfigSnapshot(config);
const agentDir = path.join(stateDir, "agents", "voice", "agent");
const agentPath = resolveOpenClawAgentSqlitePath({ agentId: "voice" });
try {
  admit(() => {
    openOpenClawStateDatabase();
    saveAuthProfileStore({ version: 1, profiles: {} }, undefined, {
      filterExternalAuthProfiles: false,
      syncExternalCli: false,
    });
    saveAuthProfileStore({ version: 1, profiles: {} }, agentDir, {
      filterExternalAuthProfiles: false,
      syncExternalCli: false,
    });
  });
  const database = admit(() => openOpenClawAgentDatabase({ agentId: "voice" }));
  const assertGuard = () => {
    if (engine === "postgres") {
      assert.throws(
        () => database.db.prepare("SELECT 1").get(),
        /PostgreSQL connections must run in a worker/,
      );
    }
  };
  assertGuard();
  const store: AuthProfileStore = { version: 1, profiles: {} };
  const controller = createRetryController({
    agentDir,
    runParams: { workspaceDir: path.join(stateDir, "workspace"), config },
    runtime: {
      provider,
      modelId: "synthetic-model",
      profileFailureStore: store,
      snapshot: () => ({ pluginHarnessOwnsTransport: false, agentHarness: { id: "embedded" } }),
      getApiKeyInfo: () => ({
        apiKey: "synthetic-inline-key",
        mode: "api-key",
        source: "models.json",
      }),
    },
  });
  await controller.maybeMarkAuthProfileFailure({ reason: "auth" });
  assert.equal(store.usageStats?.["inline-api-key:fixture-provider"]?.errorCount, 1);
  assert.equal(
    admit(() => loadPersistedAuthProfileStore(agentDir))?.usageStats?.[
      "inline-api-key:fixture-provider"
    ]?.errorCount,
    1,
  );
  assertGuard();
  console.log("Inline auth failure persisted on Gateway thread: " + engine);
} finally {
  await cleanupSessionStateForTest({ stateDir });
  if (engine === "postgres" && existsSync(agentPath)) {
    using anchor = openNodeSqliteDatabase(agentPath, { readOnly: true });
    const row = anchor.prepare("SELECT schema FROM openclaw_engine_anchor").get();
    const client = new pg.Client({ connectionString: connection });
    await client.connect();
    try {
      if (typeof row?.schema === "string") {
        await client.query(
          "DROP SCHEMA IF EXISTS " + client.escapeIdentifier(row.schema) + " CASCADE",
        );
      }
    } finally {
      await client.end();
    }
  }
}
