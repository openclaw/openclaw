/**
 * Offline environment-selection scaling probe; never use operator state.
 * node --import ./scripts/tsx.mjs scripts/perf/select-environment-scale.ts seed
 *   --state-dir "$PWD/.local/select-small" --agent-mib 8 --shared-mib 8
 * Repeat with --agent-mib 512 --shared-mib 1024 for several GiB, or vary either
 * dimension independently. Each fixture has 10k sessions, three agents, six
 * registered agent databases, 40 disabled plugin declarations, config health,
 * and a matching backup. A killed seed child leaves committed, nonempty WALs.
 * node --import ./scripts/tsx.mjs scripts/perf/select-environment-scale.ts measure
 *   --state-dir "$PWD/.local/select-small" --entry dist/entry.js --output result.json
 * Run >=3 interleaved boots per revision using the same fixture. The preload
 * exits synchronously at the selection completion log, before bootstrap effects.
 * CPU is main-thread selection CPU; add --allocation for a separate main-isolate
 * allocation pass (4 KiB sampling, including collected objects). This is a boot
 * phase probe, not readiness or throughput proof. Local filesystem/cache and
 * host-load effects remain visible; it does not reproduce btrfs or predecessor locks.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createCipheriv, createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import { createServer } from "node:net";
import { loadavg } from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { TranscriptEvent } from "../../src/config/sessions/session-accessor.sqlite-contract.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "state-dir": { type: "string" },
    "agent-mib": { type: "string", default: "8" },
    "shared-mib": { type: "string", default: "8" },
    sessions: { type: "string", default: "10000" },
    port: { type: "string", default: "41671" },
    entry: { type: "string", default: "dist/entry.js" },
    output: { type: "string" },
    allocation: { type: "boolean" },
  },
});
assert(values["state-dir"], "--state-dir must name an isolated synthetic directory");
const root = path.resolve(values["state-dir"]);
const configPath = path.join(root, "openclaw.json");
const markerPath = path.join(root, "select-environment-fixture.json");
const number = (key: "agent-mib" | "shared-mib" | "sessions" | "port", min = 0) =>
  parseStrictIntegerOption({ raw: values[key], fallback: 0, min, label: `--${key}` });
const port = number("port", 40000);
assert(port <= 65535);
const env: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  HOME: path.join(root, "home"),
  OPENCLAW_HOME: path.join(root, "home"),
  OPENCLAW_STATE_DIR: root,
  OPENCLAW_CONFIG_PATH: configPath,
  OPENCLAW_PROFILE: "select-environment-synthetic",
  TMPDIR: path.join(root, "tmp"),
  TMP: path.join(root, "tmp"),
  TEMP: path.join(root, "tmp"),
  CI: "1",
  NO_COLOR: "1",
  OPENCLAW_NO_RESPAWN: "1",
  OPENCLAW_EXEC_SHELL_SNAPSHOT: "0",
  OPENCLAW_SKIP_CHANNELS: "1",
  OPENCLAW_DISABLE_BONJOUR: "1",
  OPENCLAW_GATEWAY_STARTUP_TRACE: "1",
};
const mib = 1024 ** 2;

function familyBytes(databasePath: string) {
  return ["", "-wal", "-shm"].reduce(
    (sum, suffix) =>
      sum + (fs.existsSync(databasePath + suffix) ? fs.statSync(databasePath + suffix).size : 0),
    0,
  );
}

async function seedChild() {
  const agentMiB = number("agent-mib");
  const sharedMiB = number("shared-mib");
  const sessionCount = number("sessions", 6);
  assert(agentMiB * 6 + sharedMiB <= 6144, "Logical fixture payload must fit within 6 GiB");
  process.env = { ...env, OPENCLAW_GATEWAY_STARTUP_TRACE: "0" };
  const [agentOwner, stateOwner, entries, transcripts, health, fingerprints] = await Promise.all([
    import("../../src/state/openclaw-agent-db.js"),
    import("../../src/state/openclaw-state-db.js"),
    import("../../src/config/sessions/session-accessor.sqlite-entry-store.js"),
    import("../../src/config/sessions/session-accessor.sqlite-transcript-store.js"),
    import("../../src/config/io.health-state.js"),
    import("../../src/config/io.observe-state.js"),
  ]);
  const agents = ["main", "reviewer", "researcher"];
  const config = {
    gateway: {
      mode: "local",
      bind: "loopback",
      port,
      auth: { mode: "none" },
      controlUi: { enabled: false },
      tailscale: { mode: "off" },
    },
    agents: {
      ownership: "explicit",
      defaults: { systemAgent: { agentId: "main" } },
      entries: Object.fromEntries(
        agents.map((id) => [id, { workspace: path.join(root, "workspace", id) }]),
      ),
    },
    plugins: {
      enabled: false,
      entries: Object.fromEntries(
        Array.from({ length: 40 }, (_, i) => [`synthetic-${i}`, { enabled: false }]),
      ),
    },
    cron: { enabled: false },
    browser: { enabled: false },
    discovery: { mdns: { mode: "off" } },
    update: { checkOnStart: false },
  };
  const raw = `${JSON.stringify(config, null, 2)}\n`;
  fs.writeFileSync(configPath, raw);
  fs.writeFileSync(`${configPath}.bak`, raw);
  const { createConfigIO } = await import("../../src/config/io.factory.js");
  const snapshot = await createConfigIO({
    observe: false,
    pluginValidation: "core-only",
  }).readConfigFileSnapshot();
  assert(snapshot.valid, JSON.stringify(snapshot.issues));
  const shared = stateOwner.openOpenClawStateDatabase();
  health.patchConfigHealthEntryToStore(
    { env: process.env, homedir: () => env.HOME!, logger: console },
    configPath,
    {
      lastKnownGood: fingerprints.createConfigHealthFingerprint({
        raw,
        parsed: config,
        stat: fs.statSync(configPath),
      }),
    },
  );
  const databasePaths = [shared.path];
  const leaveAgentWal: Array<() => void> = [];
  const payload = createCipheriv(
    "aes-256-ctr",
    createHash("sha256").update("select-environment-fixture").digest(),
    Buffer.alloc(16),
  );
  const zeros = Buffer.alloc(48 * 1024);
  const nextText = () => payload.update(zeros).toString("base64");
  const checkSize = () =>
    assert(
      databasePaths.reduce((sum, p) => sum + familyBytes(p), 0) < 18 * 1024 ** 3,
      "Fixture reached its 18 GiB disk budget",
    );
  const now = Date.parse("2026-10-26T00:00:00Z");
  for (let index = 0; index < 6; index++) {
    const agentId = agents[index % 3]!;
    const options = {
      agentId,
      env: process.env,
      ...(index >= 3
        ? { path: path.join(root, "agents", agentId, "agent", "retained.sqlite") }
        : {}),
    };
    const database = agentOwner.openOpenClawAgentDatabase(options);
    databasePaths.push(database.path);
    const count =
      Math.floor(((index + 1) * sessionCount) / 6) - Math.floor((index * sessionCount) / 6);
    const identities = Array.from({ length: count }, (_, n) => ({
      sessionId: `synthetic-${index}-${n}`,
      sessionKey: `agent:${agentId}:synthetic-${index}-${n}`,
    }));
    for (let offset = 0; offset < identities.length; offset += 100) {
      agentOwner.runOpenClawAgentWriteTransaction((db) => {
        for (const identity of identities.slice(offset, offset + 100)) {
          entries.writeSessionEntry(db, identity.sessionKey, {
            sessionId: identity.sessionId,
            updatedAt: now,
            status: "done",
            label: "Synthetic retained session",
          });
          transcripts.appendTranscriptEventsInTransaction(db, { ...options, ...identity }, [
            {
              type: "session",
              version: 3,
              id: identity.sessionId,
              timestamp: new Date(now).toISOString(),
            },
          ]);
        }
      }, options);
      await setImmediate();
    }
    const messages = Math.ceil((agentMiB * mib) / (64 * 1024));
    for (let offset = 0; offset < messages; offset += 32) {
      const identity = identities[Math.floor(offset / 32) % identities.length]!;
      const events: TranscriptEvent[] = Array.from(
        { length: Math.min(32, messages - offset) },
        (_, n) => ({
          type: "message",
          id: `payload-${offset + n}`,
          parentId: null,
          timestamp: new Date(now).toISOString(),
          message: { role: "user", content: [{ type: "text", text: nextText() }], timestamp: now },
        }),
      );
      agentOwner.runOpenClawAgentWriteTransaction(
        (db) =>
          transcripts.appendTranscriptEventsInTransaction(db, { ...options, ...identity }, events),
        options,
      );
      if (offset % 512 === 0) {
        database.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        checkSize();
      }
      await setImmediate();
    }
    database.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    leaveAgentWal.push(() =>
      agentOwner.runOpenClawAgentWriteTransaction(
        (db) =>
          entries.writeSessionEntry(db, identities[0]!.sessionKey, {
            sessionId: identities[0]!.sessionId,
            updatedAt: now + 1,
            status: "done",
          }),
        options,
      ),
    );
  }
  const chunks = Math.ceil((sharedMiB * mib) / (64 * 1024));
  for (let offset = 0; offset < chunks; offset += 32) {
    stateOwner.runOpenClawStateWriteTransaction(({ db }) => {
      const insert = db.prepare(
        "INSERT INTO plugin_state_entries (plugin_id, namespace, entry_key, value_json, created_at, expires_at) VALUES (?, ?, ?, ?, ?, NULL)",
      );
      for (let n = offset; n < Math.min(offset + 32, chunks); n++) {
        insert.run("synthetic-scale", "retained", String(n), JSON.stringify(nextText()), now);
      }
    });
    if (offset % 512 === 0) {
      shared.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      checkSize();
    }
    await setImmediate();
  }
  shared.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const { listOpenClawRegisteredAgentDatabases } =
    await import("../../src/state/openclaw-agent-db-registry.js");
  const registrations = listOpenClawRegisteredAgentDatabases({ env: process.env });
  assert.equal(registrations.length, 6, "Canonical owner must register all six databases");
  const healthState = health.readConfigHealthStateFromStore({
    env: process.env,
    homedir: () => env.HOME!,
    logger: console,
  });
  assert(
    healthState.entries?.[configPath]?.lastKnownGood,
    "Config health baseline must be persisted",
  );
  for (const leaveWal of leaveAgentWal) {
    leaveWal();
  }
  stateOwner.runOpenClawStateWriteTransaction(({ db }) =>
    db
      .prepare("UPDATE config_health_entries SET updated_at_ms = ? WHERE config_path = ?")
      .run(now, configPath),
  );
  checkSize();
  const databases = databasePaths.map((p) => ({
    path: p,
    bytes: fs.statSync(p).size,
    walBytes: fs.statSync(`${p}-wal`).size,
  }));
  assert(
    databases.every((db) => db.walBytes > 0),
    "Every database needs an uncheckpointed WAL",
  );
  fs.writeFileSync(
    markerPath,
    JSON.stringify(
      {
        format: "select-environment-scale-v1",
        sessionCount,
        agents: 3,
        registeredDatabases: registrations.length,
        plugins: 40,
        agentMiB,
        sharedMiB,
        databases,
      },
      null,
      2,
    ),
  );
  // No close hooks: model committed WAL left by an unclean predecessor shutdown.
  process.kill(process.pid, "SIGKILL");
}

async function seed() {
  fs.mkdirSync(path.dirname(root), { recursive: true });
  fs.mkdirSync(root);
  for (const dir of ["home", "tmp", "workspace"]) {
    fs.mkdirSync(path.join(root, dir));
  }
  const child = spawn(
    process.execPath,
    [
      "--import",
      fileURLToPath(new URL("../tsx.mjs", import.meta.url)),
      fileURLToPath(import.meta.url),
      "seed-child",
      ...process.argv.slice(3),
    ],
    { env, stdio: "inherit" },
  );
  const [code, signal] = await once(child, "exit");
  assert(
    code === null && signal === "SIGKILL" && fs.existsSync(markerPath),
    "Fixture generation failed",
  );
  console.log(fs.readFileSync(markerPath, "utf8"));
}

async function measure() {
  assert(values.output, "--output is required");
  const fixture = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  assert.equal(fixture.format, "select-environment-scale-v1");
  const sourceFiles = [
    configPath,
    `${configPath}.bak`,
    ...fixture.databases.flatMap((database: { path: string }) => [
      database.path,
      `${database.path}-wal`,
      `${database.path}-shm`,
    ]),
  ];
  const sourceStats = () =>
    sourceFiles.map((file: string) => {
      const stat = fs.statSync(file, { bigint: true });
      return { file, size: String(stat.size), mtimeNs: String(stat.mtimeNs) };
    });
  const sourceBefore = sourceStats();
  const entry = fs.realpathSync(values.entry);
  const probe = createServer().listen(port, "127.0.0.1");
  await once(probe, "listening");
  await probe[Symbol.asyncDispose]();
  const output = path.resolve(values.output);
  const preload = path.join(root, "stop-after-selection.mjs");
  fs.writeFileSync(
    preload,
    `import fs from "node:fs";
import { Session } from "node:inspector";
const inspector = ${Boolean(values.allocation)} ? new Session() : null;
inspector?.connect();
const post = (method, params) => {
  let completed = false, value, failure;
  inspector.post(method, params, (error, result) => { completed = true; failure = error; value = result; });
  if (!completed || failure) throw failure ?? new Error("Inspector did not complete synchronously");
  return value;
};
const allocated = node => node.selfSize + node.children.reduce((sum, child) => sum + allocated(child), 0);
let start;
const write = process.stderr.write.bind(process.stderr);
process.stderr.write = function(chunk, ...args) {
  const text = String(chunk);
  if (/cli\\.main\\.gateway-run-select-environment starting/.test(text)) {
    if (inspector) post("HeapProfiler.startSampling", {samplingInterval:4096, includeObjectsCollectedByMajorGC:true, includeObjectsCollectedByMinorGC:true});
    start = process.threadCpuUsage();
  }
  const result = write(chunk, ...args);
  if (/cli\\.main\\.gateway-run-select-environment [\\d.]+ms/.test(text)) {
    const cpu = start ? process.threadCpuUsage(start) : null;
    const allocatedBytes = inspector ? allocated(post("HeapProfiler.stopSampling", {}).profile.head) : undefined;
    fs.writeFileSync(${JSON.stringify(`${output}.cpu.json`)}, JSON.stringify({cpu, allocatedBytes, memory: process.memoryUsage()}));
    process.exit(text.includes(" failed ") ? 1 : 0);
  }
  return result;
};
`,
  );
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const logPath = `${output}.log`;
  const log = fs.openSync(logPath, "w");
  const hostLoadBefore = loadavg();
  const child = spawn(
    process.execPath,
    ["--import", preload, entry, "gateway", "run", "--port", String(port), "--bind", "loopback"],
    { env, stdio: ["ignore", log, log] },
  );
  const timeout = setTimeout(() => child.kill("SIGKILL"), 180_000);
  let exit;
  try {
    exit = await once(child, "exit");
  } finally {
    clearTimeout(timeout);
    fs.closeSync(log);
  }
  assert.equal(exit[0], 0, `Gateway probe failed: ${logPath}`);
  assert.deepEqual(
    sourceStats(),
    sourceBefore,
    "Selection changed a source database/config family",
  );
  const logs = fs.readFileSync(logPath, "utf8");
  const phaseLines = logs.split("\n").filter((line) => /startup (?:trace|phase):/.test(line));
  assert(
    phaseLines.some((line) => line.includes("cli.environment.config.snapshot.read.materialize ")),
    "Selection did not materialize a valid config",
  );
  assert(
    phaseLines.some((line) => /cli\.main\.gateway-run-select-environment [\d.]+ms/.test(line)),
    "Missing selection completion",
  );
  const result = {
    mode: values.allocation ? "allocation" : "timing",
    entry,
    fixture,
    hostLoadBefore,
    hostLoadAfter: loadavg(),
    phaseLines,
    ...JSON.parse(fs.readFileSync(`${output}.cpu.json`, "utf8")),
  };
  fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
}

if (positionals[0] === "seed") {
  await seed();
} else if (positionals[0] === "seed-child") {
  await seedChild();
} else if (positionals[0] === "measure") {
  await measure();
} else {
  throw new Error("Use seed or measure");
}
