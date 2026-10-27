// Cold worker imports and first tasks, with TypeScript compilation prepared outside measurement.
// node --import ./scripts/tsx.mjs scripts/perf/worker-spawn-measure.mjs --output .local/spawn/head.json --samples 10
// Add --baseline-dir .local/spawn/base (a partial tree of original source files) for a baseline arm.
// --worker session-transcript|openclaw-state-read|git-operation|code-mode-node selects one owner.
// Run arms in alternating order. Every sample owns a fresh isolate; one unmeasured preparation
// isolate per owner caches transpiled source bytes. This is source-graph proof, not a dist/Gateway
// load test: loader resolution remains, and shared build chunks can change the shipped graph.
// State-read uses its admit handshake without opening a DB; transcript resolves an explicit
// agent path. Git reads a real synthetic repository; Code Mode evaluates an arithmetic cell.
// Counters are exact isolate allocation/thread CPU (Node 26.12+), not process RSS or host CPU.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";
import { isMainThread, MessageChannel, parentPort, Worker, workerData } from "node:worker_threads";

const root = fileURLToPath(new URL("../../", import.meta.url));
const entries = {
  "session-transcript": "src/config/sessions/session-transcript.worker.ts",
  "openclaw-state-read": "src/state/openclaw-state-read.worker.ts",
  "git-operation": "src/infra/git-operation.worker.ts",
  "code-mode-node": "src/agents/code-mode-node.worker.ts",
};

function snapshot() {
  const heap = getHeapStatistics();
  assert(Number.isFinite(heap.total_allocated_bytes), "Requires Node 26.12+ allocation counter");
  return {
    at: performance.now(),
    cpu: process.threadCpuUsage(),
    allocated: heap.total_allocated_bytes,
  };
}
function delta(before) {
  const after = snapshot();
  return {
    wallMs: after.at - before.at,
    cpuMs: (after.cpu.user + after.cpu.system - before.cpu.user - before.cpu.system) / 1000,
    allocatedBytes: after.allocated - before.allocated,
  };
}
function summarize(rows) {
  return Object.fromEntries(
    Object.keys(rows[0]).map((key) => {
      const sorted = rows.map((row) => row[key]).toSorted((a, b) => a - b);
      return [
        key,
        {
          median:
            (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) /
            2,
          min: sorted[0],
          max: sorted.at(-1),
        },
      ];
    }),
  );
}

if (!isMainThread) {
  const compiler = workerData.prepare ? await import("esbuild") : undefined;
  const loaded = new Set();
  const overlays = new Set();
  registerHooks({
    load(url, context, next) {
      if (!url.startsWith("file:")) {
        return next(url, context);
      }
      const filename = fileURLToPath(url);
      const relative = path.relative(root, filename);
      if (/\.[cm]?ts$/.test(filename)) {
        const cacheFile = path.join(
          workerData.cache,
          createHash("sha256").update(url).digest("hex"),
        );
        let source;
        if (workerData.prepare) {
          const selected = workerData.baselineFiles[relative] ?? filename;
          if (selected !== filename) {
            overlays.add(relative);
          }
          source = compiler.transformSync(fs.readFileSync(selected, "utf8"), {
            loader: "ts",
            format: "esm",
            target: "esnext",
            tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true } },
          }).code;
          fs.writeFileSync(cacheFile, source);
        } else {
          assert(fs.existsSync(cacheFile), `Unprepared TypeScript module: ${relative}`);
          source = fs.readFileSync(cacheFile, "utf8");
        }
        loaded.add(url);
        return { format: "module", source, shortCircuit: true };
      }
      const result = next(url, context);
      if (result.format === "module" || result.format === "commonjs") {
        loaded.add(url);
      }
      return result;
    },
  });
  const before = snapshot();
  await import(pathToFileURL(path.join(root, workerData.entry)).href);
  const cold = { ...delta(before), loadedModules: loaded.size };
  let taskStart;
  async function handleProbe(message) {
    if (message.probe === "begin") {
      taskStart = snapshot();
      parentPort.postMessage({ probe: "begin" }, []);
    } else if (message.probe === "end") {
      const firstTask = { ...delta(taskStart), loadedModules: loaded.size };
      // Census runs only after both measured intervals, so debugger allocations do not enter them.
      const inspector = new Session();
      inspector.connect();
      const evaluated = new Set();
      inspector.on("Debugger.scriptParsed", ({ params }) => {
        if (params.url.startsWith("file:")) {
          evaluated.add(params.url);
        }
      });
      await inspector.post("Debugger.enable");
      await inspector.post("Debugger.disable");
      inspector.disconnect();
      await compiler?.stop();
      parentPort.postMessage(
        {
          probe: "end",
          firstTask,
          evaluatedModules: evaluated.size,
          overlays: [...overlays],
        },
        [],
      );
    }
  }
  parentPort.on("message", (message) => {
    void handleProbe(message).catch(
      /** @param {unknown} error */ (error) => {
        parentPort.postMessage({ probe: message.probe, error: String(error) }, []);
      },
    );
  });
  parentPort.postMessage({ probe: "cold", cold }, []);
} else {
  const { values } = parseArgs({
    options: {
      output: { type: "string" },
      samples: { type: "string", default: "10" },
      worker: { type: "string" },
      "baseline-dir": { type: "string" },
    },
  });
  assert(values.output, "--output is required");
  const samples = Number(values.samples);
  assert(Number.isSafeInteger(samples) && samples > 0, "--samples must be positive");
  assert(!values.worker || Object.hasOwn(entries, values.worker), "Unknown --worker");
  const baselineDir = values["baseline-dir"] && path.resolve(values["baseline-dir"]);
  // Keep this parent-only directory walker outside the measured worker import graph.
  const { listDirectoryTreeStrictSync } = await import("../../src/infra/directory-walk.js");
  // Resolve overlays before preparation; measured workers only read compiled cache files.
  const baselineFiles = baselineDir
    ? Object.fromEntries(
        listDirectoryTreeStrictSync(baselineDir)
          .filter(({ dirent }) => dirent.isFile())
          .map(({ relativePath }) => [relativePath, path.join(baselineDir, relativePath)]),
      )
    : {};
  const output = path.resolve(values.output);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const scratch = fs.mkdtempSync(path.join(path.dirname(output), "worker-spawn-"));
  const state = path.join(scratch, "state");
  const repository = path.join(scratch, "repository");
  for (const directory of [
    state,
    repository,
    path.join(scratch, "home"),
    path.join(scratch, "tmp"),
  ]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const environment = {
    ...process.env,
    HOME: path.join(scratch, "home"),
    OPENCLAW_HOME: path.join(scratch, "home"),
    OPENCLAW_STATE_DIR: state,
    TMPDIR: path.join(scratch, "tmp"),
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  };
  let gitHost;
  if (!values.worker || values.worker === "git-operation") {
    const git = (...args) =>
      execFileSync("git", ["-C", repository, ...args], { env: environment, stdio: "pipe" });
    git("init", "-q", "-b", "main");
    git(
      "-c",
      "user.name=Benchmark",
      "-c",
      "user.email=benchmark@example.invalid",
      "commit",
      "--allow-empty",
      "-qm",
      "synthetic fixture",
    );
    const { runGitBytes, runGitBuffered } = await import("../../src/agents/worktrees/git.ts");
    gitHost = async (request) => {
      assert.equal(request.type, "git.batch");
      return Promise.all(
        request.input.requests.map(async ({ type, input }) => {
          assert(type === "git.text" || type === "git.buffer");
          try {
            return {
              ok: true,
              value: await (type === "git.text" ? runGitBytes : runGitBuffered)(
                input.cwd,
                input.args,
                input.options,
              ),
            };
          } catch (error) {
            return {
              ok: false,
              error: { name: error.name, message: error.message, code: error.code },
            };
          }
        }),
      );
    };
  }
  function requestForWorker(name) {
    if (name === "openclaw-state-read") {
      return {
        command: { type: "admit" },
        checkFreshAdmission: false,
        databasePath: path.join(state, "openclaw.db"),
        location: state,
        context: { environment },
      };
    }
    if (name === "session-transcript") {
      return {
        kind: "sqlite-target",
        storePath: path.join(state, "agents", "benchmark", "sessions", "sessions.json"),
        agentId: "benchmark",
        registeredDatabases: [],
        env: environment,
      };
    }
    if (name === "git-operation") {
      return { type: "repository.branches", input: { repoRoot: repository } };
    }
    const bytes = Buffer.from(
      JSON.stringify({
        __openclawCatalog: [],
        __openclawNamespaces: [],
        __openclawApiFiles: [],
        __openclawSwarmEnabled: false,
      }),
    );
    const initialization = new SharedArrayBuffer(bytes.length);
    new Uint8Array(initialization).set(bytes);
    return {
      kind: "exec",
      source: "return Array.from({length: 128}, (_, i) => i).reduce((a, b) => a + b, 0);",
      initialization,
      progress: new SharedArrayBuffer(64 + 16384),
      inlineHost: false,
      config: {
        timeoutMs: 30000,
        memoryLimitBytes: 64 * 1024 * 1024,
        maxOutputBytes: 16384,
        maxSnapshotBytes: 65536,
        maxPendingToolCalls: 128,
      },
    };
  }
  function verify(name, reply) {
    if (name === "code-mode-node") {
      assert.equal(reply.status, "completed", JSON.stringify(reply));
      assert.equal(reply.value.json, "8128");
    } else {
      assert.equal(reply.ok, true, JSON.stringify(reply));
      if (name === "openclaw-state-read") {
        assert.equal(reply.type, "admit");
      } else if (name === "git-operation") {
        assert.equal(reply.value.headBranch, "main");
      } else {
        assert.equal(reply.value.target.agentId, "benchmark");
      }
    }
  }
  async function run(name, cache, prepare) {
    const channel = new MessageChannel();
    const probes = new Map();
    const cold = Promise.withResolvers();
    const ready = Promise.withResolvers();
    const task = Promise.withResolvers();
    for (const pending of [cold, ready, task]) {
      void pending.promise.catch(() => {});
    }
    const started = performance.now();
    const worker = new Worker(new URL(import.meta.url), {
      env: environment,
      workerData: {
        entry: entries[name],
        cache,
        prepare,
        baselineFiles: prepare ? baselineFiles : undefined,
      },
    });
    const fail = (error) => {
      for (const pending of [cold, ready, task, ...probes.values()]) {
        pending.reject(error);
      }
    };
    worker.on("error", fail);
    worker.on("exit", (code) => fail(new Error(`Worker exited (${code})`)));
    worker.on("message", (message) => {
      if (message.probe === "cold") {
        cold.resolve(message.cold);
      } else if (message.error) {
        fail(new Error(message.error));
      } else {
        probes.get(message.probe)?.resolve(message);
      }
    });
    channel.port1.on("message", (message) => {
      if (message.status === "ready") {
        ready.resolve();
      } else if (message.status === "ok") {
        task.resolve(message.value);
      } else if (message.status === "failed") {
        fail(new Error(message.error));
      } else if (message.status === "request") {
        Promise.resolve()
          .then(() => gitHost(message.value))
          .then((response) => {
            channel.port1.postMessage({
              taskId: message.taskId,
              responseId: message.id,
              input: response,
            });
          })
          .catch(fail);
      }
    });
    const probe = (operation) => {
      const pending = Promise.withResolvers();
      probes.set(operation, pending);
      worker.postMessage({ probe: operation }, []);
      return pending.promise;
    };
    const timeout = setTimeout(
      () => fail(new Error(`${name} startup/first task exceeded 120 s`)),
      120000,
    );
    try {
      const coldResult = await cold.promise;
      worker.postMessage({ type: "openclaw.worker-task-port", port: channel.port2 }, [
        channel.port2,
      ]);
      await ready.promise;
      const spawnToReadyMs = performance.now() - started;
      await probe("begin");
      const firstStarted = performance.now();
      channel.port1.postMessage({
        taskId: 1,
        input: requestForWorker(name),
        interactive: true,
        nativeSections: new SharedArrayBuffer(4),
        taskContext: { deletedAgentDatabaseFences: [] },
      });
      verify(name, await task.promise);
      const firstRoundTripMs = performance.now() - firstStarted;
      const result = await probe("end");
      return {
        cold: coldResult,
        firstTask: result.firstTask,
        total: {
          wallMs: coldResult.wallMs + result.firstTask.wallMs,
          cpuMs: coldResult.cpuMs + result.firstTask.cpuMs,
          allocatedBytes: coldResult.allocatedBytes + result.firstTask.allocatedBytes,
        },
        spawnToFirstReplyMs: spawnToReadyMs + firstRoundTripMs,
        evaluatedModules: result.evaluatedModules,
        overlays: result.overlays,
        hostLoad: os.loadavg(),
      };
    } finally {
      clearTimeout(timeout);
      await worker.terminate();
      channel.port1.close();
      channel.port2.close();
    }
  }
  const report = {
    node: process.version,
    samples,
    baselineDir: values["baseline-dir"] ?? null,
    workers: {},
    limitations: [
      "Source module graph with prepared TypeScript bytes, not shipped dist chunk graph",
      "Cold load count is loader-observed; evaluated-module census after first task includes benchmark/loader modules",
      "First-task counters include task transport and host wait, not host Git subprocess CPU",
      "State admit does not open a database; transcript sqlite-target uses an explicit agent path",
      "No full Gateway load, main-thread CPU, RSS, or GC/promotion claim",
    ],
  };
  try {
    for (const name of Object.keys(entries)) {
      if (values.worker && values.worker !== name) {
        continue;
      }
      const cache = path.join(scratch, `compiled-${name}`);
      fs.mkdirSync(cache);
      const preparation = await run(name, cache, true);
      const rows = [];
      for (let index = 0; index < samples; index++) {
        rows.push(await run(name, cache, false));
      }
      report.workers[name] = {
        preparationModules: preparation.evaluatedModules,
        overlays: preparation.overlays,
        cold: summarize(rows.map((row) => row.cold)),
        firstTask: summarize(rows.map((row) => row.firstTask)),
        total: summarize(rows.map((row) => row.total)),
        spawnToFirstReplyMs: summarize(rows.map((row) => ({ value: row.spawnToFirstReplyMs })))
          .value,
        evaluatedModules: rows.map((row) => row.evaluatedModules),
        rows,
      };
      fs.writeFileSync(output, JSON.stringify(report, null, 2));
      console.log(
        JSON.stringify({
          worker: name,
          samples,
          total: report.workers[name].total,
          cold: report.workers[name].cold,
        }),
      );
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
