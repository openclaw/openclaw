// Worker CPU and allocation use per-isolate counters. --sample-allocation writes a
// separate inspector allocation pass; its timing must not be used for latency gates.
// --discovery-skills scales each of four workspaces; --discovery-plugins adds shared contributions.
// --worker identity-avatar-file measures a 64 KiB local avatar: startup, retained heap and warm reads.
// --worker memory-search measures the read worker's import floor; use memory-search-status-measure.ts for actual queries.
// --built loads dist workers; source-mode heap includes the TypeScript loader and is not packaged RSS.
// --build-dir selects a preserved runtime build for --built comparisons.
// --git-operation provisioning measures the common inspection with no .worktreeinclude file.
// Run on the benchmark host: node --import ./scripts/tsx.mjs scripts/perf/worker-module-graphs-measure.mjs --state-dir <owned-dir> --output <json>
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { MessageChannel, Worker } from "node:worker_threads";
import { distribution, installBaselineHook } from "./worker-module-graphs-worker.mjs";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    output: { type: "string" },
    "discovery-skills": { type: "string", default: "8" },
    "discovery-plugins": { type: "string", default: "0" },
    "sample-allocation": { type: "boolean" },
    samples: { type: "string", default: "1200" },
    "start-at": { type: "string" },
    "baseline-dir": { type: "string" },
    "trace-gc": { type: "boolean" },
    snapshots: { type: "boolean" },
    worker: { type: "string" },
    "git-operation": { type: "string", default: "branches" },
    built: { type: "boolean" },
    "build-dir": { type: "string" },
  },
});
assert(values["state-dir"] && values.output, "--state-dir and --output are required");
assert(!values.built || !values["baseline-dir"], "--baseline-dir substitutes source files only");
assert(!values["build-dir"] || values.built, "--build-dir requires --built");
assert(["branches", "provisioning"].includes(values["git-operation"]), "unknown --git-operation");
const state = path.resolve(values["state-dir"]);
const samples = Number(values.samples);
const skillCount = Number(values["discovery-skills"]);
const pluginCount = Number(values["discovery-plugins"]);
assert(
  Number.isSafeInteger(skillCount) && skillCount > 0 && skillCount <= 100,
  "--discovery-skills must be 1–100",
);
assert(
  Number.isSafeInteger(pluginCount) && pluginCount >= 0 && pluginCount <= 100,
  "--discovery-plugins must be 0–100",
);
assert(Number.isSafeInteger(samples) && samples > 0);
const startAt = values["start-at"] === undefined ? undefined : Number(values["start-at"]);
assert(startAt === undefined || (Number.isSafeInteger(startAt) && startAt > 0));
await fs.mkdir(state, { recursive: true });
await fs.mkdir(path.dirname(path.resolve(values.output)), { recursive: true });
for (const name of ["home", "tmp", "state", "repository", "plugin", "scratch"]) {
  await fs.mkdir(path.join(state, name), { recursive: true });
}
Object.assign(process.env, {
  HOME: path.join(state, "home"),
  OPENCLAW_HOME: path.join(state, "home"),
  OPENCLAW_STATE_DIR: path.join(state, "state"),
  TMPDIR: path.join(state, "tmp"),
  OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  OPENCLAW_BUNDLED_SKILLS_DIR: path.join(state, "absent"),
});
installBaselineHook(values["baseline-dir"]);
// Unrelated workers must not inherit different host graphs from the Git comparison.
const { runGitBytes, runGitBuffered } =
  !values.worker || values.worker === "git-operation"
    ? await import("../../src/agents/worktrees/git.ts")
    : {};
const repository = path.join(state, "repository");
const git = (...args) => execFileSync("git", ["-C", repository, ...args], { stdio: "pipe" });
git("init", "-q", "-b", "main");
await fs.writeFile(path.join(repository, "fixture.txt"), "synthetic fixture\n");
git("add", "fixture.txt");
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
const plugin = path.join(state, "plugin");
const entry = path.join(plugin, "index.js");
await fs.writeFile(
  path.join(plugin, "package.json"),
  JSON.stringify({ name: "worker-benchmark-fixture", version: "1.0.0", type: "module" }),
);
await fs.writeFile(entry, "export const fixture = 42;\n");
const environment = {
  HOME: process.env.HOME,
  OPENCLAW_HOME: process.env.OPENCLAW_HOME,
  OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR,
  OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  OPENCLAW_BUNDLED_SKILLS_DIR: process.env.OPENCLAW_BUNDLED_SKILLS_DIR,
};
const pluginContributions = [];
for (let index = 0; index < pluginCount; index++) {
  const rootDir = path.join(state, `contribution-${index}`);
  const skillDir = path.join(rootDir, "skills", `plugin-skill-${index}`);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    `---\nname: plugin-skill-${index}\ndescription: Provider plugin skill ${index}\n---\nSynthetic instructions.\n`,
  );
  pluginContributions.push({
    id: `provider-${index}`,
    origin: "bundled",
    rootDir,
    roots: ["skills"],
  });
}
const requests = [];
for (let workspace = 0; workspace < 4; workspace++) {
  const directory = path.join(state, `workspace-${workspace}`);
  const skills = path.join(directory, "skills");
  for (let index = 0; index < skillCount; index++) {
    const skill = path.join(skills, `skill-${index}`);
    await fs.mkdir(skill, { recursive: true });
    await fs.writeFile(
      path.join(skill, "SKILL.md"),
      `---\nname: skill-${index}\ndescription: Synthetic skill ${index}\n---\nSynthetic instructions.\n`,
    );
  }
  requests.push({
    key: directory,
    environment,
    selection: {
      kind: pluginCount ? "planned" : "selected",
      ...(pluginCount
        ? {
            plan: {
              input: {
                workspaceDir: directory,
                environment,
                acpRuntimeAvailable: false,
                pluginContributions,
                options: {
                  managedSkillsDir: path.join(state, "managed"),
                  bundledSkillsDir: path.join(state, "absent"),
                  pluginSkillsDir: path.join(state, "generated-plugin-skills"),
                },
              },
            },
          }
        : {}),
      request: {
        sourcePlan: {
          workspaceDir: directory,
          managedSkillsDir: skills,
          pluginSkillRoots: [],
          roots: [{ dir: skills, source: "openclaw-workspace", tier: "workspace" }],
        },
        limits: {
          maxCandidatesPerRoot: 100,
          maxSkillsLoadedPerSource: 100,
          maxSkillFileBytes: 16384,
        },
        additionalBins: [],
      },
    },
  });
}
const admission = {
  owners: new Map(),
  managedRoots: new Map(),
  receipts: new Map(),
  files: new Map(),
  namespaces: new Map(),
};
// Capture transfers the selected owner's receipts, but all prepared physical facts.
// This new standalone JS fixture has no selected owner or previously published receipt.
for (let index = 0; index < 100; index++) {
  const root = path.join(state, "foreign-synthetic", `plugin-${index}`);
  admission.managedRoots.set(root, "installed");
  const namespace = {
    sourceDirectory: root,
    capturedRoot: `${root}-capture`,
    managed: true,
    members: {},
  };
  for (let file = 0; file < 50; file++) {
    const source = path.join(root, `file-${file}.js`);
    const fact = {
      sourceIdentity: `synthetic-${index}-${file}`,
      capturedIdentity: `capture-${index}-${file}`,
      contentHash: "a".repeat(64),
      sizeBytes: 100,
      capturedPath: `${source}-capture`,
      namespace: root,
    };
    admission.files.set(source, fact);
    namespace.members[source] = {
      source,
      sourceIdentity: fact.sourceIdentity,
      capturedIdentity: fact.capturedIdentity,
      boundaryChecked: true,
      contentHash: fact.contentHash,
      sizeBytes: 100,
    };
  }
  admission.namespaces.set(root, namespace);
}
const initialization = Buffer.from(
  JSON.stringify({
    __openclawCatalog: [],
    __openclawNamespaces: [],
    __openclawApiFiles: [],
    __openclawSwarmEnabled: false,
  }),
);
const initBuffer = new SharedArrayBuffer(initialization.length);
new Uint8Array(initBuffer).set(initialization);
const entries = {
  "identity-avatar-file": "src/agents/identity-avatar-file.worker.ts",
  "git-operation": "src/infra/git-operation.worker.ts",
  "plugin-generation-preparation": "src/plugins/plugin-generation-preparation.worker.ts",
  "code-mode-node": "src/agents/code-mode-node.worker.ts",
  discovery: "src/skills/runtime/discovery.worker.ts",
  "memory-search": "extensions/memory-core/src/memory/manager-search.worker.ts",
};
const report = {
  samples,
  fixture: {
    workspaces: 4,
    skillsPerWorkspace: skillCount,
    pluginCount,
    admissionRoots: 100,
    admissionFiles: 5000,
  },
  limitations: [
    "Synthetic worker-boundary workload, not a full Team-shaped Gateway",
    "Main-isolate heap and total allocated bytes are not measured",
    "GC time and promotion require separate trace-gc-nvp isolate attribution",
  ],
  baselineDir: values["baseline-dir"] ?? null,
  built: values.built === true,
  buildDir: values["build-dir"] ? path.resolve(values["build-dir"]) : null,
  gitOperation: values["git-operation"],
  workers: {},
};
if (values.worker) {
  assert(Object.hasOwn(entries, values.worker), "unknown --worker");
}

async function host(request) {
  assert.equal(request.type, "git.batch");
  return Promise.all(
    request.input.requests.map(async ({ type, input }) => {
      assert(type === "git.text" || type === "git.buffer", `unexpected Git host effect ${type}`);
      const execute = type === "git.text" ? runGitBytes : runGitBuffered;
      try {
        return { ok: true, value: await execute(input.cwd, input.args, input.options) };
      } catch (error) {
        return { ok: false, error: { name: error.name, message: error.message, code: error.code } };
      }
    }),
  );
}

for (const [name, relative] of Object.entries(entries)) {
  if (values.worker && values.worker !== name) {
    continue;
  }
  const diagnostics = new MessageChannel();
  const tasks = new MessageChannel();
  const rssBeforeWorker = process.memoryUsage().rss;
  const worker = new Worker(new URL("./worker-module-graphs-worker.mjs", import.meta.url), {
    ...(values.built
      ? { execArgv: ["--import", new URL("./team-shape-stress-loader.mjs", import.meta.url).href] }
      : {}),
    workerData: {
      name,
      ...(name === "identity-avatar-file"
        ? { baselineFiles: ["src/agents/identity-avatar-file.ts"] }
        : {}),
      entry: new URL(
        values.built
          ? name === "memory-search"
            ? "dist/extensions/memory-core/memory-search.worker.js"
            : relative.replace(/^src\//, "dist/").replace(/\.ts$/, ".js")
          : relative,
        values["build-dir"]
          ? pathToFileURL(`${path.resolve(values["build-dir"])}${path.sep}`)
          : new URL("../../", import.meta.url),
      ).href,
      diagnostics: diagnostics.port2,
      baselineDir: values["baseline-dir"],
      traceGc: values["trace-gc"],
      sampleAllocation: values["sample-allocation"]
        ? path.join(state, `${name}.allocation.json`)
        : undefined,
    },
    transferList: [diagnostics.port2],
  });
  const pending = new Map();
  let sequence = 0;
  let task;
  let fatal;
  const ready = Promise.withResolvers();
  const taskReady = Promise.withResolvers();
  // The handshake promises are awaited in order; observe early startup failures now.
  void taskReady.promise.catch(() => {});
  worker.on("error", (error) => {
    fatal = error;
    ready.reject(error);
    taskReady.reject(error);
    task?.reject(error);
    for (const promise of pending.values()) {
      promise.reject(error);
    }
  });
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
    } else if (message.status === "request") {
      void host(message.value)
        .then((input) => {
          tasks.port1.postMessage({
            taskId: message.taskId,
            responseId: message.id,
            input,
          });
        })
        .catch(/** @param {unknown} error */ (error) => task?.reject(error));
    } else if (message.status === "ok") {
      task?.resolve(message.value);
    } else if (message.status === "failed") {
      task?.reject(new Error(message.error));
    }
  });
  const diagnose = (operation, snapshot) => {
    if (fatal) {
      throw fatal;
    }
    const promise = Promise.withResolvers();
    pending.set(++sequence, promise);
    diagnostics.port1.postMessage({ id: sequence, operation, snapshot });
    return promise.promise;
  };
  const run = async (input) => {
    if (fatal) {
      throw fatal;
    }
    task = Promise.withResolvers();
    tasks.port1.postMessage({
      taskId: ++sequence,
      input,
      interactive: true,
      nativeSections: new SharedArrayBuffer(4),
      taskContext: { deletedAgentDatabaseFences: [] },
    });
    const timeout = setTimeout(() => task?.reject(new Error(`${name} task timed out`)), 120000);
    try {
      return await task.promise;
    } finally {
      clearTimeout(timeout);
      task = undefined;
    }
  };
  try {
    await ready.promise;
    worker.postMessage({ type: "openclaw.worker-task-port", port: tasks.port2 }, [tasks.port2]);
    await taskReady.promise;
    const cold = await diagnose("inspect");
    let resolveHandle;
    if (name === "plugin-generation-preparation") {
      const captured = await run({
        operation: "capture",
        captureId: 1,
        rootDir: plugin,
        entryFile: entry,
        storage: { stateDir: process.env.OPENCLAW_STATE_DIR, placement: "temporary" },
        installRoots: {
          extensionsDir: plugin,
          gitDir: path.join(state, "git"),
          npmDir: path.join(state, "npm"),
          stateDir: process.env.OPENCLAW_STATE_DIR,
        },
        readOnly: true,
        scratch: path.join(state, "scratch"),
        admission,
      });
      assert(!captured.error, JSON.stringify(captured.error));
      assert.equal(captured.value.kind, "object");
      resolveHandle = captured.value.entries.find(([key]) => key === "resolve")?.[1];
      assert.equal(resolveHandle?.kind, "function");
    }
    const request = () =>
      name === "memory-search"
        ? { kind: "prewarm" }
        : name === "identity-avatar-file"
          ? { workspaceDir: state, source: "avatar.png", readBody: true }
          : name === "git-operation"
            ? values["git-operation"] === "provisioning"
              ? { type: "worktree.provisioning-inspection", input: { sourceRoot: repository } }
              : { type: "repository.branches", input: { repoRoot: repository } }
            : name === "plugin-generation-preparation"
              ? {
                  operation: "call",
                  handle: resolveHandle.id,
                  args: [{ kind: "value", value: entry }],
                  asynchronous: false,
                }
              : name === "discovery"
                ? { kind: "scan", path: process.env.PATH, requests }
                : {
                    kind: "exec",
                    source:
                      "const values = Array.from({length: 128}, (_, i) => i); return values.reduce((a, b) => a + b, 0);",
                    initialization: initBuffer,
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
    const verify = (reply) => {
      if (name === "memory-search") {
        assert.deepEqual(reply, { kind: "prewarm" });
      } else if (name === "identity-avatar-file") {
        assert(reply.ok);
        assert.equal(reply.file.body.byteLength, 65536);
        assert.equal(reply.file.body[0], 42);
        assert.equal(reply.file.body[65535], 42);
      } else if (name === "git-operation") {
        assert(reply.ok, JSON.stringify(reply.error));
        if (values["git-operation"] === "provisioning") {
          assert.deepEqual(reply.value, { paths: [], estimatedBytes: 0 });
          return;
        }
        assert.equal(reply.value.headBranch, "main");
        assert(
          reply.value.branches.some((branch) => branch.name === "main" && branch.kind === "local"),
        );
      } else if (name === "plugin-generation-preparation") {
        assert(!reply.error, JSON.stringify(reply.error));
        assert.equal(reply.value.kind, "value");
        assert.equal(typeof reply.value.value, "string");
      } else if (name === "discovery") {
        assert.equal(reply.kind, "scan");
        assert.equal(reply.results.length, 4);
        for (const result of reply.results) {
          assert.equal(
            new Set(result.sources.entries.map((skillEntry) => skillEntry.skill.name)).size,
            skillCount + pluginCount,
          );
        }
      } else {
        assert.equal(reply.status, "completed", JSON.stringify(reply));
        assert.equal(reply.value.json, "8128");
      }
    };
    if (name === "identity-avatar-file") {
      await fs.writeFile(path.join(state, "avatar.png"), Buffer.alloc(65536, 42));
    }
    const firstTaskStarted = performance.now();
    const initial = await run(request());
    const firstTaskMs = performance.now() - firstTaskStarted;
    verify(initial);
    if (name === "plugin-generation-preparation") {
      assert.equal(
        await fs.readFile(initial.value.value, "utf8"),
        await fs.readFile(entry, "utf8"),
      );
    }
    for (let index = 1; index < 10; index++) {
      verify(await run(request()));
    }
    const warm = await diagnose(
      "inspect",
      values.snapshots ? path.join(state, `${name}.heapsnapshot`) : undefined,
    );
    await diagnose("prepare");
    if (startAt !== undefined) {
      const remaining = startAt - Date.now();
      assert(remaining > 0, "Preparation missed the paired start deadline; discard and rerun");
      await delay(remaining);
    }
    await diagnose("begin");
    const latency = [];
    const hostLoadAtStart = os.loadavg();
    const startedAt = Date.now();
    const started = performance.now();
    for (let index = 0; index < samples; index++) {
      const before = performance.now();
      const result = await run(request());
      latency.push(performance.now() - before);
      verify(result);
    }
    const elapsedMs = performance.now() - started;
    const diagnosticsResult = await diagnose("end");
    const retained = await diagnose("inspect");
    if (name === "git-operation" && values["git-operation"] === "branches") {
      git("branch", "observed-after-measurement");
      const changed = await run(request());
      verify(changed);
      assert(changed.value.branches.some((branch) => branch.name === "observed-after-measurement"));
    }
    if (name === "plugin-generation-preparation") {
      const closed = await run({ operation: "close" });
      assert(!closed.error, JSON.stringify(closed.error));
      assert.equal(closed.resources, 0);
    }
    report.workers[name] = {
      isolateCount: 1,
      firstTaskMs,
      coldProcessRssDeltaBytes: cold.memory.rss - rssBeforeWorker,
      resultHash: createHash("sha256").update(JSON.stringify(initial)).digest("hex"),
      cold,
      warm,
      retained,
      hostLoadAtStart,
      hostLoadAtEnd: os.loadavg(),
      startedAt,
      elapsedMs,
      latencyMs: distribution(latency),
      ...diagnosticsResult,
    };
    await fs.writeFile(path.resolve(values.output), JSON.stringify(report, null, 2));
    console.log(
      JSON.stringify({
        worker: name,
        samples,
        heapUsed: retained.heap.used_heap_size,
        scripts: retained.scriptCount,
        latencyMs: distribution(latency),
      }),
    );
  } finally {
    await worker.terminate();
    tasks.port1.close();
    diagnostics.port1.close();
  }
}
