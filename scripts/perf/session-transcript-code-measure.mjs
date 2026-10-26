// Synthetic worker proof: node --import ./scripts/tsx.mjs scripts/perf/session-transcript-code-measure.mjs --output <new-directory> --baseline-ref <commit> --samples 5 --snapshots
// Alternate baseline/candidate order; each task kind gets a fresh isolate in each prewarm mode.
// Timings finish before forced GC. Snapshots use the committed aggregate-only code analyzer.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { MessageChannel, Worker } from "node:worker_threads";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    "baseline-ref": { type: "string" },
    "baseline-dir": { type: "string" },
    "baseline-file": { type: "string", multiple: true },
    "task-kind": { type: "string", multiple: true },
    prewarm: { type: "string", default: "both" },
    samples: { type: "string", default: "5" },
    control: { type: "boolean", default: false },
    snapshots: { type: "boolean", default: false },
  },
});
assert(values.output, "--output is required");
assert(
  !(values["baseline-ref"] && values["baseline-dir"]),
  "Choose --baseline-ref or --baseline-dir",
);
assert(
  !values.control || values["baseline-ref"] || values["baseline-dir"],
  "--control requires a baseline",
);
assert(["both", "true", "false"].includes(values.prewarm), "--prewarm must be both, true or false");
const output = path.resolve(values.output);
const root = fileURLToPath(new URL("../../", import.meta.url));
const samples = Number(values.samples);
assert(Number.isSafeInteger(samples) && samples > 0);
await fs.mkdir(output);
for (const directory of ["home", "state", "tmp"]) {
  await fs.mkdir(path.join(output, directory));
}
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
const candidateHead = git("rev-parse", "HEAD").trim();
const diff = git("diff", values["baseline-ref"] ?? "HEAD", "--", "src", "packages");
const changedSources = new Set(
  [
    git("diff", "--name-only", values["baseline-ref"] ?? "HEAD", "--", "src", "packages"),
    git("ls-files", "--others", "--exclude-standard", "--", "src", "packages"),
  ].flatMap((files) => files.trim().split("\n").filter(Boolean)),
);
const candidateSources = Object.fromEntries(
  await Promise.all(
    [...changedSources].map(async (file) => {
      const bytes = await fs.readFile(path.join(root, file));
      return [file, createHash("sha256").update(bytes).digest("hex")];
    }),
  ),
);
let baselineDir = values["baseline-dir"] ? path.resolve(values["baseline-dir"]) : undefined;
let baselineFiles = values["baseline-file"] ?? [];
let baselineRef;
if (values["baseline-ref"]) {
  baselineRef = git("rev-parse", "--verify", `${values["baseline-ref"]}^{commit}`).trim();
  baselineDir = path.join(output, "baseline-source");
  baselineFiles = git("diff", "--name-only", baselineRef, "--", "src", "packages")
    .trim()
    .split("\n")
    .filter(Boolean);
  // New candidate modules have no baseline bytes and are unreachable from the old import edges.
  const baselinePaths = new Set(
    git("ls-tree", "-r", "--name-only", baselineRef, "--", ...baselineFiles)
      .trim()
      .split("\n"),
  );
  const captured = [];
  for (const file of baselineFiles) {
    if (!baselinePaths.has(file)) {
      continue;
    }
    const source = git("show", `${baselineRef}:${file}`);
    await fs.mkdir(path.dirname(path.join(baselineDir, file)), { recursive: true });
    await fs.writeFile(path.join(baselineDir, file), source);
    captured.push(file);
  }
  baselineFiles = captured;
}
assert(
  !baselineDir || baselineFiles.length,
  "Baseline needs changed files or --baseline-file selections",
);
const transformedFiles = { baseline: [], candidate: [] };
let compiler;
async function prepareSources(sourceRoot, side) {
  const directory = path.join(output, `prepared-${side}-source`);
  for (const file of baselineFiles) {
    const input = await fs.readFile(path.join(sourceRoot, file), "utf8");
    let source = input;
    try {
      stripTypeScriptTypes(input);
    } catch (error) {
      if (error.code !== "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX") {
        throw error;
      }
      // Parameter properties need the repository's compiler. Keep it outside measured isolates.
      compiler ??= await import("esbuild");
      source = compiler.transformSync(input, {
        loader: "ts",
        format: "esm",
        target: "esnext",
        sourcefile: path.join(root, file),
        tsconfigRaw: JSON.parse(await fs.readFile(path.join(root, "tsconfig.json"), "utf8")),
      }).code;
      transformedFiles[side].push(file);
    }
    await fs.mkdir(path.dirname(path.join(directory, file)), { recursive: true });
    await fs.writeFile(path.join(directory, file), source);
  }
  return directory;
}
const preparedBaselineDir = baselineDir ? await prepareSources(baselineDir, "baseline") : undefined;
const preparedCandidateDir = baselineFiles.length
  ? await prepareSources(root, "candidate")
  : undefined;
const env = {
  PATH: process.env.PATH,
  HOME: path.join(output, "home"),
  OPENCLAW_HOME: path.join(output, "home"),
  OPENCLAW_STATE_DIR: path.join(output, "state"),
  TMPDIR: path.join(output, "tmp"),
  OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
};
Object.assign(process.env, env);
// Setup uses the writable production owners, outside all worker timing/retention windows.
const { runOpenClawAgentWriteTransaction, closeOpenClawAgentDatabasesAsync } =
  await import("../../src/state/openclaw-agent-db.js");
const { writeSessionEntry } =
  await import("../../src/config/sessions/session-accessor.sqlite-entry-store.js");
const { appendTranscriptEventsInTransaction } =
  await import("../../src/config/sessions/session-accessor.sqlite-transcript-store.js");
const { waitForSessionTranscriptProjection } =
  await import("../../src/config/sessions/session-transcript-reconcile.js");
const { CURRENT_SESSION_VERSION } = await import("../../src/agents/sessions/session-manager.js");
const scope = {
  agentId: "main",
  databaseAgentId: "main",
  env,
  sessionId: "synthetic-borrower-session",
  sessionKey: "agent:main:synthetic-borrower-session",
};
const timestamp = "2026-01-01T00:00:00.000Z";
const events = [
  {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: scope.sessionId,
    cwd: "/synthetic",
    timestamp,
  },
  {
    type: "message",
    id: "synthetic-user",
    parentId: null,
    timestamp,
    message: { role: "user", content: "Synthetic borrower question", timestamp: 1 },
  },
  {
    type: "message",
    id: "synthetic-assistant",
    parentId: "synthetic-user",
    timestamp,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Synthetic borrower response" }],
      provider: "synthetic",
      model: "synthetic",
      api: "synthetic",
      stopReason: "stop",
      usage: { input: 1, output: 1, totalTokens: 2, cost: { input: 0, output: 0, total: 0 } },
      timestamp: 2,
    },
  },
];
let database;
try {
  runOpenClawAgentWriteTransaction((opened) => {
    database = { agentId: opened.agentId, path: opened.path };
    writeSessionEntry(opened, scope.sessionKey, { sessionId: scope.sessionId, updatedAt: 1 });
    appendTranscriptEventsInTransaction(opened, scope, events);
  }, scope);
  await waitForSessionTranscriptProjection(scope);
} finally {
  await closeOpenClawAgentDatabasesAsync(env.OPENCLAW_STATE_DIR);
}
const { formatSqliteSessionFileMarker } =
  await import("../../src/config/sessions/legacy-sqlite-marker.js");
const target = {
  ...scope,
  storePath: database.path,
  sessionFile: formatSqliteSessionFileMarker({ ...scope, storePath: database.path }),
};
const requests = {
  prewarm: { kind: "prewarm", env, database },
  "session-entry-read": { kind: "session-entry-read", database, scope: target },
  "session-entry-list": {
    kind: "session-entry-list",
    database,
    scope: { agentId: scope.agentId, storePath: database.path, env, projection: "list" },
  },
  "history-page": {
    kind: "history-page",
    database,
    target: { transcript: target },
    request: {
      kind: "recent-page",
      params: { target, options: { maxMessages: 10, maxBytes: 65536 } },
    },
  },
};
const kinds = values["task-kind"] ?? Object.keys(requests);
for (const kind of kinds) {
  assert(Object.hasOwn(requests, kind), `Unknown --task-kind ${kind}`);
}
const modes = values.prewarm === "both" ? [false, true] : [values.prewarm === "true"];
const report = {
  node: process.version,
  candidateHead,
  candidateSources,
  baselineRef,
  baselineDir,
  baselineFiles,
  preparedSources: {
    baseline: preparedBaselineDir,
    candidate: preparedCandidateDir,
    transformedFiles,
    ...(compiler ? { compiler: `esbuild ${compiler.version}` } : {}),
  },
  diffSha256: createHash("sha256").update(diff).digest("hex"),
  fixture: {
    sessions: 1,
    messages: 2,
    sha256: createHash("sha256").update(JSON.stringify(events)).digest("hex"),
  },
  limitations: [
    "Synthetic production worker boundary; Gateway concurrency is separate proof",
    "Forced-GC retention is not allocation churn or natural-GC latency",
    "Code analyzer retained rows overlap; use its total union, never sum rows",
  ],
  results: [],
};
for (let sample = 0; sample < samples; sample++) {
  for (const prewarmHistory of modes) {
    for (const kind of kinds) {
      const sides = baselineDir
        ? sample % 2
          ? ["candidate", "baseline"]
          : ["baseline", "candidate"]
        : ["candidate"];
      for (const side of sides) {
        const diagnostics = new MessageChannel();
        const tasks = new MessageChannel();
        const ready = Promise.withResolvers();
        const taskReady = Promise.withResolvers();
        const pending = new Map();
        let sequence = 0;
        void taskReady.promise.catch(() => {});
        const hostLoad = { loadavg: os.loadavg(), freeMemory: os.freemem() };
        const started = performance.now();
        const worker = new Worker(new URL("./worker-module-graphs-worker.mjs", import.meta.url), {
          workerData: {
            name: "session-transcript",
            entry: new URL(
              "../../src/config/sessions/session-transcript.worker.ts",
              import.meta.url,
            ).href,
            prewarmHistory,
            diagnostics: diagnostics.port2,
            baselineDir:
              values.control || side === "baseline" ? preparedBaselineDir : preparedCandidateDir,
            baselineFiles,
          },
          transferList: [diagnostics.port2],
          env,
        });
        const fail = (error) => {
          ready.reject(error);
          taskReady.reject(error);
          for (const promise of pending.values()) {
            promise.reject(error);
          }
        };
        worker.on("error", fail);
        const timeout = setTimeout(() => fail(new Error("Worker measurement timed out")), 120000);
        diagnostics.port1.on("message", (message) => {
          if (message.ready) {
            ready.resolve();
          } else {
            const promise = pending.get(message.id);
            pending.delete(message.id);
            if (message.error) {
              promise?.reject(new Error(message.error));
            } else {
              promise?.resolve(message.value);
            }
          }
        });
        tasks.port1.on("message", (message) => {
          if (message.status === "ready") {
            taskReady.resolve();
          } else {
            const promise = pending.get(message.taskId);
            pending.delete(message.taskId);
            if (message.status === "ok") {
              promise?.resolve(message.value);
            } else {
              promise?.reject(new Error(message.error));
            }
          }
        });
        try {
          await ready.promise;
          worker.postMessage({ type: "openclaw.worker-task-port", port: tasks.port2 }, [
            tasks.port2,
          ]);
          await taskReady.promise;
          const coldReadyMs = performance.now() - started;
          const id = ++sequence;
          const task = Promise.withResolvers();
          pending.set(id, task);
          const taskStarted = performance.now();
          tasks.port1.postMessage({
            taskId: id,
            input: requests[kind],
            interactive: true,
            nativeSections: new SharedArrayBuffer(4),
            taskContext: { deletedAgentDatabaseFences: [] },
          });
          const reply = await task.promise;
          const firstTaskMs = performance.now() - taskStarted;
          assert.equal(reply.ok, true, JSON.stringify(reply));
          if (kind === "session-entry-read") {
            assert.equal(reply.value.entry?.sessionId, scope.sessionId);
          } else if (kind === "session-entry-list") {
            assert.equal(reply.value.entries[0]?.entry.sessionId, scope.sessionId);
          } else if (kind === "history-page") {
            assert.equal(reply.value.result.messages.length, 2);
            assert.equal(reply.value.result.messages[0].role, "user");
          } else {
            assert.deepEqual(reply.value, { kind: "prewarm" });
          }
          const label = `${sample}-${prewarmHistory ? "prewarmed" : "cold"}-${kind}-${side}`;
          const inspect = Promise.withResolvers();
          pending.set(++sequence, inspect);
          diagnostics.port1.postMessage({
            id: sequence,
            operation: "inspect",
            ...(values.snapshots ? { snapshot: path.join(output, `${label}.heapsnapshot`) } : {}),
          });
          const retained = await inspect.promise;
          await worker.terminate();
          let codeAnalysis;
          if (retained.snapshot) {
            // No snapshot-derived names are approved for output; aggregate labels stay redacted.
            codeAnalysis = JSON.parse(
              execFileSync(
                process.execPath,
                [
                  path.join(root, "scripts/heap-snapshot-diff.mjs"),
                  "--code-by-script",
                  retained.snapshot,
                  "--top",
                  "10",
                ],
                { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
              ),
            );
            await fs.writeFile(
              path.join(output, `${label}.code.json`),
              JSON.stringify(codeAnalysis, null, 2),
            );
          }
          const result = {
            sample,
            side,
            kind,
            prewarmHistory,
            hostLoad,
            coldReadyMs,
            firstTaskMs,
            coldTaskMs: coldReadyMs + firstTaskMs,
            ...retained,
            ...(codeAnalysis ? { codeAnalysis } : {}),
          };
          report.results.push(result);
          await fs.writeFile(path.join(output, "results.json"), JSON.stringify(report, null, 2));
          console.log(
            JSON.stringify({
              sample,
              side,
              kind,
              prewarmHistory,
              coldReadyMs,
              firstTaskMs,
              heapBytes: retained.heap.used_heap_size,
              code: retained.code,
              scripts: retained.scriptCount,
            }),
          );
        } finally {
          clearTimeout(timeout);
          await worker.terminate();
          diagnostics.port1.close();
          tasks.port1.close();
        }
      }
    }
  }
}
