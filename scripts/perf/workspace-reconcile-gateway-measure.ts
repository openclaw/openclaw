/**
 * Reconcile synthetic bytes through a real isolated built Gateway and paired worker.
 * Build the selected checkout first; do not rebuild it during measurement.
 * node --import ./scripts/tsx.mjs scripts/perf/workspace-reconcile-gateway-measure.ts \
 *   --repo-root /task/checkout --output-dir /task/new-result --arm candidate
 * Optional: --files 4096 --ballast-mib 8192. Defaults match the Gateway campaign:
 * 4096 small inventory files, two tracked inputs, one binary result, minimal QA DB.
 * Dispatch, first changed turn, warm changed turn and unchanged turn stay separate.
 * Run separate baseline/candidate processes in alternating order, with A/A controls.
 * Linux containers need Node, Git and ps (procps), and an unprivileged fixture user.
 * If a read-only container excludes Git metadata, record the clean source head's
 * mapping to buildManifestSha256 on the host; never mount unrelated Git/home data.
 * This is a small real-Gateway companion to workspace-reconcile-spawn-measure.ts,
 * not the 62k-file owner fixture. The local model provider is synthetic.
 * Reports native asynchronous Gateway launches, synchronous spawn-initiation time,
 * loop delay, main-thread/process CPU, RSS and heapUsed delta (NOT allocation).
 * Captures ChildProcess.prototype.spawn only: spawnSync/execFileSync and broker CPU
 * are excluded. Selected fast-import launches use this asynchronous boundary.
 * Linux requires the real broker; other platforms retain their native fallback.
 * Source/build hashes, logs and metrics remain in output; all owned processes join
 * before temporary fixture cleanup. Failed fixtures remain for diagnosis, with
 * their path in result.json. No existing Gateway or user data is touched.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { formatErrorMessage, toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { createQaGatewayChild } from "../../extensions/qa-lab/api.js";
import { runtimeProcessEntrypoints } from "../../src/infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../src/infra/runtime-worker-url.js";
import { bindInheritedNativeProcessOwner } from "../../src/process/supervisor/inherited-process-lineage.js";
import {
  BASELINE_PROMPT,
  startMidturnProvider,
} from "../../test/e2e/qa-lab/runtime/cloud-worker-midturn-loss-fixture.js";
import {
  closeWireServer,
  connectWireClient,
  createPairedNodeWorkerHost,
  createPublishedWireWorkspace,
  createWireWorkspaceSettlementWaiter,
  startPairedNodeWorkerGateway,
} from "../../test/e2e/qa-lab/runtime/paired-node-worker-wire-fixture.js";
import { stopQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";

const { values } = parseArgs({
  options: {
    "repo-root": { type: "string" },
    "output-dir": { type: "string" },
    arm: { type: "string", default: "candidate" },
    files: { type: "string", default: "4096" },
    "ballast-mib": { type: "string", default: "8192" },
  },
});
assert(values["repo-root"] && values["output-dir"], "--repo-root and --output-dir are required");
const files = Number(values.files);
const ballastMiB = Number(values["ballast-mib"]);
assert(Number.isSafeInteger(files) && files >= 0, "--files must be a nonnegative integer");
assert(Number.isSafeInteger(ballastMiB) && ballastMiB >= 0, "--ballast-mib must be nonnegative");
const repoRoot = await fs.realpath(values["repo-root"]);
const outputDir = path.resolve(values["output-dir"]);
await fs.mkdir(outputDir);
const script = fileURLToPath(import.meta.url);
const preload = path.join(path.dirname(script), "workspace-reconcile-gateway-preload.mjs");
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
async function fileHash(file: string) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) {
    digest.update(chunk);
  }
  return digest.digest("hex");
}
const buildFiles: Record<string, string> = {};
async function fingerprintBuild(relative = "dist") {
  const entries = await fs.readdir(path.join(repoRoot, relative), { withFileTypes: true });
  for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
    const name = `${relative}/${entry.name}`;
    if (entry.isDirectory()) {
      await fingerprintBuild(name);
    } else if (entry.isSymbolicLink()) {
      // Dependency links are part of dist; their contents belong to the lockfile.
      buildFiles[name] = `symlink:${hash(await fs.readlink(path.join(repoRoot, name)))}`;
    } else {
      assert(entry.isFile(), `Build fingerprint requires regular files: ${name}`);
      buildFiles[name] = await fileHash(path.join(repoRoot, name));
    }
  }
}
await fingerprintBuild();
const buildManifest = JSON.stringify(buildFiles, null, 2) + "\n";
await fs.writeFile(path.join(outputDir, "build-files.json"), buildManifest);
const git = (...args: string[]) =>
  execFileSync("git", ["-C", repoRoot, ...args], { stdio: ["ignore", "pipe", "pipe"] });
let source: { head: string; trackedDiffSha256: string; status: string } | { unavailable: string };
try {
  source = {
    head: git("rev-parse", "HEAD").toString().trim(),
    trackedDiffSha256: hash(git("diff", "--binary", "HEAD")),
    status: git("status", "--porcelain").toString(),
  };
} catch {
  // Read-only container projections may deliberately exclude host Git metadata.
  source = {
    unavailable: "Git metadata unavailable; use build manifest and build-info provenance",
  };
}
const provenance = {
  source,
  buildInfo: JSON.parse(await fs.readFile(path.join(repoRoot, "dist/build-info.json"), "utf8")),
  buildManifestSha256: hash(buildManifest),
  lockfileSha256: await fileHash(path.join(repoRoot, "pnpm-lock.yaml")),
  driverSha256: await fileHash(script),
  preloadSha256: await fileHash(preload),
};
const fixtureRoot = await fs.mkdtemp(
  path.join(process.platform === "darwin" ? "/private/tmp" : os.tmpdir(), "oc-reconcile-"),
);
// The source node-host fixture must use the built anchor without source-loader hooks.
const releaseNativeOwner = bindInheritedNativeProcessOwner(
  resolveRuntimeWorkerUrl({ ...runtimeProcessEntrypoints.serviceChildGroupAnchor, root: repoRoot })
    .href,
);
const owner = createQaGatewayChild();
let provider: Awaited<ReturnType<typeof startMidturnProvider>> | undefined;
let published: Awaited<ReturnType<typeof createPublishedWireWorkspace>> | undefined;
let gateway: Awaited<ReturnType<typeof startPairedNodeWorkerGateway>> | undefined;
let operator: Awaited<ReturnType<typeof connectWireClient>> | undefined;
let worker: Awaited<ReturnType<typeof createPairedNodeWorkerHost>> | undefined;
let probePort = 0;
const phases: unknown[] = [];
const startedAt = Date.now();
const inventoryContent = "workspace inventory fixture\n";
const expected = Buffer.from("synthetic result\0with exact CRLF\r\n");
const warmExpected = Buffer.from("synthetic warm result\0with exact CRLF\r\n");
const note = (phase: string) =>
  console.log(JSON.stringify({ phase, elapsedMs: Date.now() - startedAt }));
async function probe(action: string) {
  const response = await fetch(`http://127.0.0.1:${probePort}/${action}`, {
    method: "POST",
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200);
  return (await response.json()) as { rss?: number };
}
async function measured(name: string, operation: () => Promise<void>) {
  const start = await probe(name);
  assert.ok(start.rss! >= ballastMiB * 1024 ** 2 * 0.9375, "Gateway ballast is not resident");
  try {
    await operation();
  } finally {
    phases.push(await probe("end"));
  }
}
let failure: Error | undefined;
try {
  note("fixture creation");
  provider = await startMidturnProvider();
  published = await createPublishedWireWorkspace(fixtureRoot);
  const settlement = createWireWorkspaceSettlementWaiter();
  note("Gateway startup");
  gateway = await startPairedNodeWorkerGateway({
    owner: {
      ...owner,
      start: (params) =>
        owner.start({
          ...params,
          runtimePreloads: [pathToFileURL(preload).href],
          runtimeEnvPatch: {
            OPENCLAW_RECONCILE_MEASURE_DIR: outputDir,
            OPENCLAW_RECONCILE_MEASURE_BALLAST_MIB: String(ballastMiB),
          },
        }),
    },
    providerBaseUrl: provider.baseUrl,
    repoRoot,
    useRepoCli: false,
    command: {
      executablePath: process.execPath,
      argsPrefix: [path.join(repoRoot, "dist/index.js")],
      tempParentDir: fixtureRoot,
    },
  });
  const info = JSON.parse(await fs.readFile(path.join(outputDir, "probe.json"), "utf8"));
  assert.equal(info.pid, gateway.pid);
  probePort = info.port;
  assert.ok(!gateway.logs().includes("spawn broker startup failed"));
  if (process.platform === "linux") {
    assert.ok(gateway.logs().includes("spawn broker ready pid="), "Linux broker must be ready");
  }
  operator = await connectWireClient({
    gateway,
    role: "operator",
    identity: null,
    onEvent: (event) => settlement.onEvent(event),
  });
  await operator.request("sessions.subscribe", {});
  worker = await createPairedNodeWorkerHost({ gateway, operator, root: fixtureRoot, capacity: 1 });
  const key = "agent:qa:workspace-reconcile-measure";
  await operator.request("sessions.create", {
    key,
    agentId: "qa",
    worktree: true,
    permissionMode: "workspace",
    worktreeName: "reconcile-measure",
    worktreeBaseRef: "main",
    cwd: published.source,
  });
  const created = await operator.request<{ session: { execCwd?: string; spawnedCwd?: string } }>(
    "sessions.describe",
    { key },
  );
  const local = created.session.execCwd ?? created.session.spawnedCwd;
  assert.ok(local);
  const inventory = path.join(local, "inventory-load");
  await fs.mkdir(inventory);
  for (let batch = 0; batch < files; batch += 64) {
    await Promise.all(
      Array.from({ length: Math.min(64, files - batch) }, (_, offset) =>
        fs.writeFile(path.join(inventory, `file-${batch + offset}.txt`), inventoryContent),
      ),
    );
  }
  let remote = "";
  let base = "";
  note("dispatch");
  await measured("dispatch", async () => {
    const result = await operator!.request<{
      placement: { state: string; remoteWorkspaceDir: string; workspaceBaseManifestRef: string };
    }>("sessions.dispatch", { key, deviceId: worker!.identity.deviceId }, { timeoutMs: 180_000 });
    assert.equal(result.placement.state, "active");
    remote = result.placement.remoteWorkspaceDir;
    base = result.placement.workspaceBaseManifestRef;
    assert.equal((await fs.readdir(path.join(remote, "inventory-load"))).length, files);
  });
  await fs.writeFile(path.join(remote, "node-result.bin"), expected);
  const turn = async (id: string) => {
    const runId = `reconcile-${id}-${Date.now()}`;
    await operator!.request("chat.send", {
      sessionKey: key,
      message: BASELINE_PROMPT,
      deliver: false,
      idempotencyKey: runId,
    });
    const completed = await operator!.request<{ status: string }>(
      "agent.wait",
      { runId, timeoutMs: 180_000 },
      { timeoutMs: 185_000 },
    );
    assert.equal(completed.status, "ok");
    await worker!.waitForInvokes();
    assert.deepEqual(worker!.invokeErrors, []);
  };
  note("changed turn");
  await measured("changed-turn", async () => {
    await turn("changed");
    await settlement.wait(operator!, key, AbortSignal.timeout(180_000), base);
    assert.deepEqual(await fs.readFile(path.join(local, "node-result.bin")), expected);
  });
  const changed = await operator.request<{
    session: { placement: { workspaceBaseManifestRef: string } };
  }>("sessions.describe", { key });
  const changedManifest = changed.session.placement.workspaceBaseManifestRef;
  assert.equal(typeof changedManifest, "string");
  await fs.writeFile(path.join(remote, "node-result.bin"), warmExpected);
  note("warm changed turn");
  await measured("warm-changed-turn", async () => {
    await turn("warm-changed");
    await settlement.wait(operator!, key, AbortSignal.timeout(180_000), changedManifest);
    assert.deepEqual(await fs.readFile(path.join(local, "node-result.bin")), warmExpected);
  });
  note("unchanged turn");
  await measured("unchanged-turn", async () => {
    await turn("unchanged");
    await settlement.wait(operator!, key, AbortSignal.timeout(180_000));
    assert.deepEqual(await fs.readFile(path.join(local, "node-result.bin")), warmExpected);
  });
} catch (error) {
  failure = toErrorObject(error, "Gateway measurement failed");
} finally {
  const cleanup = await Promise.allSettled([
    gateway && fs.writeFile(path.join(outputDir, "gateway.log"), gateway.logs()),
    worker?.stop(),
    operator?.stopAndWait({ timeoutMs: 2000 }),
    stopQaGatewayFixture(owner),
    provider?.stop(),
    published && closeWireServer(published.server),
  ]);
  releaseNativeOwner();
  const failures = cleanup.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (!failure && !failures.length) {
    await fs
      .rm(fixtureRoot, { recursive: true, force: true })
      .catch((error: unknown) => failures.push(error));
  }
  if (failures.length) {
    failure = new AggregateError([...(failure ? [failure] : []), ...failures], "Cleanup failed");
  }
  await fs.writeFile(
    path.join(outputDir, "result.json"),
    JSON.stringify(
      {
        passed: !failure,
        cleanupPassed: failures.length === 0,
        retainedFixture: failure ? fixtureRoot : undefined,
        error: failure ? formatErrorMessage(failure) : undefined,
        arm: values.arm,
        provenance,
        platform: process.platform,
        node: process.version,
        brokerEnabled: process.platform === "linux",
        ballastMiB,
        inventoryFiles: files,
        fixtureFilesAfterTurn: files + 3,
        inventoryBytes: files * Buffer.byteLength(inventoryContent),
        resultSha256: { changed: hash(expected), warmChanged: hash(warmExpected) },
        dbShape: "minimal isolated QA database",
        startedAt,
        finishedAt: Date.now(),
        phases,
      },
      null,
      2,
    ) + "\n",
  );
  note(failure ? "failed" : "complete");
}
if (failure) {
  throw failure;
}
