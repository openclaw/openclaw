/**
 * Public sessions.delete on a synthetic 10,800-session fixture, 40 bundled plugins,
 * archived dashboards with live worktrees. No production target or models.
 * node --import ./scripts/tsx.mjs scripts/perf/session-delete-measure.ts --state-dir .local/delete-base --seed --samples 7 --worktree-files 60000
 * node --import ./scripts/tsx.mjs scripts/perf/session-delete-measure.ts --state-dir .local/delete-base --samples 7 --phases
 * Each target adds 300 tool calls over ten minutes, 32 KiB incompressible results,
 * and matching trajectory events (~10 MiB of each). --tool-calls and --tool-result-bytes
 * change that shape. --removed-worktrees models prior cleanup instead of live removal.
 * Repeat with fresh state and the other built revision; keep first cold request separate.
 * --phases instruments built owner functions and records worker fsyncs: diagnostic only.
 * Phase durations nest; do not sum them. This is a deletion workload, not the canonical
 * ten-minute Team stress campaign. Reply and registry cleanup completion are timed separately.
 * Add --crash-after-delete --samples 1 on fresh state to kill after the committed reply,
 * before snapshotting, then restart and prove lossless GC recovery. This mode is not timing data.
 * Transcript exports and dirty worktree snapshot bytes are verified exactly.
 */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createCipheriv, createHash } from "node:crypto";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  createWriteStream,
  statSync,
} from "node:fs";
import { loadavg } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type {
  WorktreesListResult,
  WorktreesGcResult,
} from "../../packages/gateway-protocol/src/schema/worktrees.ts";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.ts";
import type { TranscriptEvent } from "../../src/config/sessions/session-accessor.sqlite-contract.js";
import { stopChild } from "../lib/gateway-bench-child.ts";
import { getFreePort } from "../lib/gateway-bench-probes.ts";
import { buildGatewayBenchChildArgs, createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "../lib/gateway-ws-client.ts";
import {
  generateTeamShapeStressFixture,
  TEAM_STRESS_PLUGIN_IDS,
} from "./team-shape-stress-fixture.ts";
const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    seed: { type: "boolean" },
    phases: { type: "boolean" },
    "crash-after-delete": { type: "boolean" },
    samples: { type: "string", default: "7" },
    "tool-calls": { type: "string", default: "300" },
    "tool-result-bytes": { type: "string", default: "32768" },
    "worktree-files": { type: "string", default: "0" },
    "removed-worktrees": { type: "boolean" },
    entry: { type: "string", default: "dist/entry.js" },
  },
});
assert(values["state-dir"], "--state-dir is required");
const root = path.resolve(values["state-dir"]);
const samples = Number(values.samples);
assert(Number.isSafeInteger(samples) && samples > 0 && samples <= 100, "samples must be 1..100");
const crashAfterDelete = values["crash-after-delete"] ?? false;
const phasesEnabled = values.phases || crashAfterDelete;
assert(
  !crashAfterDelete || (samples === 1 && process.platform !== "win32"),
  "crash proof requires --samples 1 on POSIX",
);
assert(!crashAfterDelete || !values["removed-worktrees"], "crash proof requires a live worktree");
const dirtyName = "delete-recovery-draft.txt";
const dirtyBytes = (index: number) =>
  Buffer.from(`Uncommitted tool-heavy session ${index}: preserve these exact bytes.\n`);
const toolCalls = Number(values["tool-calls"]);
const toolResultBytes = Number(values["tool-result-bytes"]);
const worktreeFiles = Number(values["worktree-files"]);
assert(Number.isSafeInteger(toolCalls) && toolCalls >= 0 && toolCalls <= 3000);
assert(Number.isSafeInteger(toolResultBytes) && toolResultBytes >= 0 && toolResultBytes <= 262144);
assert(Number.isSafeInteger(worktreeFiles) && worktreeFiles >= 0 && worktreeFiles <= 100000);
assert(
  samples * toolCalls * toolResultBytes * 2 <= 1024 ** 3,
  "fixture payloads must fit in 1 GiB",
);
const storePath = path.join(root, "agents", "main", "sessions", "sessions.json");
const targetScope = (index: number) => ({
  sessionKey: `agent:main:dashboard:${(index + 1).toString(16).padStart(8, "0")}-1659-4000-8000-000000000001`,
  sessionId: `team-shape-session-${index}`,
  storePath,
});
let port = await getFreePort();
while (port < 40000) {
  port = await getFreePort();
}
if (values.seed) {
  const { summary, env } = await generateTeamShapeStressFixture({
    stateDir: root,
    port,
    seed: 1841,
    now: 1792998000000,
    sessions: 10800,
    transcriptMiB: 128,
    worktreeFiles,
    worktreeFileBytes: 128,
  });
  const { runOpenClawStateWriteTransaction, closeOpenClawStateDatabaseAsync } =
    await import("../../src/state/openclaw-state-db.ts");
  const { updateRegistryWorktreeInDatabase, insertRegistryWorktreeInDatabase } =
    await import("../../src/agents/worktrees/registry-run-end.worker.ts");
  const { resolveRepositoryIdentity } =
    await import("../../src/agents/worktrees/repository-paths.ts");
  const {
    runOpenClawAgentWriteTransaction,
    openOpenClawAgentDatabase,
    closeOpenClawAgentDatabasesAsync,
  } = await import("../../src/state/openclaw-agent-db.ts");
  const { writeSessionEntry, readExactSessionEntryRow } =
    await import("../../src/config/sessions/session-accessor.sqlite-entry-store.ts");
  const { appendTranscriptEventsInTransaction } =
    await import("../../src/config/sessions/session-accessor.sqlite-transcript-store.ts");
  const { appendSqliteTrajectoryRuntimeEventsWithWriter } =
    await import("../../src/trajectory/runtime-store.sqlite.ts");
  const { loadTranscriptEvents } = await import("../../src/config/sessions/session-accessor.ts");
  const databaseOptions = { agentId: "main", env };
  const project = summary.projectWorktrees[0]!;
  const repository = await resolveRepositoryIdentity(project.repoRoot);
  const cipher = createCipheriv(
    "aes-256-ctr",
    createHash("sha256").update("delete-tool-fixture").digest(),
    Buffer.alloc(16),
  );
  const zeros = Buffer.alloc(Math.ceil((toolResultBytes * 3) / 4));
  for (let index = 700; index < 700 + samples; index++) {
    const scope = targetScope(index);
    const id = `delete-worktree-${index}`;
    const branch = `fixture/delete-${index}`;
    const worktreePath = path.join(root, "fixture-worktrees", id);
    execFileSync(
      "git",
      ["-C", project.repoRoot, "worktree", "add", "-b", branch, worktreePath, "main"],
      { env, stdio: "pipe" },
    );
    if (!values["removed-worktrees"]) {
      writeFileSync(path.join(worktreePath, dirtyName), dirtyBytes(index));
    }
    runOpenClawStateWriteTransaction(
      ({ db }) =>
        insertRegistryWorktreeInDatabase(db, {
          record: {
            id,
            name: id,
            branch,
            path: worktreePath,
            baseRef: "main",
            repoRoot: repository.repoRoot,
            repoFingerprint: repository.fingerprint,
            ownerKind: "session",
            ownerId: scope.sessionKey,
            createdAt: summary.now - 600000,
            lastActiveAt: summary.now,
          },
          provisionedPaths: [],
        }),
      { env },
    );
    runOpenClawAgentWriteTransaction((database) => {
      const row = readExactSessionEntryRow(database, scope.sessionKey);
      assert(row);
      writeSessionEntry(
        database,
        scope.sessionKey,
        {
          ...row.entry,
          archivedAt: summary.now,
          spawnedCwd: worktreePath,
          spawnedWorkspaceDir: project.repoRoot,
          worktree: { id, branch, repoRoot: project.repoRoot },
        },
        { canonicalPreviousEntry: row.entry, canonicalPreviousRow: row.row },
      );
    }, databaseOptions);
    const previous = (await loadTranscriptEvents({ ...scope, env })).at(-1);
    let parentId =
      previous &&
      typeof previous === "object" &&
      "id" in previous &&
      typeof previous.id === "string"
        ? previous.id
        : null;
    for (let offset = 0; offset < toolCalls; offset += 20) {
      const transcript: TranscriptEvent[] = [];
      const trajectory = [];
      for (let call = offset; call < Math.min(offset + 20, toolCalls); call++) {
        const timestamp = summary.now - 600000 + Math.floor((call * 600000) / toolCalls);
        const ts = new Date(timestamp).toISOString();
        const callId = `tool-${index}-${call}`;
        const result = cipher.update(zeros).toString("base64").slice(0, toolResultBytes);
        for (const [suffix, message] of [
          [
            "call",
            {
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  id: callId,
                  name: "exec",
                  arguments: { command: `synthetic-check ${call}` },
                },
              ],
              timestamp,
            },
          ],
          [
            "result",
            {
              role: "toolResult",
              toolCallId: callId,
              toolName: "exec",
              content: [{ type: "text", text: result }],
              isError: false,
              timestamp,
            },
          ],
        ] as const) {
          const eventId = `${callId}-${suffix}`;
          transcript.push({ type: "message", id: eventId, parentId, timestamp: ts, message });
          parentId = eventId;
          trajectory.push({
            runId: `delete-run-${index}`,
            ts,
            line: JSON.stringify({
              traceSchema: "openclaw-trajectory",
              schemaVersion: 1,
              traceId: scope.sessionId,
              source: "runtime",
              type: suffix === "call" ? "tool.start" : "tool.end",
              ts,
              seq: call * 2 + Number(suffix === "result"),
              sessionId: scope.sessionId,
              sessionKey: scope.sessionKey,
              runId: `delete-run-${index}`,
              data: message,
            }),
          });
        }
      }
      runOpenClawAgentWriteTransaction(
        (database) =>
          appendTranscriptEventsInTransaction(
            database,
            { ...scope, ...databaseOptions },
            transcript,
          ),
        databaseOptions,
      );
      appendSqliteTrajectoryRuntimeEventsWithWriter(
        { sessionId: scope.sessionId, events: trajectory },
        openOpenClawAgentDatabase(databaseOptions),
        (label, write) =>
          runOpenClawAgentWriteTransaction(write, databaseOptions, { operationLabel: label }),
      );
    }
    if (values["removed-worktrees"]) {
      execFileSync("git", ["-C", project.repoRoot, "worktree", "remove", worktreePath], { env });
      runOpenClawStateWriteTransaction(
        ({ db }) => updateRegistryWorktreeInDatabase(db, { id, patch: { removedAt: summary.now } }),
        { env },
      );
    }
  }
  cipher.final();
  for (const worktree of summary.projectWorktrees) {
    execFileSync("git", ["-C", worktree.repoRoot, "worktree", "remove", worktree.path], { env });
    runOpenClawStateWriteTransaction(
      ({ db }) =>
        updateRegistryWorktreeInDatabase(db, {
          id: worktree.id,
          patch: { removedAt: summary.now },
        }),
      { env },
    );
  }
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  const shape = {
    samples,
    toolCalls,
    toolResultBytes,
    worktreeFiles,
    removedWorktrees: values["removed-worktrees"] ?? false,
  };
  writeFileSync(path.join(root, "delete-shape.json"), JSON.stringify(shape));
  console.log(JSON.stringify({ ...summary, deleteShape: shape }));
  process.exit(0);
}
const fixture = JSON.parse(readFileSync(path.join(root, "team-shape-summary.json"), "utf8"));
assert(
  fixture.format === "openclaw-team-shape-v1" && fixture.sessionCount === 10800,
  "requires the synthetic fixture",
);
const shape = JSON.parse(readFileSync(path.join(root, "delete-shape.json"), "utf8"));
assert(!crashAfterDelete || !shape.removedWorktrees, "crash proof requires a live fixture");
const output = path.join(root, `delete-${Date.now()}`);
const snapshotBarrier = path.join(output, "before-snapshot");
mkdirSync(output);
const cfg = JSON.parse(readFileSync(path.join(root, "openclaw.json"), "utf8"));
cfg.plugins = {
  ...cfg.plugins,
  enabled: true,
  allow: [...TEAM_STRESS_PLUGIN_IDS],
  entries: Object.fromEntries(TEAM_STRESS_PLUGIN_IDS.map((id) => [id, { enabled: true }])),
};
writeFileSync(path.join(output, "openclaw.json"), JSON.stringify(cfg));
const preload = fileURLToPath(new URL("./session-delete-phases-loader.mjs", import.meta.url));
const env = createGatewayBenchEnv(path.join(root, "home"), path.join(output, "openclaw.json"), {
  startupTrace: false,
  caseEnv: {
    OPENCLAW_STATE_DIR: root,
    OPENCLAW_PROFILE: "delete-benchmark",
    TMPDIR: path.join(root, "tmp"),
    OPENCLAW_SKIP_CHANNELS: "1",
    OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway-delete-benchmark",
    OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.delete-benchmark",
    ...(phasesEnabled
      ? { NODE_OPTIONS: `--import=${preload}`, OPENCLAW_DELETE_PHASE_OUTPUT: output }
      : {}),
    ...(crashAfterDelete ? { OPENCLAW_DELETE_SNAPSHOT_BARRIER: snapshotBarrier } : {}),
  },
});
Object.assign(process.env, {
  OPENCLAW_STATE_DIR: root,
  OPENCLAW_CONFIG_PATH: path.join(output, "openclaw.json"),
});
const { loadTranscriptEvents, loadSessionEntry } =
  await import("../../src/config/sessions/session-accessor.ts");
const { readSessionArchiveContentSync } =
  await import("../../src/config/sessions/archive-compression.ts");
const { closeOpenClawAgentDatabasesAsync } = await import("../../src/state/openclaw-agent-db.ts");
const { loadSqliteTrajectoryRuntimeEventRowsSync } =
  await import("../../src/trajectory/runtime-store.sqlite.ts");
const { readSessionColdMetadataInWorker } =
  await import("../../src/config/sessions/session-cold-storage-read.worker.ts");
const targets = [];
for (let index = 700; index < 700 + samples; index++) {
  const scope = targetScope(index);
  assert.equal(
    readSessionColdMetadataInWorker({ agentId: "main", env }, scope.sessionId),
    undefined,
    "this fixture measures hot archived transcripts; expected-byte reads must not restore cold state",
  );
  const events = await loadTranscriptEvents(scope);
  assert(events.length > 0, "fresh transcript required");
  const hash = createHash("sha256");
  let bytes = 0;
  for (const event of events) {
    const line = `${JSON.stringify(event)}\n`;
    hash.update(line);
    bytes += Buffer.byteLength(line);
  }
  const trajectory = loadSqliteTrajectoryRuntimeEventRowsSync(scope);
  targets.push({
    index,
    id: `delete-worktree-${index}`,
    worktreePath: path.join(root, "fixture-worktrees", `delete-worktree-${index}`),
    scope,
    sha256: hash.digest("hex"),
    transcriptBytes: bytes,
    transcriptRows: events.length,
    trajectoryRows: trajectory.length,
    trajectoryBytes: trajectory.reduce(
      (total, row) => total + Buffer.byteLength(JSON.stringify(row.event)) + 1,
      0,
    ),
  });
}
await closeOpenClawAgentDatabasesAsync();
const log = createWriteStream(path.join(output, "gateway.log"));
const launch = () => {
  const child = spawn(process.execPath, buildGatewayBenchChildArgs(values.entry, port), {
    detached: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env,
  });
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });
  return child;
};
let child = launch();
let client: ReturnType<typeof createGatewayWsClient> | undefined;
const results: Array<{
  key: string;
  ms: number;
  cleanupMs: number;
  crashRecovered: boolean;
  phases?: unknown;
  archived: string[];
  hostLoad: number[];
  startedAt: number;
  endedAt: number;
  walBytesBefore: number;
  walBytesAfter: number;
  transcriptBytes: number;
  transcriptRows: number;
  trajectoryRows: number;
  trajectoryBytes: number;
}> = [];
const walSize = () =>
  statSync(path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite-wal"), {
    throwIfNoEntry: false,
  })?.size ?? 0;
async function rpc(method: string, params: unknown) {
  const response = await client!.request(method, params, 120000);
  assert(response.ok, JSON.stringify({ method, error: response.error }));
  return response.payload;
}
async function connect() {
  const deadline = Date.now() + 180000;
  while (
    !(await fetch(`http://127.0.0.1:${port}/readyz`).then(
      (response) => response.ok,
      () => false,
    ))
  ) {
    if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline) {
      throw new Error(`Gateway setup failed: ${output}`);
    }
    await delay(500);
  }
  client = createGatewayWsClient({ url: `ws://127.0.0.1:${port}` });
  client.ws.on("error", () => {});
  await client.waitOpen();
  await rpc("connect", {
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    client: {
      id: "gateway-client",
      displayName: "synthetic-delete-measurement",
      version: "1.0.0",
      platform: process.platform,
      mode: "backend",
    },
    role: "operator",
    scopes: ["operator.read", "operator.admin"],
    caps: [],
  });
}
async function worktreeRecord(id: string) {
  const result = (await rpc("worktrees.list", {})) as WorktreesListResult;
  const record = result.worktrees.find((entry) => entry.id === id);
  assert(record, `missing retained worktree record: ${id}`);
  return record;
}
async function awaitCleanup(id: string) {
  const deadline = Date.now() + 120000;
  for (;;) {
    const record = await worktreeRecord(id);
    if (record.removedAt !== undefined) {
      assert(record.snapshotRef, "live fixture must be snapshotted before removal");
      return record;
    }
    assert(record.runEndCleanup?.outcome !== "failed", JSON.stringify(record.runEndCleanup));
    assert(Date.now() < deadline, `cleanup did not settle: ${id}`);
    await delay(100);
  }
}
try {
  await connect();
  await rpc("sessions.list", { limit: 10 });
  for (const target of targets) {
    if (phasesEnabled) {
      child.send({ channel: "delete-phase", action: "reset" });
    }
    const walBytesBefore = walSize();
    const startedAt = Date.now();
    const started = performance.now();
    const response = await rpc("sessions.delete", {
      key: target.scope.sessionKey,
      deleteTranscript: true,
      archivedOnly: true,
    });
    const ms = performance.now() - started;
    const endedAt = Date.now();
    const walBytesAfter = walSize();
    assert(
      response &&
        typeof response === "object" &&
        "deleted" in response &&
        response.deleted === true &&
        "archived" in response &&
        Array.isArray(response.archived),
      "delete must commit and return an archive",
    );
    assert(!("worktreePreserved" in response), "synthetic worktree removal must complete");
    const archived: string[] = response.archived;
    assert(
      archived.length === 1 &&
        createHash("sha256").update(readSessionArchiveContentSync(archived[0]!)).digest("hex") ===
          target.sha256,
      "archive must preserve exact transcript bytes",
    );
    if (crashAfterDelete) {
      const deadline = Date.now() + 30000;
      while (!existsSync(snapshotBarrier)) {
        assert(Date.now() < deadline, "snapshot barrier was not reached");
        await delay(25);
      }
      const before = await worktreeRecord(target.id);
      assert.equal(before.removedAt, undefined);
      assert.equal(before.snapshotRef, undefined);
      assert(
        readFileSync(path.join(target.worktreePath, dirtyName)).equals(dirtyBytes(target.index)),
      );
      assert(child.pid && child.exitCode === null && child.signalCode === null);
      const exited = once(child, "exit", { signal: AbortSignal.timeout(10000) });
      process.kill(-child.pid, "SIGKILL");
      await exited;
      client?.close();
      assert.equal(loadSessionEntry(target.scope), undefined, "delete must survive SIGKILL");
      assert(
        readFileSync(path.join(target.worktreePath, dirtyName)).equals(dirtyBytes(target.index)),
      );
      await closeOpenClawAgentDatabasesAsync();
      delete env.OPENCLAW_DELETE_SNAPSHOT_BARRIER;
      child = launch();
      await connect();
      const job = (await rpc("worktrees.gc", {})) as WorktreesGcResult;
      assert(job.jobId, "cleanup must have an owner-tracked receipt");
      let receipt = job;
      const recoveryDeadline = Date.now() + 180000;
      while (receipt.state === "queued" || receipt.state === "running") {
        assert(Date.now() < recoveryDeadline, "restart cleanup did not settle");
        // This mutation RPC permits 30 calls/minute, including receipt reads.
        await delay(2500);
        receipt = (await rpc("worktrees.gc", { jobId: job.jobId })) as WorktreesGcResult;
      }
      assert.equal(receipt.state, "completed", JSON.stringify(receipt));
      writeFileSync(
        path.join(output, "crash-recovery.json"),
        JSON.stringify(
          {
            killedBeforeSnapshot: true,
            durableDeleteVerified: true,
            dirtyBytesIntactAfterKill: true,
            receipt,
          },
          null,
          2,
        ),
      );
    }
    let cleanupMs = performance.now() - started;
    if (!shape.removedWorktrees) {
      const removed = await awaitCleanup(target.id);
      cleanupMs = performance.now() - started;
      assert.equal(existsSync(target.worktreePath), false, "original checkout must be retired");
      const recovered = execFileSync(
        "git",
        ["-C", removed.repoRoot, "show", `${removed.snapshotRef}:${dirtyName}`],
        { env },
      );
      assert(
        recovered.equals(dirtyBytes(target.index)),
        "snapshot must preserve exact dirty bytes",
      );
    }
    const phases = phasesEnabled
      ? await new Promise((resolve) => {
          const timer = setTimeout(() => {
            child.off("message", receive);
            resolve({ error: "phase capture timeout" });
          }, 5000);
          const receive = (message: unknown) => {
            if (
              message &&
              typeof message === "object" &&
              "channel" in message &&
              message.channel === "delete-phase"
            ) {
              clearTimeout(timer);
              child.off("message", receive);
              resolve(message);
            }
          };
          child.on("message", receive);
          child.send({ channel: "delete-phase", action: "snapshot" });
        })
      : undefined;
    results.push({
      key: target.scope.sessionKey,
      ms,
      cleanupMs,
      crashRecovered: crashAfterDelete,
      phases,
      archived,
      hostLoad: loadavg(),
      startedAt,
      endedAt,
      walBytesBefore,
      walBytesAfter,
      transcriptBytes: target.transcriptBytes,
      transcriptRows: target.transcriptRows,
      trajectoryRows: target.trajectoryRows,
      trajectoryBytes: target.trajectoryBytes,
    });
    writeFileSync(
      path.join(output, "result.json"),
      JSON.stringify(
        { entry: path.resolve(values.entry), diagnostic: phasesEnabled, samples: results },
        null,
        2,
      ),
    );
    console.log(
      JSON.stringify({ sample: results.length, ms, cleanupMs, crashRecovered: crashAfterDelete }),
    );
  }
} finally {
  client?.close();
  await stopChild(child, { teardownGraceMs: 10000 });
  log.end();
}
for (const target of targets) {
  assert(
    loadSessionEntry(target.scope) === undefined,
    "deleted entry must stay absent after shutdown",
  );
  assert.equal(
    loadSqliteTrajectoryRuntimeEventRowsSync(target.scope).length,
    0,
    "trajectory rows must be reclaimed",
  );
}
await closeOpenClawAgentDatabasesAsync();
console.log(`Verified exact archives and absent session entries: ${output}`);
