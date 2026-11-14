// Cold worker imports and first tasks, with TypeScript compilation prepared outside measurement.
// node --import ./scripts/tsx.mjs scripts/perf/worker-spawn-measure.mjs --output .local/spawn/head.json --samples 10
// Add --baseline-dir .local/spawn/base (a partial tree of original source files) for a baseline arm.
// --built --build-dir <checkout> measures shipped dist without a TypeScript loader in workers.
// --worker <name> selects one owner. --compare-build-dir <base> alternates base/candidate
// order per sample against --build-dir <candidate>, reporting both arms for each worker.
// Example: node --import ./scripts/tsx.mjs scripts/perf/worker-spawn-measure.mjs --built --build-dir . --samples 5 --output .local/spawn/built.json
// Run arms in alternating order. Every sample owns a fresh isolate; one unmeasured preparation
// isolate per owner caches transpiled source bytes in source mode. Built mode uses the shipped
// chunk graph. Neither mode is a full Gateway load test. Census excludes this benchmark module.
// State-read uses its admit handshake without opening a DB; transcript resolves an explicit
// agent path. Git reads a real synthetic repository; Code Mode evaluates an arithmetic cell.
// Catalog decodes 16 rows with 64 KiB previews (~1 MiB), beyond its owner's inline threshold.
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
  "cron-stream-matcher": "src/gateway/cron-stream-matcher.worker.ts",
  "file-tool-planning": "src/agents/sessions/tools/file-tool-planning.worker.ts",
  "identity-file": "src/agents/identity-file.worker.ts",
  "identity-avatar-file": "src/agents/identity-avatar-file.worker.ts",
  "image-processor": "src/media/image-processor.worker.ts",
  "fs-safe-copy": "src/infra/fs-safe-copy.worker.ts",
  "control-ui-file": "src/gateway/control-ui-file.worker.ts",
  "control-ui-public-session-card": "src/gateway/control-ui-public-session-card.worker.ts",
  "catalog-page": "extensions/codex/catalog-page.worker.ts",
  "session-transcript-reconcile": "src/config/sessions/session-transcript-reconcile.worker.ts",
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
  if (!workerData.built) {
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
  }
  const before = snapshot();
  await import(workerData.entry);
  const cold = { ...delta(before), ...(!workerData.built ? { loadedModules: loaded.size } : {}) };
  let taskStart;
  async function handleProbe(message) {
    if (message.probe === "begin") {
      taskStart = snapshot();
      parentPort.postMessage({ probe: "begin" }, []);
    } else if (message.probe === "end") {
      const firstTask = {
        ...delta(taskStart),
        ...(!workerData.built ? { loadedModules: loaded.size } : {}),
      };
      // Census runs only after both measured intervals, so debugger allocations do not enter them.
      const inspector = new Session();
      inspector.connect();
      const evaluated = new Map();
      inspector.on("Debugger.scriptParsed", ({ params }) => {
        if (params.url.startsWith("file:") && params.url !== import.meta.url) {
          evaluated.set(params.scriptId, params.url);
        }
      });
      await inspector.post("Debugger.enable");
      let parsedSourceBytes = 0;
      for (const scriptId of evaluated.keys()) {
        const { scriptSource } = await inspector.post("Debugger.getScriptSource", { scriptId });
        parsedSourceBytes += Buffer.byteLength(scriptSource);
      }
      await inspector.post("Debugger.disable");
      inspector.disconnect();
      await compiler?.stop();
      parentPort.postMessage(
        {
          probe: "end",
          firstTask,
          evaluatedModules: new Set(evaluated.values()).size,
          parsedSourceBytes,
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
      built: { type: "boolean" },
      "build-dir": { type: "string" },
      "compare-build-dir": { type: "string" },
    },
  });
  assert(values.output, "--output is required");
  assert(!values["build-dir"] || values.built, "--build-dir requires --built");
  assert(!values["compare-build-dir"] || values.built, "--compare-build-dir requires --built");
  assert(!values.built || !values["baseline-dir"], "--baseline-dir is source-only");
  const buildRoot = path.resolve(values["build-dir"] ?? root);
  const comparisonRoot = values["compare-build-dir"] && path.resolve(values["compare-build-dir"]);
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
    OPENCLAW_SUPERVISOR_MODE: "external",
  };
  fs.writeFileSync(path.join(scratch, "IDENTITY.md"), "# Identity\n- Name: Synthetic benchmark\n");
  const image = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==",
    "base64",
  );
  fs.writeFileSync(path.join(scratch, "avatar.png"), image);
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
    if (name === "cron-stream-matcher") {
      return { pattern: "needle", lines: ["hay", "needle"] };
    }
    if (name === "file-tool-planning") {
      return { kind: "write", path: "fixture.txt", beforeText: "before\n", content: "after\n" };
    }
    if (name === "identity-file") {
      return { identityPath: path.join(scratch, "IDENTITY.md") };
    }
    if (name === "identity-avatar-file") {
      return { workspaceDir: scratch, source: "avatar.png", readBody: true };
    }
    if (name === "image-processor") {
      return { kind: "transparency", input: image };
    }
    if (name === "fs-safe-copy") {
      return { type: "metadata", paths: [path.join(scratch, "IDENTITY.md")] };
    }
    if (name === "control-ui-file") {
      return {
        rootPath: scratch,
        filePath: path.join(scratch, "IDENTITY.md"),
        rejectHardlinks: true,
        readBody: true,
      };
    }
    if (name === "control-ui-public-session-card") {
      return {
        title: "Synthetic benchmark",
        messageCount: 2,
        host: "example.invalid",
        status: "Done",
      };
    }
    if (name === "catalog-page") {
      const id = 2 ** 52 + 1;
      return {
        bytes: Buffer.from(
          JSON.stringify({
            id,
            result: {
              data: Array.from({ length: 16 }, (_, index) => ({
                id: `synthetic-${index}`,
                preview: "Synthetic preview ".padEnd(64 * 1024, "x"),
                source: "cli",
              })),
              nextCursor: null,
            },
          }),
        ),
        route: { id, kind: "list" },
        remainingRows: 100,
      };
    }
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
    if (name === "cron-stream-matcher") {
      assert.equal(reply, true);
    } else if (name === "file-tool-planning") {
      assert.equal(reply.kind, "write");
      assert(reply.receipt.patch.includes("+after"));
    } else if (name === "identity-file") {
      assert.equal(reply.kind, "loaded");
      assert.equal(reply.identity.name, "Synthetic benchmark");
    } else if (name === "identity-avatar-file") {
      assert(reply.ok);
      assert.deepEqual(Buffer.from(reply.file.body), image);
    } else if (name === "image-processor") {
      assert.equal(reply.kind, "transparency", JSON.stringify(reply));
      assert.equal(typeof reply.value.hasTransparentPixels, "boolean");
    } else if (name === "fs-safe-copy") {
      assert.equal(reply.type, "metadata");
      assert.equal(reply.entries.length, 1);
      assert(reply.entries[0]);
    } else if (name === "control-ui-file") {
      assert.equal(Buffer.from(reply.body).toString(), "# Identity\n- Name: Synthetic benchmark\n");
    } else if (name === "control-ui-public-session-card") {
      assert.equal(Buffer.from(reply).subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    } else if (name === "catalog-page") {
      assert.deepEqual(reply.failures, []);
      assert.equal(reply.message.result.data.length, 16);
      for (const [index, row] of reply.message.result.data.entries()) {
        assert.equal(row.id, `synthetic-${index}`);
        assert.equal(row.source, "cli");
        assert(row.preview.startsWith("Synthetic preview "));
        assert(row.preview.length <= 500);
      }
    } else if (name === "code-mode-node") {
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
  let reconcile;
  async function run(name, cache, prepare, releaseTask, selectedBuildRoot = buildRoot) {
    if (name === "session-transcript-reconcile" && !releaseTask) {
      // Use the real lifecycle owner; fixture creation and admission are outside measurement.
      Object.assign(process.env, environment);
      reconcile ??= await Promise.all([
        import("../../src/state/openclaw-agent-db-lease.js"),
        import("../../src/state/openclaw-state-db.js"),
        import("../../src/state/openclaw-state-worker-context.js"),
        import("../../src/config/sessions/session-accessor.sqlite-worker-coordination.js"),
      ]);
      const [lease, database, contextOwner, coordinationOwner] = reconcile;
      const agentPath = path.join(state, "agents", "benchmark", "agent.sqlite");
      const leaseId = lease.claimOpenClawAgentDatabaseLease({
        agentId: "benchmark",
        path: agentPath,
        env: environment,
      });
      database.closeOpenClawStateDatabase();
      const context = contextOwner.captureOpenClawStateWorkerContext({ env: environment });
      return await coordinationOwner.withSqliteWorkerLifecycleCoordination(
        context,
        `worker-spawn:${leaseId}`,
        async (coordination) => {
          const result = await run(
            name,
            cache,
            prepare,
            {
              input: {
                mode: "release",
                stateDir: state,
                externallySupervised: true,
                leaseId,
                path: agentPath,
              },
              coordination,
            },
            selectedBuildRoot,
          );
          assert.equal(
            database
              .openOpenClawStateDatabase({ env: environment })
              .db.prepare("SELECT lease_id FROM agent_database_leases WHERE lease_id = ?")
              .get(leaseId),
            undefined,
          );
          return result;
        },
        async () => {}, // run() always joins the worker in its finally block.
        "reconciliation",
      );
    }
    const channel = new MessageChannel();
    const releaseChannel = releaseTask ? new MessageChannel() : undefined;
    const released = releaseChannel ? Promise.withResolvers() : undefined;
    void released?.promise.catch(() => {});
    releaseChannel?.port1.on("message", (message) => {
      if (message.type === "lease-released") {
        released.resolve();
      } else {
        released.reject(new Error(JSON.stringify(message)));
      }
    });
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
      ...(values.built ? { execArgv: [] } : {}),
      workerData: {
        entry: pathToFileURL(
          path.join(
            values.built ? selectedBuildRoot : root,
            values.built
              ? `dist/${entries[name].replace(/^src\//, "").replace(/\.ts$/, ".js")}`
              : entries[name],
          ),
        ).href,
        built: values.built,
        cache,
        prepare,
        baselineFiles: prepare ? baselineFiles : undefined,
      },
    });
    const fail = (error) => {
      released?.reject(error);
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
      channel.port1.postMessage(
        {
          taskId: 1,
          input: releaseTask
            ? { ...releaseTask, port: releaseChannel.port2 }
            : requestForWorker(name),
          interactive: true,
          nativeSections: new SharedArrayBuffer(4),
          taskContext: { deletedAgentDatabaseFences: [] },
        },
        releaseTask
          ? [
              releaseChannel.port2,
              ...(releaseTask.coordination.databaseAdmission
                ? [releaseTask.coordination.databaseAdmission]
                : []),
            ]
          : [],
      );
      const reply = await task.promise;
      if (releaseTask) {
        await released.promise;
      } else {
        verify(name, reply);
      }
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
        spawnToReadyMs,
        spawnToFirstReplyMs: spawnToReadyMs + firstRoundTripMs,
        evaluatedModules: result.evaluatedModules,
        parsedSourceBytes: result.parsedSourceBytes,
        overlays: result.overlays,
        hostLoad: os.loadavg(),
      };
    } finally {
      clearTimeout(timeout);
      await worker.terminate();
      channel.port1.close();
      channel.port2.close();
      releaseChannel?.port1.close();
      releaseChannel?.port2.close();
    }
  }
  const report = {
    node: process.version,
    samples,
    baselineDir: values["baseline-dir"] ?? null,
    built: values.built === true,
    buildRoot: values.built ? buildRoot : null,
    comparisonRoot: comparisonRoot ?? null,
    order: comparisonRoot ? "AB/BA per sample: base then candidate on even indices" : "single arm",
    workers: {},
    limitations: [
      values.built
        ? "Built worker graph with native Node loading; debugger census runs after measured intervals"
        : "Source module graph with prepared TypeScript bytes, not shipped dist chunk graph",
      "Cold load count is source-loader-only; census excludes the benchmark module but source mode includes loader modules",
      "Reconcile measures release of an existing synthetic lease, not transcript indexing; fixture admission is outside timing",
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
      const preparation = values.built ? undefined : await run(name, cache, true);
      const arms = comparisonRoot
        ? { base: comparisonRoot, candidate: buildRoot }
        : { candidate: buildRoot };
      const rowsByArm = Object.fromEntries(Object.keys(arms).map((arm) => [arm, []]));
      for (let index = 0; index < samples; index++) {
        const ordered = Object.entries(arms);
        for (const [arm, directory] of index % 2 ? ordered.toReversed() : ordered) {
          rowsByArm[arm].push(await run(name, cache, false, undefined, directory));
        }
      }
      const results = Object.fromEntries(
        Object.entries(rowsByArm).map(([arm, rows]) => [
          arm,
          {
            preparationModules: preparation?.evaluatedModules,
            overlays: preparation?.overlays,
            cold: summarize(rows.map((row) => row.cold)),
            firstTask: summarize(rows.map((row) => row.firstTask)),
            total: summarize(rows.map((row) => row.total)),
            spawnToReadyMs: summarize(rows.map((row) => ({ value: row.spawnToReadyMs }))).value,
            spawnToFirstReplyMs: summarize(rows.map((row) => ({ value: row.spawnToFirstReplyMs })))
              .value,
            parsedSourceBytes: rows.map((row) => row.parsedSourceBytes),
            evaluatedModules: rows.map((row) => row.evaluatedModules),
            rows,
          },
        ]),
      );
      report.workers[name] = comparisonRoot ? results : results.candidate;
      fs.writeFileSync(output, JSON.stringify(report, null, 2));
      console.log(
        JSON.stringify({
          worker: name,
          samples,
          arms: Object.fromEntries(
            Object.entries(results).map(([arm, result]) => [
              arm,
              { total: result.total, cold: result.cold },
            ]),
          ),
        }),
      );
    }
  } finally {
    await reconcile?.[1].closeOpenClawStateDatabaseAsync();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
