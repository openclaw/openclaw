// Measure warm ordinary reads over 5,000 synthetic sessions in isolated baseline/candidate processes.
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-reader-preparation-measure.mjs
//   --checkout <checkout> --root <new-synthetic-directory> --iterations 1000 --serve
// Each server accepts one JSON command per line: {"warmup":true}, {"mode":"count"}, {"mode":"timing"},
// {"mode":"allocation"}, or {"stop":true}. Alternate A1/B/A2 for five rounds per mode.
// --alias exercises a symlink locator. Initial setup is excluded; no real state is read or copied.
// This is source-mode: worker/loader startup reached inside a measured cycle remains included.
// --operation source retains a physical reader; transcript uses its admitted reader; reaction writes.
// detached-transcript reads watermark + stats without an ambient admitted reader, then joins cleanup.
// reply prepares a fingerprint asynchronously, then checks its retained caller authority five times.
// sharing acquires mutation facts under a real Gateway owner, checks the row and releases custody.
// hydration consumes bounded anchors through its admitted reader and the real cohort/FIFO owner.
// auth-health/store/inline exercise real writes; count mode covers every path in their synthetic state root.
// admission reserves an unadmitted copy through the real writer owner without running SQL.
// trajectory persists one runtime event per flush; final verification checks every durable row.
// descriptor reopens a native reader through the existing task pool and admission exchange.
// native-open prepares and retires a fresh agent generation under a real Gateway owner.
// page-prune measures one 256 KiB archive/pass; reset and verification stay outside windows.
// Timing has no FS wrappers or Inspector; allocation is a separate sampled main-isolate observation.
// state-read measures the first cached read after a real owner scope; use --iterations 1.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { syncBuiltinESMExports } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { prepareColdStorageWorkload } from "./session-cold-storage-workload.mjs";

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
    "detached-transcript",
    "reaction",
    "reply",
    "sharing",
    "hydration",
    "admission",
    "descriptor",
    "native-open",
    "trajectory",
    "talk",
    "cold-restore",
    "cold-status",
    "state-read",
    "page-prune",
    "auth-health",
    "auth-store",
    "auth-inline",
  ].includes(values.operation),
);
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(
  values.operation !== "state-read" || iterations === 1,
  "State read windows contain one post-scope read",
);
const root = path.resolve(values.root);
fs.mkdirSync(root);
process.env.OPENCLAW_STATE_DIR = root;
assert(values.checkout);
const checkout = path.resolve(values.checkout);
const load = (relative) => import(pathToFileURL(path.join(checkout, relative)).href);
const adapterSha256 = createHash("sha256")
  .update(fs.readFileSync(new URL(import.meta.url)))
  .digest("hex");
const workloadSha256 = createHash("sha256")
  .update(fs.readFileSync(new URL("./session-cold-storage-workload.mjs", import.meta.url)))
  .digest("hex");
let sourceRuntime;
if (["native-open", "sharing", "hydration", "detached-transcript"].includes(values.operation)) {
  const { runtimeProcessEntrypoints } = await load("src/infra/runtime-process-entrypoints.ts");
  const { resolveRuntimeProcessEntrypointUrl } = await load("src/infra/runtime-process-url.ts");
  const { resolveRuntimeWorkerUrl, resolveRuntimeWorkerThreadExecArgv } = await load(
    "src/infra/runtime-worker-url.ts",
  );
  sourceRuntime = {
    mode: "source",
    node: process.version,
    execPath: process.execPath,
    selections: [
      "sqliteStore",
      "agentDatabaseExecution",
      "sharedStateStore",
      "sessionTranscript",
      "stateLeaseHeartbeat",
      "gatewayStateOwnerHeartbeat",
    ].map((name) => {
      const url = resolveRuntimeProcessEntrypointUrl(name);
      assert.equal(url.href, resolveRuntimeWorkerUrl(runtimeProcessEntrypoints[name]).href);
      const entry = path.relative(checkout, fileURLToPath(url));
      assert(entry.startsWith(`src${path.sep}`) && entry.endsWith(".ts"));
      const execArgv = resolveRuntimeWorkerThreadExecArgv(url);
      assert.equal(execArgv[0], "--import");
      assert.equal(execArgv.length, 2);
      return {
        name,
        entry,
        sha256: createHash("sha256").update(fs.readFileSync(url)).digest("hex"),
        execArgv,
      };
    }),
  };
}
const source = [
  "src/infra/gateway-state-owner.ts",
  "src/infra/gateway-state-owner-lifecycle.ts",
  "src/state/openclaw-state-db-borrow.ts",
  "src/state/openclaw-state-db-cache.ts",
  "src/state/openclaw-state-read-operation.ts",
  "src/config/sessions/session-cold-storage.ts",
  "src/config/sessions/session-cold-storage-worker.ts",
  "src/config/sessions/session-cold-storage-read.worker.ts",
  "src/config/sessions/session-cold-storage-targets.ts",
  "src/config/sessions/session-cold-storage-status.ts",
  "src/config/sessions/session-accessor.sqlite-page-reclamation.ts",
  "src/config/sessions/session-history-archive-pruning.types.ts",
  "src/config/sessions/session-history-archive-pruning.ts",
  "src/config/sessions/session-accessor.sqlite-archive-store.ts",
  "src/config/sessions/session-accessor.sqlite-mutation-worker.runtime.ts",
  "src/config/sessions/session-accessor.sqlite-worker-request.ts",
  "src/config/sessions/session-accessor.sqlite-reclamation-commit.ts",
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
  "src/config/sessions/session-transcript-watermark.ts",
  "src/config/sessions/session-transcript-stats.ts",
  "src/config/sessions/session-transcript-worker-resources.ts",
  "src/config/sessions/session-accessor.sqlite-read-scope.ts",
  "src/config/sessions/session-reaction-store.ts",
  "src/state/openclaw-agent-execution.worker.ts",
  "src/state/openclaw-agent-execution-domain.ts",
  "src/infra/sqlite-writer-admission-client.ts",
  "src/state/openclaw-agent-execution.ts",
  "src/state/openclaw-agent-execution-work.ts",
  "src/state/openclaw-agent-db-lifecycle.ts",
  "src/config/sessions/session-worker-execution-source.ts",
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
  "src/gateway/session-sharing-preparation.ts",
  "src/gateway/session-sharing-facts-read.ts",
  "src/gateway/session-sharing-target.types.ts",
  "src/state/openclaw-agent-db-registry-listing.ts",
  "src/config/sessions/session-accessor.entry-mutation.ts",
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
  "src/infra/node-sqlite.ts",
  "src/infra/sqlite-clean-close-seal.ts",
  "src/infra/sqlite-staging-token.ts",
  "src/infra/sqlite-database-admission-descriptor.ts",
  "src/infra/sqlite-database-admission-turn.ts",
  "src/infra/sqlite-database-write-receipts.ts",
  "src/config/sessions/session-transcript-hydration.ts",
  "src/config/sessions/session-transcript-read-cohort.ts",
  "src/config/sessions/session-transcript-context-read.ts",
  "src/infra/sqlite-worker-broker-admission.ts",
  "src/infra/sqlite-worker-broker.ts",
  "src/infra/sqlite-worker-broker-reply.ts",
  "src/infra/sqlite-worker-broker.types.ts",
  "src/infra/sqlite-worker-client.ts",
  "src/infra/sqlite-worker-contract.ts",
  "src/infra/sqlite-worker-input-admission.ts",
  "src/infra/sqlite-worker-identity.ts",
  "src/state/openclaw-state-read-worker.ts",
  "src/infra/sqlite-database-admission.ts",
  "src/infra/sqlite-database-admission-record.ts",
  "src/infra/sqlite-database-admission-context.ts",
  "src/infra/sqlite-database-admission-seal.ts",
  "src/infra/sqlite-worker-database-admission-relay.ts",
  "src/infra/sqlite-worker-operation-admission.ts",
  "src/infra/sqlite-worker-operation-scope.ts",
  "src/infra/sqlite-worker-operation-settlement.ts",
  "src/infra/sqlite-database-admission-read.ts",
  "src/infra/sqlite-database-admission-delta.ts",
  "src/infra/sqlite-store.worker.ts",
  "src/state/openclaw-state-lease-heartbeat.worker.ts",
  "src/config/sessions/session-accessor.sqlite-worker-coordination.ts",
  "src/config/sessions/session-accessor.sqlite-archive.worker.ts",
  "src/infra/worker-task-server.ts",
  "src/infra/sqlite-database-admission.task.test-support.ts",
  "src/infra/sqlite-database-admission.worker.test-support.ts",
]
  .map((name) => {
    const filename = path.join(checkout, name);
    return `${name}:\n${["write-execution.ts", "store-updater.ts", "gateway-state-owner-lifecycle.ts", "sqlite-database-admission-descriptor.ts"].includes(path.basename(name)) && !fs.existsSync(filename) ? "absent" : fs.readFileSync(filename, "utf8")}`;
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
if (["reaction", "hydration", "detached-transcript"].includes(values.operation)) {
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
      replaceSqliteTranscriptEventsInTransaction(
        database,
        scope,
        [
          { type: "session", id: "synthetic-42", version: 3 },
          {
            type: "message",
            id: "synthetic-message",
            parentId: null,
            message: { role: "user", content: "Synthetic measurement" },
          },
        ],
        { rebuildProjectionSynchronously: values.operation === "hydration" },
      ),
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
let releaseGatewayOwner = () => {};
if (["native-open", "sharing", "hydration", "detached-transcript"].includes(values.operation)) {
  const { acquireGatewayStateOwner } = await load("src/infra/gateway-state-owner.ts");
  const { defaultPayload } = await load("src/infra/gateway-state-owner-record.ts");
  const { resolveOpenClawStateSqlitePath } = await load("src/state/openclaw-state-db.paths.ts");
  const statePath = resolveOpenClawStateSqlitePath(options.env);
  const gatewayOwner = acquireGatewayStateOwner({
    databasePath: statePath,
    payload: { ...defaultPayload(statePath), role: "gateway" },
  });
  const request = new AbortController();
  releaseGatewayOwner = () => {
    request.abort();
    gatewayOwner.release();
  };
  if (values.operation === "native-open") {
    const { captureOpenClawAgentDatabaseExecutionAsync } = await load(
      "src/state/openclaw-agent-execution.ts",
    );
    const { closeOpenClawAgentDatabaseByPathAsync } = await load(
      "src/state/openclaw-agent-db-lifecycle.ts",
    );
    const { createSessionWorkerExecutionSource } = await load(
      "src/config/sessions/session-worker-execution-source.ts",
    );
    let previousIncarnation;
    cycle = async () => {
      const execution = await captureOpenClawAgentDatabaseExecutionAsync({
        ...options,
        path: readPath,
      });
      try {
        const requestSource = createSessionWorkerExecutionSource(
          () => request.signal.throwIfAborted(),
          "Synthetic native opening request retired",
        );
        await execution.prepare(requestSource);
        const claim = execution.capturePreparedGenerationClaim();
        assert(claim);
        claim.assertCurrent();
        assert.notEqual(claim.incarnation, previousIncarnation);
        previousIncarnation = claim.incarnation;
      } finally {
        try {
          await execution.release();
        } finally {
          await closeOpenClawAgentDatabaseByPathAsync(readPath, options.agentId);
        }
      }
    };
  }
}
let closeDescriptor = async () => {};
if (values.operation === "descriptor") {
  const { createOwnedWorkerTaskPool } = await load("src/infra/worker-task-pool.ts");
  const pool = createOwnedWorkerTaskPool({
    workerUrl: pathToFileURL(
      path.join(checkout, "src/infra/sqlite-database-admission.task.test-support.ts"),
    ),
    maxWorkers: 1,
    idleTimeoutMs: 0,
  });
  cycle = async () => {
    const result = await pool.run({ path: readPath }, {});
    assert(result.threadId > 0);
    assert.deepEqual(result.sql, []);
  };
  closeDescriptor = () => pool.close();
}
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
if (values.operation === "sharing") {
  const { setRuntimeConfigSnapshot } = await load("src/config/runtime-snapshot.ts");
  const { prepareSessionMutationFacts } = await load("src/gateway/session-sharing-preparation.ts");
  const cfg = { agents: { entries: { synthetic: {} } }, session: { store: readPath } };
  setRuntimeConfigSnapshot(cfg);
  cycle = async () => {
    const read = await prepareSessionMutationFacts({
      cfg,
      agentId: options.agentId,
      sessionKey: "agent:synthetic:session-42",
    });
    try {
      assert.equal(read.readCurrent(cfg).target.entry.sessionId, "synthetic-42");
    } finally {
      read.release();
    }
  };
}
if (values.operation === "hydration") {
  const { prepareSessionTranscriptHydration } = await load(
    "src/config/sessions/session-transcript-hydration.ts",
  );
  const target = {
    ...options,
    storePath: readPath,
    sessionKey: "agent:synthetic:session-42",
    sessionId: "synthetic-42",
  };
  cycle = async () => {
    const reader = prepareSessionTranscriptHydration(target, { maxBytes: 4096, maxEvents: 10 });
    assert(reader.readCohort);
    let consumed = false;
    await reader.readCohort(
      { sessionKey: target.sessionKey, entryIds: ["synthetic-message"] },
      (prepared) => {
        assert.equal(prepared.kind, "bounded");
        assert(prepared.snapshot.events.some((event) => event.id === "synthetic-message"));
        assert.equal(prepared.transcript?.anchors[0]?.entryId, "synthetic-message");
        consumed = true;
      },
    );
    assert(consumed);
    reader.assertCurrent();
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
if (["transcript", "hydration"].includes(values.operation)) {
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
  const read =
    values.operation === "hydration"
      ? cycle
      : async () => assert.equal((await readSessionTranscriptWatermarkAsync(scope)).maxSeq, null);
  cycle = () =>
    withOwnedSessionTranscriptWrites(
      {
        sessionTarget: scope,
        sessionReader: databaseClaim.reader,
        withTranscriptWrite: (write) => write(),
      },
      read,
    );
}
let detachedReadPools = [];
if (values.operation === "detached-transcript") {
  const { readSessionTranscriptWatermarkAsync } = await load(
    "src/config/sessions/session-transcript-watermark.ts",
  );
  const { readTranscriptStatsAsync } = await load(
    "src/config/sessions/session-transcript-stats.ts",
  );
  const { getOwnedSessionTranscriptReader } = await load(
    "src/config/sessions/transcript-write-context.ts",
  );
  const { historyLane, targetDiscoveryLane } = await load(
    "src/config/sessions/session-transcript-worker-resources.ts",
  );
  detachedReadPools = [historyLane, targetDiscoveryLane];
  const scope = {
    ...options,
    storePath: readPath,
    sessionKey: "agent:synthetic:session-42",
    sessionId: "synthetic-42",
  };
  assert.equal(getOwnedSessionTranscriptReader(scope), undefined);
  cycle = async () => {
    const watermark = await readSessionTranscriptWatermarkAsync(scope);
    const stats = await readTranscriptStatsAsync(scope);
    assert.equal(watermark.maxSeq, 1);
    assert.equal(stats.maxSeq, 1);
    assert.equal(stats.eventCount, 2);
  };
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
let cold;
async function measure(mode) {
  assert(["count", "timing", "allocation"].includes(mode));
  cold?.prepareMeasurement?.();
  if (cold?.prepareWindow) {
    await cold.prepareWindow();
  }
  fs.statSync =
    mode === "count" &&
    !["descriptor", "native-open", "sharing", "hydration", "detached-transcript"].includes(
      values.operation,
    )
      ? countStat
      : stat;
  fs.realpathSync.native =
    mode === "count" &&
    !["descriptor", "native-open", "sharing", "hydration", "detached-transcript"].includes(
      values.operation,
    )
      ? countRealpath
      : realpath;
  syncBuiltinESMExports();
  syncCalls = 0;
  realpathCalls = 0;
  const allSyncCalls = {};
  const allSyncStacks = [];
  let asyncRealpathCalls = 0;
  const restoreCounters = [];
  const readCommands = {};
  if (mode === "count") {
    for (const lane of detachedReadPools) {
      for (const method of ["run", "closeResources"]) {
        const original = lane.pool[method];
        lane.pool[method] = new Proxy(original, {
          apply(target, receiver, args) {
            if (active) {
              const operation =
                method === "run" ? (args[1]?.diagnosticOperation ?? "unspecified") : method;
              const label = `${lane.name}:${operation}`;
              readCommands[label] = (readCommands[label] ?? 0) + 1;
            }
            return Reflect.apply(target, receiver, args);
          },
        });
        restoreCounters.push(() => {
          lane.pool[method] = original;
        });
      }
    }
  }
  if (
    (cold ||
      ["descriptor", "native-open", "sharing", "hydration", "detached-transcript"].includes(
        values.operation,
      )) &&
    mode === "count"
  ) {
    const wrap = (owner, name, label = name) => {
      const original = owner[name];
      if (typeof original !== "function") {
        return;
      }
      owner[name] = new Proxy(original, {
        apply(target, receiver, args) {
          if (active) {
            allSyncCalls[label] = (allSyncCalls[label] ?? 0) + 1;
            if (
              cold ||
              ["native-open", "sharing", "hydration", "detached-transcript"].includes(
                values.operation,
              )
            ) {
              allSyncStacks.push({ operation: label, stack: new Error().stack });
            }
          }
          return Reflect.apply(target, receiver, args);
        },
      });
      restoreCounters.push(() => {
        owner[name] = original;
      });
    };
    for (const name of Object.keys(fs)) {
      if (name.endsWith("Sync")) {
        wrap(fs, name);
      }
    }
    wrap(fs.realpathSync, "native", "realpathSync.native");
    if (values.operation === "state-read") {
      const resolve = fs.promises.realpath;
      fs.promises.realpath = new Proxy(resolve, {
        apply(target, receiver, args) {
          if (active) {
            asyncRealpathCalls += 1;
          }
          return Reflect.apply(target, receiver, args);
        },
      });
      restoreCounters.push(() => {
        fs.promises.realpath = resolve;
      });
    }
    syncBuiltinESMExports();
  }
  global.gc();
  const inspector = mode === "allocation" ? new Session() : undefined;
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
  for (const restore of restoreCounters.toReversed()) {
    restore();
  }
  fs.statSync = stat;
  fs.realpathSync.native = realpath;
  syncBuiltinESMExports();
  let bytes;
  if (mode === "allocation") {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const sum = (node) =>
      node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
    bytes = sum(profile.head) / iterations;
    inspector.disconnect();
  }
  const work = await cold?.verifyWindow?.();
  return {
    mode,
    alias: values.alias ?? false,
    operation: values.operation,
    sourceSha256: createHash("sha256").update(source).digest("hex"),
    adapterSha256,
    workloadSha256,
    iterations,
    sessions: 5000,
    ...(values.operation === "detached-transcript"
      ? {
          work: {
            reads: iterations * 2,
            transcriptEvents: 2,
            databaseBytes: fs.statSync(databasePath).size,
          },
        }
      : {}),
    ...(work ? { work } : {}),
    ...(mode === "count"
      ? {
          syncCalls,
          realpathCalls,
          ...(values.operation === "detached-transcript" ? { readCommands } : {}),
          ...(cold ||
          ["descriptor", "native-open", "sharing", "hydration", "detached-transcript"].includes(
            values.operation,
          )
            ? { allSyncCalls }
            : {}),
          ...(cold ||
          ["native-open", "sharing", "hydration", "detached-transcript"].includes(values.operation)
            ? { allSyncStacks }
            : {}),
          ...(values.operation === "state-read" ? { asyncRealpathCalls } : {}),
        }
      : {
          elapsedMs: elapsedMs / iterations,
          threadUs: (threadCpu.user + threadCpu.system) / iterations,
          processUs: (processCpu.user + processCpu.system) / iterations,
          bytes,
        }),
    load: loadavg(),
  };
}
async function warmup() {
  const work = [];
  for (
    let i = 0;
    i < (cold?.warmupIterations ?? (values.operation === "native-open" ? 5 : 50));
    i++
  ) {
    if (cold?.prepareWindow) {
      await cold.prepareWindow();
    }
    await cycle();
    const result = await cold?.verifyWindow?.();
    if (result) {
      work.push(result);
    }
  }
  return {
    ready: true,
    ...(sourceRuntime ? { sourceRuntime } : {}),
    ...(work.length ? { warmupWork: work } : {}),
  };
}
try {
  cold =
    values.operation.startsWith("cold-") ||
    values.operation === "state-read" ||
    values.operation === "page-prune"
      ? await prepareColdStorageWorkload({
          load,
          root,
          options,
          databasePath,
          iterations,
          operation: values.operation,
        })
      : undefined;
  if (cold) {
    cycle = cold.cycle;
  }
  const ready = await warmup();
  if (values.serve) {
    console.log(JSON.stringify(ready));
    const commands = createInterface({ input: process.stdin });
    for await (const line of commands) {
      const command = JSON.parse(line);
      if (command.stop) {
        break;
      }
      if (command.warmup) {
        console.log(JSON.stringify(await warmup()));
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
  cold?.verify();
} finally {
  active = false;
  fs.statSync = stat;
  fs.realpathSync.native = realpath;
  syncBuiltinESMExports();
  await closeDescriptor();
  closeReply();
  await releaseTranscript();
  try {
    await closeOpenClawAgentDatabasesAsync();
    cold?.release();
    await closeOpenClawStateDatabaseAsync();
  } finally {
    releaseGatewayOwner();
  }
  await flushLogger();
  fs.rmSync(root, { recursive: true, force: true });
}
