/**
 * Offline native-update crossing on synthetic state; never point this at operator state.
 * node --import ./scripts/tsx.mjs scripts/perf/schema-crossing-measure.ts seed .local/crossing-fixture [agents=16] [archiveMiBPerAgent=128] [sessionsPerAgent=625]
 * Copy that fixture before each run, then:
 * node --import ./scripts/tsx.mjs scripts/perf/schema-crossing-measure.ts run .local/crossing-base [allocation|timing]
 * Compare summary.json and stderr startup-trace phase timings on base/candidate.
 * Seed uses the frozen schema-35 fixture and current agent schemas. Each archive is
 * synthetic JSONL; current session rows have one synthetic transcript event each.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import os from "node:os";
import path from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";

const [mode, directory, agentArg = "16", archiveArg = "128", sessionsArg = "625"] =
  process.argv.slice(2);
assert.ok(directory && (mode === "seed" || mode === "run"));
const root = path.resolve(directory);
assert.ok(
  root.startsWith(path.resolve(".local") + path.sep),
  "Use this checkout's .local directory",
);
const physicalParent = fs.realpathSync(path.dirname(root));
assert.ok(
  physicalParent.startsWith(fs.realpathSync(process.cwd()) + path.sep),
  "Fixture parent must remain inside this checkout",
);
if (mode === "seed") {
  fs.mkdirSync(root); // Refuse every existing destination before touching its state.
} else {
  assert.ok(fs.existsSync(path.join(root, "fixture.json")), "Missing synthetic fixture marker");
}
assert.ok(fs.realpathSync(root).startsWith(fs.realpathSync(process.cwd()) + path.sep));
const stateDir = path.join(root, "state");
const configPath = path.join(stateDir, "openclaw.json");
Object.assign(process.env, {
  HOME: path.join(root, "home"),
  OPENCLAW_HOME: path.join(root, "home"),
  OPENCLAW_STATE_DIR: stateDir,
  OPENCLAW_CONFIG_PATH: configPath,
  TMPDIR: path.join(root, "tmp"),
  OPENCLAW_SUPERVISOR_MODE: "external",
  OPENCLAW_SERVICE_REPAIR_POLICY: "external",
  OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  OPENCLAW_GATEWAY_STARTUP_TRACE: "1",
});
for (const key of ["OPENCLAW_AGENT_DIR", "OPENCLAW_UPDATE_RUN_ID", "OPENCLAW_UPDATE_IN_PROGRESS"]) {
  delete process.env[key];
}
for (const dir of [stateDir, process.env.HOME!, process.env.TMPDIR!]) {
  fs.mkdirSync(dir, { recursive: true });
}

if (mode === "seed") {
  const agents = Number(agentArg);
  const archiveMiB = Number(archiveArg);
  const sessions = Number(sessionsArg);
  for (const number of [agents, archiveMiB, sessions]) {
    assert.ok(Number.isSafeInteger(number) && number > 0);
  }
  const ids = Array.from({ length: agents }, (_, index) => `synthetic-${index}`);
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      agents: { ownership: "explicit", entries: Object.fromEntries(ids.map((id) => [id, {}])) },
      plugins: { enabled: false },
      gateway: {
        mode: "local",
        port: 49620,
        bind: "loopback",
        auth: { mode: "none" },
        controlUi: { enabled: false },
      },
    }),
  );
  const { openOpenClawAgentDatabase, closeOpenClawAgentDatabasesAsync } =
    await import("../../src/state/openclaw-agent-db.js");
  const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.js");
  const { resolveSqliteTranscriptArchiveDirectory } =
    await import("../../src/config/sessions/session-accessor.sqlite-scope.js");
  const line =
    JSON.stringify({
      type: "message",
      message: { role: "user", content: "synthetic archive ".repeat(65530) },
    }) + "\n";
  const blob = Buffer.from(line);
  const digest = createHash("sha256").update(blob).digest("hex");
  const now = Date.now();
  let databaseBytes = 0;
  for (const agentId of ids) {
    const agent = openOpenClawAgentDatabase({ agentId, env: process.env });
    const archiveDir = resolveSqliteTranscriptArchiveDirectory({ agentId, path: agent.path });
    fs.mkdirSync(archiveDir, { recursive: true });
    const db = agent.db;
    db.exec("BEGIN IMMEDIATE");
    const node = db.prepare(
      "INSERT INTO session_nodes(session_key,current_session_id,entry_json,entry_valid,updated_at,status) VALUES(?,?,?,1,?,'done')",
    );
    const window = db.prepare(
      "INSERT INTO session_windows(session_id,session_key,created_at,updated_at,status) VALUES(?,?,?,?,'done')",
    );
    const event = db.prepare(
      "INSERT INTO transcript_events(session_id,seq,event_json,created_at) VALUES(?,0,?,?)",
    );
    for (let index = 0; index < sessions; index++) {
      const sessionId = `${agentId}-${index}`;
      const sessionKey = `agent:${agentId}:subagent:${sessionId}`;
      node.run(
        sessionKey,
        sessionId,
        JSON.stringify({ sessionId, updatedAt: now, status: "done" }),
        now,
      );
      window.run(sessionId, sessionKey, now, now);
      event.run(
        sessionId,
        JSON.stringify({
          type: "message",
          id: sessionId,
          message: { role: "user", content: "Synthetic retained session." },
        }),
        now,
      );
    }
    const archive = db.prepare(
      "INSERT INTO session_transcript_archives(session_id,generation,session_key,reason,encoding,archive_blob,archive_sha256,archive_name,created_at,published_at) VALUES(?,'retained',?,'deleted','identity',?,?,?, ?, ?)",
    );
    for (let index = 0; index < Math.ceil((archiveMiB * 1048576) / blob.length); index++) {
      const id = `archive-${index}`;
      const name = `${id}.jsonl.deleted.${now}`;
      archive.run(id, `agent:${agentId}:subagent:${id}`, blob, digest, name, now, now);
      fs.writeFileSync(path.join(archiveDir, name), blob);
    }
    db.exec("COMMIT");
    await closeOpenClawAgentDatabasesAsync(stateDir);
    databaseBytes += fs.statSync(agent.path).size;
  }
  await closeOpenClawStateDatabaseAsync();
  // Construct the exact released state shape; agent database contents remain untouched.
  const sharedPath = path.join(stateDir, "state", "openclaw.sqlite");
  fs.mkdirSync(path.dirname(sharedPath), { recursive: true });
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(sharedPath + suffix, { force: true });
  }
  using shared = new DatabaseSync(sharedPath);
  shared.exec(fs.readFileSync("test/fixtures/sqlite/openclaw-state-schema-v35.sql", "utf8"));
  shared.exec(
    "PRAGMA user_version=35; INSERT INTO schema_meta VALUES('primary','global',35,NULL,'synthetic-schema-35',100,100);",
  );
  const { writeConfigMachineStateInDatabase } =
    await import("../../src/state/config-machine-state-write.js");
  writeConfigMachineStateInDatabase(shared, "state.schema.contentVersion", 35);
  const register = shared.prepare("INSERT INTO agent_databases VALUES(?,?,38,?,0)");
  for (const agentId of ids) {
    register.run(agentId, `agents/${agentId}/agent/openclaw-agent.sqlite`, now);
  }
  const fixture = {
    agents,
    sessions: agents * sessions,
    archiveMiBPerAgent: archiveMiB,
    databaseBytes,
    sourceStateSchema: 35,
    sourceAgentSchema: 38,
  };
  fs.writeFileSync(path.join(root, "fixture.json"), JSON.stringify(fixture, null, 2));
  console.log(JSON.stringify(fixture));
} else {
  // A copied fixture needs its own pristine binding; it contains no operator credentials.
  const { bindFreshClientCredentialStore } =
    await import("../../src/infra/client-credential-migration.js");
  const { runSqliteImmediateTransactionSync } =
    await import("../../src/infra/sqlite-transaction.js");
  const sharedPath = path.join(stateDir, "state", "openclaw.sqlite");
  {
    using shared = new DatabaseSync(sharedPath);
    runSqliteImmediateTransactionSync(shared, () =>
      bindFreshClientCredentialStore(shared, { path: sharedPath, env: process.env }),
    );
  }
  const { updateMigrateCommand } =
    await import("../../src/cli/update-cli/update-command-migrate.js");
  const { withCliProcessScope, withCliCommandCleanup } =
    await import("../../src/cli/runtime-cleanup-scope.js");
  const { closeCliResources } = await import("../../src/cli/runtime-cleanup.js");
  const contentBefore = readCanonicalContent();
  const sampling = agentArg !== "timing";
  const inspector = new Session();
  if (sampling) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  let gcMs = 0;
  let gcCount = 0;
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      gcMs += entry.duration;
      gcCount++;
    }
  });
  observer.observe({ entryTypes: ["gc"] });
  const before = process.cpuUsage();
  const threadBefore = process.threadCpuUsage();
  const loadBefore = os.loadavg();
  const started = performance.now();
  await withCliProcessScope(() =>
    withCliCommandCleanup(false, async (cleanup) => {
      const pluginResources = cleanup?.pluginResources;
      assert.ok(pluginResources, "Benchmark requires executable CLI cleanup");
      try {
        await pluginResources.run(() =>
          updateMigrateCommand(path.join(root, "recovery", "native")),
        );
      } finally {
        await closeCliResources(cleanup);
        await pluginResources.release();
      }
    }),
  );
  const elapsedMs = performance.now() - started;
  const cpu = process.cpuUsage(before);
  const mainThreadCpu = process.threadCpuUsage(threadBefore);
  const memory = process.memoryUsage();
  const maxRssKiB = process.resourceUsage().maxRSS;
  let allocatedBytes: number | undefined;
  if (sampling) {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    allocatedBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
    inspector.disconnect();
  }
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  observer.disconnect();
  assert.deepEqual(
    readCanonicalContent(),
    contentBefore,
    "Migration changed retained transcript content",
  );
  const summary = {
    mode: sampling ? "allocation" : "timing",
    elapsedMs,
    cpu,
    mainThreadCpu,
    allocatedBytes,
    gcMs,
    gcCount,
    memory,
    maxRssKiB,
    loadBefore,
    loadAfter: os.loadavg(),
    fixture: JSON.parse(fs.readFileSync(path.join(root, "fixture.json"), "utf8")),
  };
  fs.writeFileSync(path.join(root, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
}

function readCanonicalContent() {
  const fixture = JSON.parse(fs.readFileSync(path.join(root, "fixture.json"), "utf8"));
  return Array.from({ length: fixture.agents }, (_, index) => {
    using db = new DatabaseSync(
      path.join(stateDir, "agents", `synthetic-${index}`, "agent", "openclaw-agent.sqlite"),
      { readOnly: true },
    );
    const archives = [];
    for (const row of db
      .prepare(
        "SELECT session_id,generation,archive_blob,archive_sha256 FROM session_transcript_archives ORDER BY session_id,generation",
      )
      .iterate()) {
      const { archive_blob: bytes, ...metadata } = row;
      assert.ok(bytes instanceof Uint8Array);
      archives.push({
        ...metadata,
        actualSha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
    return {
      sessions: db.prepare("SELECT count(*) AS count FROM session_nodes").get(),
      transcripts: db
        .prepare("SELECT session_id,seq,event_json FROM transcript_events ORDER BY session_id,seq")
        .all(),
      archives,
    };
  });
}
