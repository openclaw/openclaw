#!/usr/bin/env node
// Published npm updater, populated PostgreSQL stores, and a foreground Gateway.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isCommandCancellation, runCancelableCommand } from "../../../lib/cancelable-command.mts";
import { toErrorObject } from "../../../lib/error-format.mts";
import { runManagedCommand } from "../../../lib/managed-child-process.mts";

const baseline = "2026.11.5";
const [candidateArg, artifactsArg] = process.argv.slice(2);
const dsn = process.env.OPENCLAW_UPGRADE_TEST_POSTGRES_DSN;
assert(
  candidateArg && artifactsArg && dsn,
  "Supply candidate.tgz, artifacts, and a disposable PostgreSQL DSN",
);
const candidate = fs.realpathSync(candidateArg);
const artifacts = path.resolve(artifactsArg);
fs.mkdirSync(artifacts, { recursive: true });
// The updater requires owner-only write access along its snapshot paths.
process.umask(0o077);

process.exitCode = await runCancelableCommand(async (signal) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-published-postgres-"));
  const state = path.join(home, "state");
  const prefix = path.join(home, "npm");
  const bin = path.join(prefix, "bin");
  const packageRoot = path.join(prefix, "lib/node_modules/openclaw");
  const cli = path.join(bin, "openclaw");
  const configFile = path.join(state, "openclaw.json");
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: home,
    XDG_RUNTIME_DIR: path.join(home, "run"),
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(home, "run", "bus")}`,
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: configFile,
    OPENCLAW_DATABASE_DSN: dsn,
    OPENCLAW_DISABLE_BONJOUR: "1",
    OPENCLAW_SKIP_CHANNELS: "1",
    OPENCLAW_SKIP_PROVIDERS: "1",
    npm_config_prefix: prefix,
    npm_config_cache: path.join(home, "npm-cache"),
    CI: "true",
  };
  async function run(name, command, args, commandSignal = signal) {
    const log = path.join(artifacts, name);
    const out = fs.openSync(`${log}.stdout`, "w");
    const err = fs.openSync(`${log}.stderr`, "w");
    try {
      const status = await runManagedCommand({
        bin: command,
        args,
        cwd: home,
        env,
        signal: commandSignal,
        timeoutMs: 600_000,
        requireProcessTreeExit: true,
        stdio: ["ignore", out, err],
      });
      assert.equal(status, 0, `${name} failed; see ${log}.stderr`);
      return fs.readFileSync(`${log}.stdout`, "utf8");
    } finally {
      fs.closeSync(out);
      fs.closeSync(err);
    }
  }
  function json(output) {
    return JSON.parse(output.slice(output.indexOf("{")));
  }

  try {
    await run("install-driver", "npm", [
      "install",
      "--global",
      `openclaw@${baseline}`,
      "--no-audit",
      "--no-fund",
    ]);
    const installedBuild = () =>
      JSON.parse(fs.readFileSync(path.join(packageRoot, "dist/build-info.json"), "utf8"));
    const originalBuild = installedBuild();
    assert.equal(originalBuild.version, baseline);
    const targetBuild = json(
      await run("candidate-build", "tar", ["-xOf", candidate, "package/dist/build-info.json"]),
    );
    const targetManifest = json(
      await run("candidate-manifest", "tar", ["-xOf", candidate, "package/package.json"]),
    );
    assert(targetBuild.buildId && originalBuild.buildId !== targetBuild.buildId);

    const portClaim = net.createServer();
    await new Promise((resolve, reject) => {
      portClaim.once("error", reject);
      portClaim.listen(0, "127.0.0.1", resolve);
    });
    const { port } = portClaim.address();
    await new Promise((resolve, reject) => {
      portClaim.close((error) =>
        error ? reject(toErrorObject(error, "Port close failed")) : resolve(),
      );
    });
    const token = "published-postgres-synthetic-token";
    const gatewayArgs = ["--url", `ws://127.0.0.1:${port}`, "--token", token, "--json"];
    fs.mkdirSync(state);
    fs.mkdirSync(env.XDG_RUNTIME_DIR, { mode: 0o700 });
    fs.writeFileSync(
      configFile,
      JSON.stringify({
        database: {
          engine: "postgres",
          postgres: {
            connection: { source: "env", provider: "default", id: "OPENCLAW_DATABASE_DSN" },
            schemaPrefix: "upgrade_" + randomUUID().replaceAll("-", "").slice(0, 8),
          },
        },
        gateway: { mode: "local", port, bind: "loopback", auth: { mode: "token", token } },
        plugins: { enabled: false },
        agents: {
          ownership: "explicit",
          entries: { main: { workspace: path.join(home, "workspace") } },
        },
      }),
    );

    async function withGateway(phase, expectedBuild, exercise) {
      const stop = new AbortController();
      const gatewaySignal = AbortSignal.any([signal, stop.signal]);
      const gateway = run(`gateway-${phase}`, cli, ["gateway", "run"], gatewaySignal);
      const ready = run(
        `ready-${phase}`,
        process.execPath,
        [
          path.join(import.meta.dirname, "probe-gateway.mjs"),
          "--base-url",
          `http://127.0.0.1:${port}`,
          "--path",
          "/readyz",
          "--expect",
          "ready",
          "--timeout-ms",
          "60000",
          "--out",
          path.join(artifacts, `ready-${phase}.json`),
        ],
        gatewaySignal,
      );
      try {
        await Promise.race([
          gateway.then(() => assert.fail("Gateway exited before readiness")),
          ready,
        ]);
        const target = json(
          await run(`probe-${phase}`, cli, ["gateway", "probe", ...gatewayArgs]),
        ).targets.find((entry) => entry.url === gatewayArgs[1]);
        assert.equal(target?.connect.ok, true);
        assert.equal(target.server.version, expectedBuild.version);
        if (phase === "after" || target.server.buildId !== undefined) {
          assert.equal(target.server.buildId, expectedBuild.buildId);
        }
        return await exercise(async (name, method, params) =>
          json(
            await run(`${phase}-${name}`, cli, [
              "gateway",
              "call",
              method,
              ...gatewayArgs,
              "--timeout",
              "30000",
              "--params",
              JSON.stringify(params),
            ]),
          ),
        );
      } finally {
        stop.abort();
        await ready.catch(() => {});
        await gateway.catch((/** @type {unknown} */ error) => {
          if (!isCommandCancellation(error)) {
            throw error;
          }
        });
      }
    }

    const marker = `postgres-upgrade-${randomUUID()}`;
    let session;
    const assertHistory = async (call) => {
      const history = await call("history", "chat.history", {
        agentId: "main",
        sessionKey: session.key,
        limit: 20,
      });
      assert.equal(history.sessionId, session.sessionId);
      assert(JSON.stringify(history.messages).includes(marker), "Missing published transcript");
    };
    await withGateway("before", originalBuild, async (call) => {
      session = await call("create", "sessions.create", {
        agentId: "main",
        key: "agent:main:postgres-upgrade",
      });
      assert(session.ok && session.key && session.sessionId && !session.runStarted);
      const injected = await call("inject", "chat.inject", {
        agentId: "main",
        sessionKey: session.key,
        message: marker,
      });
      assert(injected.ok && injected.messageId);
      await assertHistory(call);
    });

    const pg = createRequire(path.join(packageRoot, "package.json"))("pg");
    async function inspectStores(phase) {
      const client = new pg.Client({ connectionString: dsn });
      await client.connect();
      try {
        const stores = {};
        for (const [role, file] of [
          ["state", "state/openclaw.sqlite"],
          ["agent", "agents/main/agent/openclaw-agent.sqlite"],
        ]) {
          const local = new DatabaseSync(path.join(state, file), { readOnly: true });
          let anchor;
          try {
            anchor = local
              .prepare("SELECT engine, schema, store_id FROM openclaw_engine_anchor")
              .get();
          } finally {
            local.close();
          }
          assert.equal(anchor?.engine, "postgres");
          const schema = pg.escapeIdentifier(anchor.schema);
          const { rows } = await client.query(
            `SELECT schema_version::integer AS version FROM ${schema}.schema_meta`,
          );
          assert.equal(rows.length, 1);
          stores[role] = { storeId: anchor.store_id, version: rows[0].version };
        }
        fs.writeFileSync(path.join(artifacts, `stores-${phase}.json`), JSON.stringify(stores));
        return stores;
      } finally {
        await client.end();
      }
    }

    const before = await inspectStores("before");
    assert.equal(before.state.version, 36);
    assert.equal(before.agent.version, 38);
    await run("backup-before", cli, [
      "backup",
      "create",
      "--output",
      path.join(home, "before.tar.gz"),
      "--no-include-workspace",
      "--verify",
    ]);
    const update = json(
      await run("update", cli, ["update", "--yes", "--json", "--no-restart", "--tag", candidate]),
    );
    assert.equal(update.status, "ok");
    assert.deepEqual(installedBuild(), targetBuild);
    // The installed updater must migrate both stores before a candidate Doctor or Gateway can hide a missed migration.
    const after = await inspectStores("after");
    for (const role of ["state", "agent"]) {
      assert.equal(after[role].storeId, before[role].storeId);
      assert.equal(after[role].version, targetManifest.openclaw.schemaVersions[role]);
    }
    await withGateway("after", targetBuild, assertHistory);
    console.log(
      `Published ${baseline} PostgreSQL state ${before.state.version} → ${after.state.version}, agent ${before.agent.version} → ${after.agent.version}; Gateway history preserved`,
    );
    return 0;
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
