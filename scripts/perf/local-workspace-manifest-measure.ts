/**
 * Real state-read worker manifest benchmark, using synthetic repository-shaped files.
 * Node 26.12: node --import ./scripts/tsx.mjs scripts/perf/local-workspace-manifest-measure.ts prepare .local/buf28 [count=24000]
 * Use `prepare-edited` instead of `prepare` to edit 1% of admitted files after
 * storing their original identities. Both versions repeatedly scan those same edits.
 * Run: node --import ./scripts/tsx.mjs scripts/perf/local-workspace-manifest-measure.ts run .local/buf28 <label> <canonical|projection|materialize|replace> [allocation|cpu]
 * `cpu` writes a worker .cpuprofile; `allocation` writes a full .heapprofile.
 * Alternate baseline/candidate labels at least five times. Baseline runs set
 * OPENCLAW_BENCH_BASELINE_DIR to a directory containing the original source paths.
 * OPENCLAW_BENCH_TRACE_GC=1 selects a separate promotion pass, never timing gates.
 * Batch: OPENCLAW_BENCH_BASELINE_DIR=<original-source-dir> node --import ./scripts/tsx.mjs scripts/perf/local-workspace-manifest-measure.ts batch .local/buf28 <label>
 * Batch retains disjoint baseline/candidate processes per instrumentation pass,
 * warms each action once, then runs five counterbalanced pairs serially.
 * Append `<action> control [calls=1]` for five same-source A/A timing pairs,
 * or `<action> control-all [calls=1]` for five A/A pairs in all three passes,
 * or `<action> timing [calls=1]` for five A/B timing pairs. A block's calls run
 * consecutively without forced GC between them; normalize work totals by calls.
 * `<action> extra [calls=1]` runs only the predeclared sixth A/B pair, candidate first.
 * Timings exclude startup, warmup and forced GC. Heap peak is sampled (5 ms plus
 * GC boundaries), a lower bound. Allocation includes objects collected by both
 * minor and major GC. Fixture content is synthetic; only tracked path shape is reused.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { serialize } from "node:v8";
import type { LocalWorkspaceManifestAction } from "../../src/gateway/worker-environments/local-workspace-manifest-scan.js";
import type { WorkerWorkspaceManifest } from "../../src/gateway/worker-environments/workspace-manifest.js";

const [mode, scratchArgument, label, actionName, instrument, callsArgument] = process.argv.slice(2);
assert.ok(["prepare", "prepare-edited", "run", "serve", "batch"].includes(mode ?? ""));
assert.ok(scratchArgument);
const scratch = path.resolve(scratchArgument);
const root = path.join(scratch, "workspace");
const state = path.join(scratch, "state");
const id = "synthetic-workspace";
const baseCommit = "a".repeat(40);
const env = {
  PATH: process.env.PATH,
  HOME: path.join(scratch, "home"),
  OPENCLAW_HOME: path.join(scratch, "home"),
  OPENCLAW_STATE_DIR: state,
  OPENCLAW_CONFIG_PATH: path.join(scratch, "config.json"),
  TMPDIR: path.join(scratch, "tmp"),
  OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
};
Object.assign(process.env, env, {
  DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer",
});
await fs.mkdir(scratch, { recursive: true });
for (const directory of [env.HOME, env.TMPDIR]) {
  await fs.mkdir(directory, { recursive: true });
}
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const operations = Number(callsArgument ?? 1);
assert.ok(Number.isSafeInteger(operations) && operations > 0);
const actionNames = ["materialize", "canonical", "projection", "replace"] as const;
type ActionName = (typeof actionNames)[number];
type MeasurementRequest = { kind: "warm" | "measure" | "stop"; action: ActionName; label: string };

if (mode === "prepare" || mode === "prepare-edited") {
  const count = Number(label ?? 24_000);
  assert.ok(Number.isSafeInteger(count) && count > 0);
  const paths = execFileSync("git", ["ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter(Boolean)
    .slice(0, count);
  assert.ok(paths.length >= Math.min(count, 20_000), "repository fixture is too small");
  assert.equal(await fs.stat(root).catch(() => null), null, "prepare requires a new fixture");
  await fs.mkdir(root, { recursive: true });
  assert.equal(await fs.stat(path.join(root, ".git")).catch(() => null), null, "prepare only once");
  for (const entryPath of paths) {
    const filename = path.join(root, entryPath);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(
      filename,
      path.basename(filename) === ".gitignore" ? "" : "synthetic workspace content\n",
    );
  }
  execFileSync("git", ["init", "--quiet", root]);
  execFileSync("git", ["-C", root, "add", "--all"]);
  const { scanActualWorkspaceManifest } =
    await import("../../src/gateway/worker-environments/workspace-actual-manifest.js");
  const { createLocalWorkspaceManifestTree, localWorkspaceManifestRootReference } =
    await import("../../src/gateway/worker-environments/local-workspace-manifest-tree.js");
  const { serializeWorkerWorkspaceManifest } =
    await import("../../src/gateway/worker-environments/workspace-manifest.js");
  const { buildCacheInputPaths } =
    await import("../../src/gateway/worker-environments/workspace-path-exclusions.js");
  const retained = [...buildCacheInputPaths(paths)];
  const nodes: Parameters<typeof createLocalWorkspaceManifestTree>[0][number][] = [];
  const identities = new Map<string, string>();
  await scanActualWorkspaceManifest({
    root,
    baseCommit,
    buildCacheInputs: new Set(retained),
    onEntry(node, identity) {
      nodes.push(node);
      if (identity) {
        identities.set(node.path, identity);
      }
    },
  });
  const records = createLocalWorkspaceManifestTree(nodes);
  for (const record of records.values()) {
    record.canonicalIdentity = identities.get(record.node.path);
    record.projectionIdentity = record.canonicalIdentity;
  }
  const resultingRoot = localWorkspaceManifestRootReference(records, baseCommit);
  const manifest: WorkerWorkspaceManifest = {
    version: 1,
    baseCommit,
    entries: nodes.filter((node) => node.type !== "directory"),
    directories: nodes.filter((node) => node.type === "directory").map((node) => node.path),
    buildCacheInputs: retained,
  };
  const rawManifest = serializeWorkerWorkspaceManifest(manifest);
  const { openOpenClawStateDatabase, closeOpenClawStateDatabaseAsync } =
    await import("../../src/state/openclaw-state-db.js");
  const { mutateLocalWorkspaceProjection } =
    await import("../../src/gateway/worker-environments/local-workspace-store.kernel.js");
  const database = openOpenClawStateDatabase({ env });
  mutateLocalWorkspaceProjection(database.db, id, {
    kind: "create",
    row: {
      worktree_id: id,
      agent_id: "main",
      session_key: "agent:main:synthetic",
      session_id: "synthetic",
      lifecycle_revision: null,
      projection_path: root,
      base_commit: baseCommit,
      source_paths_json: JSON.stringify(paths),
      baseline_json: null,
      baseline_ref: null,
      checkpoint_json: null,
      pending_ref: null,
      pending_target: null,
      journal_json: null,
      journal_pack: null,
      paused_runtimes_json: null,
      created_at_ms: 1,
    },
  });
  mutateLocalWorkspaceProjection(database.db, id, {
    kind: "update",
    revision: 0,
    patch: { baseline_ref: resultingRoot },
    manifest: {
      previousRoot: null,
      resultingRoot,
      records: [...records.values()],
      removed: [],
      replace: true,
    },
  });
  await fs.writeFile(path.join(scratch, "manifest.json"), rawManifest);
  let expectedRoot = resultingRoot;
  let editedFiles = 0;
  if (mode === "prepare-edited") {
    const files = nodes.filter(
      (node) => node.type === "file" && path.basename(node.path) !== ".gitignore",
    );
    editedFiles = Math.max(1, Math.floor(paths.length / 100));
    assert.ok(files.length >= editedFiles);
    for (let index = 0; index < editedFiles; index++) {
      const node = files[Math.floor((index * files.length) / editedFiles)]!;
      await fs.writeFile(path.join(root, node.path), "synthetic workspace edited content\n");
    }
    const currentNodes: typeof nodes = [];
    await scanActualWorkspaceManifest({
      root,
      baseCommit,
      buildCacheInputs: new Set(retained),
      onEntry(node) {
        currentNodes.push(node);
      },
    });
    expectedRoot = localWorkspaceManifestRootReference(
      createLocalWorkspaceManifestTree(currentNodes),
      baseCommit,
    );
  }
  await fs.writeFile(
    path.join(scratch, "fixture.json"),
    JSON.stringify({
      files: paths.length,
      records: records.size,
      resultingRoot: expectedRoot,
      editedFiles,
      manifestRef: `sha256:${digest(rawManifest)}`,
      buildCacheInputs: retained,
      revision: 1,
    }),
  );
  await closeOpenClawStateDatabaseAsync();
  const { drainGlobalSingletonLifecycleState } =
    await import("../../src/shared/global-singleton.js");
  await drainGlobalSingletonLifecycleState();
  console.log(
    JSON.stringify({
      prepared: paths.length,
      records: records.size,
      resultingRoot: expectedRoot,
      editedFiles,
    }),
  );
} else if (mode === "batch") {
  assert.ok(label && /^[a-zA-Z0-9_-]+$/.test(label));
  const baseline = process.env.OPENCLAW_BENCH_BASELINE_DIR;
  assert.ok(baseline, "batch requires OPENCLAW_BENCH_BASELINE_DIR");
  const control = instrument === "control" || instrument === "control-all";
  const extra = instrument === "extra";
  const selectedActions = actionName ? [actionName as ActionName] : actionNames;
  assert.ok(selectedActions.every((name) => actionNames.includes(name)));
  for (const pass of instrument === "control" || extra || instrument === "timing"
    ? ["timing"]
    : ["timing", "allocation", "promotion"]) {
    const launch = async (side: "base" | "candidate") => {
      const workerLabel = `${label}-${pass}-${side}`;
      const log = await fs.open(path.join(scratch, `${workerLabel}.log`), "wx");
      const childEnv: NodeJS.ProcessEnv = {
        ...process.env,
        OPENCLAW_BENCH_TRACE_GC: pass === "promotion" ? "1" : "0",
      };
      if (side === "candidate" && !control) {
        delete childEnv.OPENCLAW_BENCH_BASELINE_DIR;
      }
      const child = spawn(
        process.execPath,
        [
          "--import",
          "./scripts/tsx.mjs",
          process.argv[1]!,
          "serve",
          scratch,
          workerLabel,
          "materialize",
          pass,
          String(operations),
        ],
        { env: childEnv, stdio: ["ignore", log.fd, log.fd, "ipc"] },
      );
      let pending:
        | { resolve: (value: unknown) => void; reject: (error: Error) => void }
        | undefined;
      const receive = () =>
        new Promise<unknown>((resolve, reject) => {
          pending = { resolve, reject };
        });
      child.on("message", (message) => {
        pending?.resolve(message);
        pending = undefined;
      });
      child.on("error", (error) => {
        pending?.reject(error);
        pending = undefined;
      });
      child.on("exit", (code) => {
        pending?.reject(new Error(`${workerLabel} exited with ${code}; inspect its log`));
        pending = undefined;
      });
      assert.deepEqual(await receive(), { ready: true });
      return {
        request: async (request: MeasurementRequest) => {
          const response = receive();
          child.send(request);
          return await response;
        },
        close: async () => {
          if (child.exitCode !== null) {
            await log.close();
            return;
          }
          const exited = once(child, "exit");
          child.send({ kind: "stop", action: "materialize", label: "stop" });
          await exited;
          await log.close();
        },
      };
    };
    const base = await launch("base");
    const candidate = await launch("candidate");
    try {
      for (const action of selectedActions) {
        console.log(JSON.stringify({ pass, action, warming: true }));
        await base.request({ kind: "warm", action, label: "warm" });
        await candidate.request({ kind: "warm", action, label: "warm" });
        for (let pair = extra ? 6 : 1; pair <= (extra ? 6 : 5); pair++) {
          const sides =
            pair % 2 ? (["base", "candidate"] as const) : (["candidate", "base"] as const);
          for (const side of sides) {
            const requestLabel = `${label}-${pass}-${action}-${pair}-${side}`;
            const response = await (side === "base" ? base : candidate).request({
              kind: "measure",
              action,
              label: requestLabel,
            });
            console.log(JSON.stringify(response));
          }
        }
      }
    } finally {
      await base.close();
      await candidate.close();
    }
  }
} else {
  assert.ok(label && /^[a-zA-Z0-9_-]+$/.test(label));
  assert.ok(actionNames.includes(actionName as ActionName));
  const output = path.join(scratch, "results", label);
  assert.equal(await fs.stat(output).catch(() => null), null, "run requires a new result label");
  await fs.mkdir(output, { recursive: true });
  process.env.OPENCLAW_BENCH_RETAINED_WORKER_DIR = output;
  if (instrument === "allocation") {
    process.env.OPENCLAW_BENCH_SAMPLE_ALLOCATION = "1";
  }
  if (instrument === "cpu") {
    process.env.OPENCLAW_BENCH_SAMPLE_CPU = "1";
  }
  await import("./worker-retained-heap-preload.js");
  const fixture = JSON.parse(await fs.readFile(path.join(scratch, "fixture.json"), "utf8"));
  const rawManifest = await fs.readFile(path.join(scratch, "manifest.json"), "utf8");
  const actionFor = (name: ActionName): LocalWorkspaceManifestAction =>
    name === "replace"
      ? {
          kind: "replace",
          rawManifest,
          manifestRef: fixture.manifestRef,
          buildCacheInputs: fixture.buildCacheInputs,
          patch: {},
        }
      : name === "materialize"
        ? { kind: "materialize" }
        : { kind: "scan", target: name, canonicalRoot: root };
  const { executeExistingOpenClawStateRead } =
    await import("../../src/state/openclaw-state-db-readonly.js");
  const { drainGlobalSingletonLifecycleState } =
    await import("../../src/shared/global-singleton.js");
  const invoke = (name: ActionName) =>
    executeExistingOpenClawStateRead(
      { env },
      {
        type: "localWorkspace.manifest",
        input: { id, revision: fixture.revision, action: actionFor(name) },
      },
      { current: true, live: true },
    );
  try {
    await invoke(actionName as ActionName);
    const readyFiles = (await fs.readdir(output)).filter((file) => file.endsWith(".ready.json"));
    const identities = await Promise.all(
      readyFiles.map(async (file) =>
        JSON.parse(await fs.readFile(path.join(output, file), "utf8")),
      ),
    );
    const workers = identities.filter((worker) =>
      worker.script.startsWith("openclaw-state-read.worker"),
    );
    assert.equal(workers.length, 1, "measurement requires one active state-read worker");
    const worker = workers[0];
    let commandNumber = 0;
    const command = async (operation: string) => {
      const name = `${operation}-${++commandNumber}`;
      const replyFile = worker.commandPath.replace(".command.json", `.${name}.json`);
      await fs.writeFile(`${worker.commandPath}.tmp`, JSON.stringify({ id: name, operation }));
      await fs.rename(`${worker.commandPath}.tmp`, worker.commandPath);
      const deadline = Date.now() + 120_000;
      while (true) {
        const raw = await fs.readFile(replyFile, "utf8").catch(() => undefined);
        if (raw) {
          const result = JSON.parse(raw);
          assert.equal(result.ok, true, JSON.stringify(result));
          return result;
        }
        assert.ok(Date.now() < deadline, `worker command ${name} timed out`);
        await setTimeout(10);
      }
    };
    const measure = async (name: ActionName, resultLabel: string) => {
      const before = await command("collect");
      await command("start");
      const start = performance.now();
      let reply: Awaited<ReturnType<typeof invoke>> = undefined;
      for (let index = 0; index < operations; index++) {
        reply = await invoke(name);
      }
      const elapsedMs = performance.now() - start;
      const measured = await command("stop");
      const after = await command("collect");
      assert.ok(reply && reply.type === "localWorkspace.manifest");
      const value = reply.value;
      if (value.kind === "scan") {
        assert.equal(value.resultingRoot, fixture.resultingRoot);
      }
      const bytes = serialize(reply);
      const result = {
        label: resultLabel,
        action: name,
        node: process.version,
        files: fixture.files,
        editedFiles: fixture.editedFiles ?? 0,
        records: fixture.records,
        operations,
        load: os.loadavg(),
        requestElapsedMs: elapsedMs,
        replyPayloadBytes: bytes.byteLength,
        replyDigest: digest(bytes),
        resultingRoot: value.kind === "scan" ? value.resultingRoot : undefined,
        beforeGcHeapBytes: before.memory.heapUsed,
        afterGcHeapBytes: after.memory.heapUsed,
        ...measured,
      };
      await fs.writeFile(
        path.join(output, `${resultLabel}.result.json`),
        JSON.stringify(result, null, 2),
      );
      return result;
    };
    if (mode === "serve") {
      assert.ok(typeof process.send === "function", "serve is a batch subprocess");
      process.send({ ready: true });
      while (true) {
        // The batch controller is the only writer on this private IPC channel.
        const [request] = (await once(process, "message")) as [MeasurementRequest];
        if (request.kind === "stop") {
          break;
        }
        if (request.kind === "warm") {
          await invoke(request.action);
          process.send({ warmed: request.action });
        } else {
          process.send(await measure(request.action, request.label));
        }
      }
    } else {
      console.log(JSON.stringify(await measure(actionName as ActionName, label)));
    }
  } finally {
    await drainGlobalSingletonLifecycleState();
    if (process.connected) {
      process.disconnect?.();
    }
  }
}
