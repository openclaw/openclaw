// Synthetic built-Gateway retention proof; forced snapshots do not measure GC throughput.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.ts";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { applyMockOpenAiModelConfig } from "../e2e/lib/fixtures/mock-openai-config.mjs";
import { stopChild } from "../lib/gateway-bench-child.ts";
import {
  buildGatewayBenchChildArgs,
  createGatewayBenchEnv,
  waitForInitialProbe,
  writePluginFixtures,
} from "../lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "../lib/gateway-ws-client.ts";
import { generateTeamShapeFixture, parseTeamShapeOptions } from "./team-shape-fixture.ts";

const { values } = parseArgs({
  options: {
    prepare: { type: "boolean" },
    capture: { type: "boolean" },
    "state-dir": { type: "string" },
    output: { type: "string" },
    port: { type: "string", default: "41697" },
    "mock-port": { type: "string", default: "41698" },
    entry: { type: "string", default: "dist/entry.js" },
  },
});
assert(
  values.prepare !== values.capture && (values.prepare || values.capture),
  "Choose --prepare or --capture",
);
assert(values["state-dir"], "--state-dir is required");
const root = path.resolve(values["state-dir"]);
const port = Number(values.port);
const mockPort = Number(values["mock-port"]);
for (const value of [port, mockPort]) {
  assert(Number.isInteger(value) && value >= 40000 && value <= 65535, "Ports must be 40000–65535");
}
assert.notEqual(port, mockPort, "Gateway and mock provider need distinct ports");
const configPath = path.join(root, "openclaw.json");
const manifestPath = path.join(root, "team-shape-summary.json");

if (values.prepare) {
  const options = parseTeamShapeOptions([
    "--state-dir",
    root,
    "--sessions",
    "10000",
    "--runs",
    "8000",
    "--settled-runs",
    "--transcript-mib",
    "0",
    "--approvals",
    "0",
    "--cron",
    "0",
    "--projects",
    "0",
    "--port",
    String(port),
  ]);
  const { summary, env } = await generateTeamShapeFixture(options);
  process.env = env;
  const { runOpenClawAgentWriteTransaction, closeOpenClawAgentDatabasesAsync } =
    await import("../../src/state/openclaw-agent-db.js");
  const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.js");
  const { readSessionEntryStore, writeSessionEntry } =
    await import("../../src/config/sessions/session-accessor.sqlite-entry-store.js");
  try {
    runOpenClawAgentWriteTransaction(
      (database) => {
        for (const [sessionKey, entry] of Object.entries(readSessionEntryStore(database))) {
          const runId = `synthetic-summary-run-${entry.sessionId}`;
          entry.observerDigest = {
            sessionKey,
            sessionId: entry.sessionId,
            lifecycleRevision: entry.lifecycleRevision,
            runId,
            agentId: "main",
            revision: 1,
            updatedAt: entry.updatedAt,
            headline: "Synthetic completed work",
            assessment: "Synthetic task complete",
            health: "done",
            planProgress: { completed: 3, total: 3 },
          };
          entry.restartRecoveryOperatorSource = {
            version: 1,
            sessionKey,
            sessionId: entry.sessionId,
            lifecycleRevision: entry.lifecycleRevision,
            sourceRunId: runId,
            agentId: "main",
            snapshot: {
              profileId: "synthetic-operator",
              scopes: ["operator.read", "operator.write"],
              assignedRole: null,
              githubLogin: null,
              grant: null,
              aliasBindingIds: [],
              authPolicy: {
                generation: "",
                grantGeneration: "synthetic",
                role: "operator",
                authMethod: "token",
              },
              controlUiAdmin: false,
              localOperator: true,
              sourceIngress: "internal",
            },
          };
          writeSessionEntry(database, sessionKey, entry);
        }
      },
      { agentId: "main" },
    );
  } finally {
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
  }
  const config: OpenClawConfig = JSON.parse(readFileSync(configPath, "utf8"));
  const fixtures = writePluginFixtures(root, { count: 40 });
  applyMockOpenAiModelConfig(config, { mockPort, modelRef: "openai/gpt-4.1" });
  assert(config.models?.providers?.openai && config.agents?.defaults);
  config.models.providers.openai.apiKey = "synthetic-fixture-only";
  config.agents.defaults.skipBootstrap = true;
  config.plugins = {
    ...config.plugins,
    allow: [...fixtures.pluginIds, "openai"],
    load: { paths: [fixtures.pluginsDir] },
    entries: { "memory-core": { enabled: false } },
    slots: { memory: "none" },
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  writeFileSync(
    manifestPath,
    JSON.stringify({ ...summary, summaryIdRetention: { port, mockPort } }, null, 2),
  );
  console.log(JSON.stringify(summary));
} else {
  assert(values.output, "--capture requires --output naming a new directory");
  assert(values.entry.endsWith(".js"), "--entry must name a built JavaScript Gateway entry");
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert(
    isRecord(manifest) &&
      manifest.format === "openclaw-team-shape-v1" &&
      manifest.sessionCount === 10000,
  );
  assert(
    isRecord(manifest.summaryIdRetention),
    "Prepare a fresh summary-ID fixture before capture",
  );
  assert.deepEqual(
    manifest.summaryIdRetention,
    { port, mockPort },
    "Use the prepared fixture's ports",
  );
  for (const selected of [port, mockPort]) {
    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(selected, "127.0.0.1", () =>
        probe.close((error) => (error ? reject(error) : resolve())),
      );
    });
  }
  const output = path.resolve(values.output);
  mkdirSync(path.dirname(output), { recursive: true });
  mkdirSync(output, { mode: 0o700 });
  const profile = `summary-id-${port}`;
  const env = createGatewayBenchEnv(path.join(root, "home"), configPath, {
    startupTrace: false,
    caseEnv: {
      OPENCLAW_STATE_DIR: root,
      TMPDIR: path.join(root, "tmp"),
      OPENCLAW_PROFILE: profile,
      OPENCLAW_LAUNCHD_LABEL: `ai.openclaw.${profile}`,
      OPENCLAW_SYSTEMD_UNIT: `openclaw-gateway-${profile}`,
      OPENCLAW_SKIP_CHANNELS: "1",
    },
  });
  const children: ChildProcess[] = [];
  let client: ReturnType<typeof createGatewayWsClient> | undefined;
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () =>
    (cleanupPromise ??= (async () => {
      client?.close();
      for (const child of children.toReversed()) {
        await stopChild(child, { teardownGraceMs: 10000, killGraceMs: 2000 });
      }
    })());
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(
      signal,
      () => void cleanup().finally(() => process.exit(signal === "SIGINT" ? 130 : 143)),
    );
  }
  const launch = async (
    args: string[],
    extra: NodeJS.ProcessEnv,
    name: string,
    selectedPort: number,
    probePath: string,
  ) => {
    const child = spawn(process.execPath, args, {
      env: { ...env, ...extra },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const log = createWriteStream(path.join(output, `${name}.log`));
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.once("close", () => log.end());
    let launchError: Error | undefined;
    child.once("error", (error) => {
      launchError = error;
    });
    children.push(child);
    const ready = await waitForInitialProbe({
      port: selectedPort,
      path: probePath,
      startAt: performance.now(),
      deadlineAt: performance.now() + 300000,
      isDone: () => Boolean(launchError) || child.exitCode !== null || child.signalCode !== null,
    });
    assert.equal(ready.status, 200, launchError?.message ?? `${name} failed readiness`);
  };
  try {
    await launch(
      ["scripts/e2e/mock-openai-server.mjs"],
      { MOCK_PORT: String(mockPort), MOCK_BIND_HOST: "127.0.0.1" },
      "mock",
      mockPort,
      "/health",
    );
    await launch(buildGatewayBenchChildArgs(values.entry, port), {}, "gateway", port, "/readyz");
    const connection = createGatewayWsClient({ url: `ws://127.0.0.1:${port}` });
    client = connection;
    await connection.waitOpen();
    const rpc = async (method: string, params: unknown, timeout = 120000) => {
      const result = await connection.request(method, params, timeout);
      assert.equal(result.ok, true, `${method}: ${JSON.stringify(result.error)}`);
      assert(isRecord(result.payload), `${method} returned no object payload`);
      return result.payload;
    };
    await rpc("connect", {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: "gateway-client",
        displayName: "synthetic-retention",
        version: "1.0.0",
        platform: process.platform,
        mode: "backend",
      },
      role: "operator",
      scopes: ["operator.admin", "operator.read", "operator.write"],
      caps: [],
    });
    for (let offset = 0; offset < 10000; offset += 100) {
      const listed = await rpc("sessions.list", {
        limit: 100,
        offset,
        archived: "all",
        includeUnknown: true,
      });
      assert(
        Array.isArray(listed.sessions) && listed.sessions.length === 100,
        `Missing rows at offset ${offset}`,
      );
    }
    for (let turn = 0; turn < 10; turn++) {
      const key = `agent:main:dashboard:16970000-0000-4000-8000-${String(turn % 5).padStart(12, "0")}`;
      if (turn < 5) {
        await rpc("sessions.create", { key, visibility: "shared", model: "openai/gpt-4.1" });
      }
      const sent = await rpc("chat.send", {
        sessionKey: key,
        message: `Reply with synthetic completion ${turn}.`,
        deliver: false,
        idempotencyKey: randomUUID(),
      });
      assert.equal(typeof sent.runId, "string");
      const terminal = await rpc("agent.wait", { runId: sent.runId, timeoutMs: 60000 });
      assert.equal(terminal.status, "ok", JSON.stringify(terminal));
      await rpc("sessions.patch", { key, label: `Synthetic churn ${turn}` });
      console.log(`Completed turn ${turn + 1}/10`);
    }
    await rpc("sessions.list", { limit: 100, archived: "all", includeUnknown: true });
    await delay(2000);
    const snapshot = await rpc(
      "diagnostics.heapSnapshot",
      { reason: "synthetic summary-ID retention" },
      180000,
    );
    writeFileSync(path.join(output, "capture.json"), JSON.stringify(snapshot, null, 2));
    console.log(JSON.stringify(snapshot));
  } finally {
    await cleanup();
  }
}
