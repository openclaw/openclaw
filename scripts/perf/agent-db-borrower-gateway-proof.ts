// Synthetic borrower custody through a real dev Gateway, its WebSocket API, and maintenance owner.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { getFreePort } from "../lib/gateway-bench-probes.ts";
import { BASE_GATEWAY_BENCH_CONFIG, createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";

const { values } = parseArgs({ options: { "state-dir": { type: "string" } } });
assert(values["state-dir"], "--state-dir must name a new synthetic directory");
const directory = path.resolve(values["state-dir"]);
mkdirSync(directory);
for (const name of ["home", "workspace", "tmp"]) {
  mkdirSync(path.join(directory, name));
}
const configPath = path.join(directory, "openclaw.json");
const port = await getFreePort();
const token = "synthetic-borrower-proof-token";
writeFileSync(
  configPath,
  JSON.stringify({
    ...BASE_GATEWAY_BENCH_CONFIG,
    logging: { file: path.join(directory, "gateway.log") },
    plugins: { enabled: false },
    gateway: {
      ...BASE_GATEWAY_BENCH_CONFIG.gateway,
      auth: { mode: "token", token },
      controlUi: { enabled: false, allowedOrigins: [`http://127.0.0.1:${port}`] },
    },
    agents: {
      defaults: { model: { primary: "synthetic/model" } },
      entries: { main: { workspace: path.join(directory, "workspace") } },
    },
    cron: { enabled: false },
  }),
);
process.env = createGatewayBenchEnv(path.join(directory, "home"), configPath, {
  startupTrace: false,
  caseEnv: {
    OPENCLAW_STATE_DIR: directory,
    OPENCLAW_SKIP_CHANNELS: "1",
    TMPDIR: path.join(directory, "tmp"),
  },
});
const { openNodeSqliteDatabase } = await import("../../src/infra/node-sqlite.js");
const legacyPath = path.join(directory, "legacy.sqlite");
{
  using legacy = openNodeSqliteDatabase(legacyPath);
  legacy.exec(
    readFileSync(
      new URL("../../test/fixtures/sqlite/openclaw-agent-v2026.9.9.sql", import.meta.url),
      "utf8",
    ).replaceAll("keeper", "legacy"),
  );
}
const { startGatewayServer } = await import("../../src/gateway/server.js");
const { GatewayClient } = await import("../../src/gateway/client.js");
const { withOpenClawAgentDatabaseRuntime, OPENCLAW_AGENT_SCHEMA_VERSION } =
  await import("../../src/state/openclaw-agent-db.js");
const { retainOpenClawAgentDatabaseReadOnly } =
  await import("../../src/state/openclaw-agent-db-readonly.js");
const { withAgentDatabaseMaintenanceLease } =
  await import("../../src/state/openclaw-agent-db-maintenance-lease.js");
const { migrateOpenClawAgentDatabaseForMaintenance } =
  await import("../../src/state/openclaw-agent-db-maintenance.js");
const { resolveOpenClawAgentSqlitePath } =
  await import("../../src/state/openclaw-agent-db.paths.js");
const server = await startGatewayServer(port, { bind: "loopback", controlUiEnabled: false });
const peers: InstanceType<typeof GatewayClient>[] = [];
async function connect(index: number) {
  const ready = Promise.withResolvers<void>();
  const peer = new GatewayClient({
    url: `ws://127.0.0.1:${port}`,
    token,
    origin: `http://127.0.0.1:${port}`,
    clientName: "openclaw-control-ui",
    mode: "webchat",
    platform: "web",
    instanceId: `synthetic-borrower-proof-${index}`,
    scopes: ["operator.admin"],
    requestTimeoutMs: 60_000,
    onHelloOk: () => ready.resolve(),
    onConnectError: (error) => ready.reject(error),
  });
  peers.push(peer);
  peer.start();
  await ready.promise;
  return peer;
}
const key = "agent:main:borrower-proof";
const results: Array<{ phase: string; method: string; ok: boolean; error?: string }> = [];
try {
  const writer = await connect(0);
  const readers = await Promise.all([1, 2, 3].map(connect));
  await writer.request("sessions.create", { key, agentId: "main" });
  await writer.request("chat.inject", { sessionKey: key, message: "Synthetic borrower seed" });
  const databaseOptions = { agentId: "main", env: process.env };
  const databasePath = resolveOpenClawAgentSqlitePath(databaseOptions);
  // Runtime writers live in workers; admit this process-local borrower fixture through the same owner.
  const cached = await withOpenClawAgentDatabaseRuntime(databaseOptions, (database) => database);
  const retained = retainOpenClawAgentDatabaseReadOnly(databaseOptions);
  assert(retained.found);
  assert.equal(retained.database.db, cached.db);
  assert(retained.claim.isCurrent());
  async function burst(phase: string, allowMaintenanceRefusal = false) {
    const attempts = [
      ...readers.map((reader) => ({
        peer: reader,
        method: "chat.history",
        params: { sessionKey: key, limit: 30 },
      })),
      ...readers.map((reader) => ({
        peer: reader,
        method: "sessions.list",
        params: { agentId: "main", limit: 10 },
      })),
      {
        peer: writer,
        method: "chat.inject",
        params: { sessionKey: key, message: `Synthetic borrower ${phase}` },
      },
    ];
    await Promise.all(
      attempts.map(async ({ peer, method, params }) => {
        try {
          await peer.request(method, params);
          results.push({ phase, method, ok: true });
        } catch (error) {
          const message = String(error);
          results.push({ phase, method, ok: false, error: message });
          assert(
            allowMaintenanceRefusal &&
              /maintenance|revok|clos(?:ed|ing)|retir|not current|admission|unavailable|interrupted/i.test(
                message,
              ),
            message,
          );
        }
      }),
    );
  }
  try {
    await burst("before-maintenance");
    const concurrent = await Promise.allSettled([
      burst("during-maintenance", true),
      withAgentDatabaseMaintenanceLease({ env: process.env }, async (maintenance) => {
        assert.equal(cached.db.isOpen, false, "maintenance must close cached handles first");
        assert.equal(
          retained.claim.isCurrent(),
          false,
          "explicit close must revoke an outstanding borrower",
        );
        assert.throws(retained.claim.assertCurrent, /no longer current/);
        await migrateOpenClawAgentDatabaseForMaintenance(
          { agentId: "main", pathname: databasePath, env: process.env },
          maintenance,
        );
        await migrateOpenClawAgentDatabaseForMaintenance(
          { agentId: "legacy", pathname: legacyPath, env: process.env },
          maintenance,
        );
        maintenance.assertOwned();
      }),
    ]);
    for (const outcome of concurrent) {
      if (outcome.status === "rejected") {
        throw outcome.reason;
      }
    }
    await burst("after-maintenance");
    const history = await writer.request<{ messages: unknown[] }>("chat.history", {
      sessionKey: key,
      limit: 30,
    });
    const encoded = JSON.stringify(history.messages);
    assert(encoded.includes("Synthetic borrower seed"));
    assert(encoded.includes("Synthetic borrower before-maintenance"));
    assert(encoded.includes("Synthetic borrower after-maintenance"));
    using migrated = openNodeSqliteDatabase(legacyPath, { readOnly: true });
    assert.equal(
      migrated.prepare("PRAGMA user_version").get()?.user_version,
      OPENCLAW_AGENT_SCHEMA_VERSION,
    );
    assert.deepEqual(
      migrated
        .prepare("PRAGMA integrity_check")
        .all()
        .map((row) => row.integrity_check),
      ["ok"],
    );
    const result = {
      ok: true,
      cachedHandleClosed: !cached.db.isOpen,
      claimRevoked: !retained.claim.isCurrent(),
      migratedSchemaVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
      results,
    };
    writeFileSync(path.join(directory, "result.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } finally {
    retained.claim.release();
  }
} finally {
  for (const peer of peers) {
    peer.stop();
  }
  await server.close({ reason: "synthetic borrower correctness proof complete" });
}
