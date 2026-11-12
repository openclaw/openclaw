// Measure warm ordinary reads over 5,000 synthetic sessions in isolated baseline/candidate processes.
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-reader-preparation-measure.mjs
//   --checkout <checkout> --root <new-synthetic-directory> --iterations 1000 --serve
// Each server accepts one JSON command per line: {"warmup":true}, {"mode":"count"}, {"mode":"timing"},
// {"mode":"allocation"}, or {"stop":true}. Alternate A1/B/A2 for five rounds per mode.
// --alias exercises a symlink locator. Startup is excluded; no real state is read or copied.
// --operation source retains a physical reader; transcript uses its admitted reader; reaction writes.
// reply prepares a fingerprint asynchronously, then checks its retained caller authority five times.
// auth-health/store/inline exercise real writes; count mode covers every path in their synthetic state root.
// admission reserves an unadmitted copy through the real writer owner without running SQL.
// trajectory persists one runtime event per flush; final verification checks every durable row.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { syncBuiltinESMExports } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    alias: { type: "boolean" },
    operation: { type: "string", default: "read" },
    serve: { type: "boolean" },
    checkout: { type: "string" },
    mode: { type: "string", default: "timing" },
    iterations: { type: "string", default: "1000" },
  },
});
assert(values.root && global.gc, "Use --root and --expose-gc");
assert(["count", "timing", "allocation"].includes(values.mode));
assert(
  [
    "read",
    "source",
    "transcript",
    "reaction",
    "reply",
    "admission",
    "trajectory",
    "talk",
    "auth-health",
    "auth-store",
    "auth-inline",
  ].includes(values.operation),
);
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
const root = path.resolve(values.root);
fs.mkdirSync(root);
process.env.OPENCLAW_STATE_DIR = root;
assert(values.checkout);
const checkout = path.resolve(values.checkout);
const load = (relative) => import(pathToFileURL(path.join(checkout, relative)).href);
const source = [
  "src/config/sessions/session-cold-storage.ts",
  "src/config/sessions/session-store-target-runtime.ts",
  "src/config/sessions/session-store-target-inventory.ts",
  "src/config/sessions/session-entry-read-runtime.ts",
  "src/config/sessions/session-entry-read-source.ts",
  "src/config/sessions/session-transcript-worker-runtime.ts",
  "src/state/openclaw-agent-db-validation-cache.ts",
  "src/state/openclaw-agent-write-admission.ts",
  "src/state/openclaw-agent-write-admission-state.ts",
  "src/config/sessions/session-entry-read-ordered.ts",
  "src/config/sessions/session-accessor.sqlite-entry-admission.ts",
  "src/config/sessions/session-transcript-read-source.ts",
  "src/config/sessions/session-reaction-store.ts",
  "src/state/openclaw-agent-execution.worker.ts",
  "src/state/openclaw-agent-execution-domain.ts",
  "src/infra/sqlite-writer-admission-client.ts",
  "src/state/openclaw-agent-execution.ts",
  "src/state/openclaw-agent-execution-owner.ts",
  "src/state/openclaw-agent-execution-native.ts",
  "src/state/openclaw-agent-execution-preparation.ts",
  "src/state/openclaw-agent-execution-scope.ts",
  "src/state/openclaw-agent-execution-contract.ts",
  "src/state/openclaw-state-db-async-lifecycle.ts",
  "src/state/openclaw-state-worker-context.capture.ts",
  "src/state/openclaw-state-worker-context.ts",
  "src/agents/auth-profiles/usage-write.ts",
  "src/agents/auth-profiles/store-update.ts",
  "src/agents/auth-profiles/inline-usage.ts",
  "src/agents/auth-profiles/sqlite-read.ts",
  "src/agents/auth-profiles/candidate-stores.ts",
  "src/agents/auth-profiles/write-execution.ts",
  "src/agents/auth-profiles/store-updater.ts",
  "src/agents/auth-profiles/file-state.ts",
  "src/agents/auth-profiles/persisted-rows-receipt.ts",
  "src/agents/auth-profiles/runtime-persisted-rows.ts",
  "src/agents/auth-profiles/runtime-snapshots.ts",
  "src/agents/auth-profiles/shared-store-bootstrap-async.ts",
  "src/agents/auth-profiles/sqlite.ts",
  "src/agents/auth-profiles/store-update-commit.ts",
  "src/agents/auth-profiles/store.ts",
  "src/agents/auth-profiles/types.ts",
  "src/agents/auth-profiles/upsert-with-lock.ts",
  "src/gateway/session-utils-store-worker.ts",
  "src/auto-reply/reply/reply-tool-authority.ts",
  "src/auto-reply/reply/reply-tool-authority-cohort.ts",
  "src/agents/harness/host-private-capabilities.ts",
  "src/talk/client-voice-session-source.ts",
  "src/talk/client-voice-session-write.ts",
  "src/talk/client-voice-session.ts",
  "src/talk/client-voice-mutation-digest-owner.ts",
  "src/trajectory/runtime-store-writer.ts",
  "src/trajectory/runtime-retention.ts",
  "src/infra/sqlite-readonly-worker.ts",
]
  .map((name) => {
    const filename = path.join(checkout, name);
    return `${name}:\n${["write-execution.ts", "store-updater.ts"].includes(path.basename(name)) && !fs.existsSync(filename) ? "absent" : fs.readFileSync(filename, "utf8")}`;
  })
  .join("\n");
const { applyLoggingConfig, flushLogger } = await load("src/logging/logger.ts");
applyLoggingConfig({
  level: "error",
  file: path.join(root, "measure.log"),
  consoleLevel: "silent",
});
const {
  openOpenClawAgentDatabase,
  closeOpenClawAgentDatabasesAsync,
  runOpenClawAgentWriteTransaction,
} = await load("src/state/openclaw-agent-db.ts");
const { closeOpenClawStateDatabaseAsync } = await load("src/state/openclaw-state-db.ts");
const { writeSessionEntry } = await load(
  "src/config/sessions/session-accessor.sqlite-entry-store.ts",
);
const { withSessionEntriesFromStoreInWorker, withSessionStoreReaderInWorker } = await load(
  "src/config/sessions/session-entry-read-runtime.ts",
);
const options = { agentId: "synthetic", env: { OPENCLAW_STATE_DIR: root } };
const seeded = openOpenClawAgentDatabase(options);
runOpenClawAgentWriteTransaction((database) => {
  for (let i = 0; i < 5000; i++) {
    writeSessionEntry(database, `agent:synthetic:session-${i}`, {
      sessionId: `synthetic-${i}`,
      updatedAt: i + 1,
    });
  }
}, options);
if (values.operation === "reaction") {
  const { resolveSqliteTranscriptScope } = await load(
    "src/config/sessions/session-accessor.sqlite-scope.ts",
  );
  const { replaceSqliteTranscriptEventsInTransaction } = await load(
    "src/config/sessions/session-accessor.sqlite-transcript-store.ts",
  );
  const scope = resolveSqliteTranscriptScope({
    ...options,
    storePath: seeded.path,
    sessionKey: "agent:synthetic:session-42",
    sessionId: "synthetic-42",
  });
  runOpenClawAgentWriteTransaction(
    (database) =>
      replaceSqliteTranscriptEventsInTransaction(database, scope, [
        { type: "session", id: "synthetic-42", version: 3 },
        {
          type: "message",
          id: "synthetic-message",
          parentId: null,
          message: { role: "user", content: "Synthetic measurement" },
        },
      ]),
    options,
  );
}
await closeOpenClawAgentDatabasesAsync();
const databasePath =
  values.operation === "admission" ? path.join(root, "unadmitted.sqlite") : seeded.path;
if (values.operation === "admission") {
  fs.copyFileSync(seeded.path, databasePath);
}
const readPath = values.alias ? path.join(root, "selected.sqlite") : databasePath;
if (values.alias) {
  fs.symlinkSync(databasePath, readPath);
}
let active = false;
let syncCalls = 0;
let realpathCalls = 0;
const realpath = fs.realpathSync.native;
const countRealpath = function (...args) {
  if (
    active &&
    (values.operation.startsWith("auth-")
      ? String(args[0]).startsWith(root)
      : args[0] === databasePath || args[0] === readPath)
  ) {
    realpathCalls++;
  }
  return Reflect.apply(realpath, this, args);
};
const stat = fs.statSync;
const countStat = function (...args) {
  if (
    active &&
    (values.operation.startsWith("auth-")
      ? String(args[0]).startsWith(root)
      : args[0] === databasePath || args[0] === readPath)
  ) {
    syncCalls++;
  }
  return Reflect.apply(stat, this, args);
};
let cycle = () =>
  withSessionEntriesFromStoreInWorker(
    {
      ...options,
      storePath: readPath,
      sessionKeys: ["agent:synthetic:session-42"],
      projection: "list",
    },
    async (read) => assert.equal(read.result.entries[0]?.entry.sessionId, "synthetic-42"),
  );
if (values.operation === "source") {
  cycle = () =>
    withSessionStoreReaderInWorker(
      { ...options, storePath: readPath },
      async ({ reader, assertCurrent }) => {
        const result = await reader.readExactEntries({
          sessionKeys: ["agent:synthetic:session-42"],
          env: options.env,
        });
        assert.equal(result.entries[0]?.entry.sessionId, "synthetic-42");
        for (let index = 0; index < 5; index++) {
          assertCurrent();
        }
      },
      { capturePhysicalSource: true },
    );
}
let releaseTranscript = async () => {};
let closeReply = () => {};
if (values.operation === "admission") {
  const { runOpenClawAgentWorkerWrite } = await load("src/state/openclaw-agent-write-admission.ts");
  cycle = async () => {
    let admitted = false;
    await runOpenClawAgentWorkerWrite({ ...options, path: readPath }, async () => {
      admitted = true;
    });
    assert(admitted);
  };
}
if (values.operation === "reply") {
  const { setRuntimeConfigSnapshot } = await load("src/config/runtime-snapshot.ts");
  const { prepareReplyToolAuthority } = await load("src/auto-reply/reply/reply-tool-authority.ts");
  const { prepareReplyToolAuthorityCallerRead } = await load(
    "src/agents/harness/host-private-capabilities.ts",
  );
  const config = { agents: { entries: { synthetic: {} } }, session: { store: readPath } };
  setRuntimeConfigSnapshot(config);
  const authority = prepareReplyToolAuthority({
    run: {
      agentId: "synthetic",
      sessionKey: "agent:synthetic:session-42",
      sessionId: "synthetic-42",
      sessionFile: path.join(root, "session.jsonl"),
      workspaceDir: root,
      config,
      provider: "openai",
      model: "synthetic-model",
      timeoutMs: 10_000,
    },
  });
  const initial = await authority.fingerprintAsync();
  const caller = await prepareReplyToolAuthorityCallerRead(
    authority.projectAsync,
    undefined,
    initial,
    undefined,
    () => {},
  );
  assert(caller);
  const retained = caller.retainCurrent();
  closeReply = () => {
    retained.release();
    authority.close();
  };
  cycle = async () => {
    const fingerprint = await authority.fingerprintAsync();
    for (let index = 0; index < 5; index++) {
      retained.assertCurrent();
    }
    assert.equal(fingerprint, initial);
  };
}
if (values.operation === "transcript") {
  const { loadSessionEntryForAdmission } = await load(
    "src/config/sessions/session-accessor.sqlite-entry-admission.ts",
  );
  const { withOwnedSessionTranscriptWrites } = await load(
    "src/config/sessions/transcript-write-context.ts",
  );
  const { readSessionTranscriptWatermarkAsync } = await load(
    "src/config/sessions/session-transcript-watermark.ts",
  );
  const scope = {
    ...options,
    storePath: readPath,
    sessionKey: "agent:synthetic:session-42",
    sessionId: "synthetic-42",
  };
  const { databaseClaim } = await loadSessionEntryForAdmission(scope);
  assert(databaseClaim.kind === "worker" && databaseClaim.reader);
  releaseTranscript = () => databaseClaim.release();
  cycle = () =>
    withOwnedSessionTranscriptWrites(
      {
        sessionTarget: scope,
        sessionReader: databaseClaim.reader,
        withTranscriptWrite: (write) => write(),
      },
      async () => assert.equal((await readSessionTranscriptWatermarkAsync(scope)).maxSeq, null),
    );
}
let sequence = 0;
const { setSessionReactionAsync } =
  values.operation === "reaction"
    ? await load("src/config/sessions/session-reaction-store.ts")
    : {};
if (values.operation === "reaction") {
  cycle = async () => {
    const result = await setSessionReactionAsync(
      { ...options, storePath: readPath, sessionKey: "agent:synthetic:session-42" },
      {
        messageId: "synthetic-message",
        emoji: "👍",
        identityId: "synthetic-reader",
        expectedSessionId: "synthetic-42",
        remove: ++sequence % 2 === 0,
      },
    );
    assert.equal(result.changed, true);
  };
}
if (values.operation.startsWith("auth-")) {
  const { setRuntimeConfigSnapshot } = await load("src/config/io.ts");
  const config = { agents: { entries: { main: {}, synthetic: {} } } };
  setRuntimeConfigSnapshot(config, config);
  const { saveAuthProfileStore, updateAuthProfileStoreWithLock } = await load(
    "src/agents/auth-profiles/store-runtime.ts",
  );
  const { setRuntimeAuthProfileStoreSnapshot } = await load(
    "src/agents/auth-profiles/runtime-snapshots.ts",
  );
  const { markAuthProfileFailure } = await load("src/agents/auth-profiles/usage.ts");
  const { persistInlineAuthFailure } = await load("src/agents/auth-profiles/inline-usage.ts");
  const { resolveAgentDir } = await load("src/agents/agent-scope.ts");
  resolveAgentDir(config, "main", options.env);
  const agentDir = resolveAgentDir(config, "synthetic", options.env);
  assert.equal(agentDir, path.dirname(seeded.path));
  const store = {
    version: 1,
    profiles: { selected: { type: "api_key", provider: "fixture", key: "synthetic" } },
  };
  const saveOptions = { filterExternalAuthProfiles: false, syncExternalCli: false };
  saveAuthProfileStore(store, agentDir, saveOptions);
  setRuntimeAuthProfileStoreSnapshot(store, agentDir);
  // Keep idle server setup inside the existing ten-minute failure window.
  cycle = async () => {
    if (values.operation === "auth-health") {
      await markAuthProfileFailure({
        store,
        profileId: "selected",
        reason: "auth_permanent",
        agentDir,
      });
      assert.equal(store.usageStats.selected.errorCount, ++sequence);
    } else if (values.operation === "auth-inline") {
      const receipt = await persistInlineAuthFailure(agentDir, {
        provider: "fixture",
        reason: "auth_permanent",
      });
      assert.equal(receipt.store.usageStats["inline-api-key:fixture"].errorCount, ++sequence);
    } else {
      const order = ++sequence % 2 ? ["selected"] : [];
      const updated = await updateAuthProfileStoreWithLock({
        agentDir,
        saveOptions,
        updater(current) {
          current.order = { fixture: order };
          return true;
        },
      });
      assert.deepEqual(updated.order.fixture, order);
    }
  };
}
let verifyTrajectory = async () => {};
if (values.operation === "trajectory") {
  const { createSqliteTrajectoryRuntimeSink } = await load(
    "src/trajectory/runtime-store-writer.ts",
  );
  const { loadSqliteTrajectoryRuntimeEvents } = await load(
    "src/trajectory/runtime-store.sqlite.ts",
  );
  const target = {
    ...options,
    storePath: readPath,
    sessionKey: "agent:synthetic:session-42",
    sessionId: "synthetic-42",
  };
  const sink = await createSqliteTrajectoryRuntimeSink({
    env: options.env,
    sessionId: target.sessionId,
    sessionTarget: target,
    maxRuntimeFileBytes: 1024 * 1024 * 1024,
  });
  assert(sink);
  cycle = async () => {
    const event = {
      traceSchema: "openclaw-trajectory",
      schemaVersion: 1,
      traceId: "synthetic-trajectory",
      source: "runtime",
      type: "tool.call",
      ts: new Date().toISOString(),
      seq: ++sequence,
      sourceSeq: sequence,
      sessionId: target.sessionId,
      sessionKey: target.sessionKey,
      runId: "synthetic-run",
      data: { tool: "synthetic", input: "synthetic input" },
    };
    sink.write(event, JSON.stringify(event));
    await sink.flush();
    assert.equal(sink.describeFlushState(), undefined);
  };
  verifyTrajectory = async () => {
    const events = await loadSqliteTrajectoryRuntimeEvents(target);
    assert.equal(events.length, sequence);
    assert.equal(events.at(-1)?.seq, sequence);
  };
}
let verifyTalk = () => {};
if (values.operation === "talk") {
  const { setRuntimeConfigSnapshot } = await load("src/config/runtime-snapshot.ts");
  setRuntimeConfigSnapshot({ agents: { entries: { synthetic: {} } } });
  const { createOrResumeClientVoiceSession, appendClientVoiceTranscript, closeClientVoiceSession } =
    await load("src/talk/client-voice-session.ts");
  const { readVoiceSessionRecord } = await load("src/talk/client-voice-session-store.ts");
  const { prepareClientVoiceSessionClose } = await load(
    "src/talk/client-voice-session-lifecycle.ts",
  );
  const target = { agentId: options.agentId, sessionKey: "agent:synthetic:session-42" };
  cycle = async () => {
    const cleanup = prepareClientVoiceSessionClose();
    const voiceSessionId = `synthetic-voice-${++sequence}`;
    await createOrResumeClientVoiceSession({ ...target, voiceSessionId, origin: "client" });
    await createOrResumeClientVoiceSession({ ...target, voiceSessionId, origin: "client" });
    await appendClientVoiceTranscript({
      ...target,
      sessionTarget: { sessionKey: target.sessionKey },
      voiceSessionId,
      entryId: "synthetic-entry",
      role: "user",
      text: "Synthetic voice measurement",
    });
    await closeClientVoiceSession({ ...target, voiceSessionId, config: {} });
    await cleanup.drain();
  };
  verifyTalk = () => {
    for (let index = 1; index <= sequence; index++) {
      const record = readVoiceSessionRecord(options.agentId, `synthetic-voice-${index}`, options);
      assert.equal(record?.status, "closed");
      assert.equal(record.hasUserTranscript, true);
    }
  };
}
const inspector = new Session();
async function measure(mode) {
  assert(["count", "timing", "allocation"].includes(mode));
  fs.statSync = mode === "count" ? countStat : stat;
  fs.realpathSync.native = mode === "count" ? countRealpath : realpath;
  syncBuiltinESMExports();
  syncCalls = 0;
  realpathCalls = 0;
  global.gc();
  if (mode === "allocation") {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const cpu = process.cpuUsage();
  const thread = process.threadCpuUsage();
  const started = performance.now();
  active = true;
  for (let i = 0; i < iterations; i++) {
    await cycle();
  }
  active = false;
  const elapsedMs = performance.now() - started;
  const threadCpu = process.threadCpuUsage(thread);
  const processCpu = process.cpuUsage(cpu);
  let bytes;
  if (mode === "allocation") {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const sum = (node) =>
      node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
    bytes = sum(profile.head) / iterations;
    inspector.disconnect();
  }
  return {
    mode,
    alias: values.alias ?? false,
    operation: values.operation,
    sourceSha256: createHash("sha256").update(source).digest("hex"),
    iterations,
    sessions: 5000,
    ...(mode === "count"
      ? { syncCalls, realpathCalls }
      : {
          elapsedMs: elapsedMs / iterations,
          threadUs: (threadCpu.user + threadCpu.system) / iterations,
          processUs: (processCpu.user + processCpu.system) / iterations,
          bytes,
        }),
    load: loadavg(),
  };
}
try {
  for (let i = 0; i < 50; i++) {
    await cycle();
  }
  if (values.serve) {
    console.log(JSON.stringify({ ready: true }));
    const commands = createInterface({ input: process.stdin });
    for await (const line of commands) {
      const command = JSON.parse(line);
      if (command.stop) {
        break;
      }
      if (command.warmup) {
        for (let i = 0; i < 50; i++) {
          await cycle();
        }
        console.log(JSON.stringify({ ready: true }));
      } else {
        console.log(JSON.stringify(await measure(command.mode)));
      }
    }
    commands.close();
  } else {
    console.log(JSON.stringify(await measure(values.mode)));
  }
  await verifyTrajectory();
  verifyTalk();
} finally {
  active = false;
  fs.statSync = stat;
  fs.realpathSync.native = realpath;
  syncBuiltinESMExports();
  closeReply();
  await releaseTranscript();
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  await flushLogger();
  fs.rmSync(root, { recursive: true, force: true });
}
