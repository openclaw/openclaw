import fs from "node:fs";
import path from "node:path";
import { setImmediate as checkpoint } from "node:timers/promises";
import { BroadcastChannel } from "node:worker_threads";
import { threadId } from "node:worker_threads";
import { beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { withinTest } from "../../test/helpers/promise.js";
import * as captureResources from "../plugins/plugin-capture-native-resource.client.js";
import { sweepPluginSourceCapturesForTest } from "../plugins/plugin-source-capture-directory.test-support.js";
import { createDeferredCore, type Deferred } from "../shared/deferred.js";
import { observeMainThreadFs } from "../test-utils/main-thread-fs-spies.test-support.js";
import { PREPARED_MODEL_CATALOG_WORKER_TIMEOUT_MS } from "./model-catalog-timeouts.js";
import { readFixtureLines } from "./prepared-model-catalog-worker.shared.test-support.js";
import { createCatalogFixture } from "./prepared-model-catalog-worker.test-support.js";
import { writeFixtureFiles } from "./prepared-model-catalog-worker.test-support.js";
import {
  catalogEntry,
  EXTERNAL_AUTH_PROFILE_ID,
  PROVIDER_ID,
} from "./prepared-model-catalog-worker.test-support.js";
import { loadPreparedModelRuntimeAuth } from "./prepared-model-runtime-auth.js";
import { closePreparedModelRuntimeSnapshots } from "./prepared-model-runtime.lifecycle.js";
import { registerPreparedModelRuntimePublicationListener } from "./prepared-model-runtime.publication-events.js";
import { createCatalogFleetFixture } from "./test-helpers/prepared-model-catalog-fleet-fixture.js";
import { createStaticCatalogSnapshotFixture } from "./test-helpers/prepared-model-catalog-static-fixture.js";
import {
  readCatalogDiscoveryCaptures,
  usePreparedCatalogWorkerFixtures,
} from "./test-helpers/prepared-model-catalog-worker-fixture.js";

const { makeTempDir, retireAfterTest, waitForWorkers, readCatalogWorkers } =
  usePreparedCatalogWorkerFixtures();
const createStaticSnapshot = createStaticCatalogSnapshotFixture({ makeTempDir, retireAfterTest });

beforeEach(() => {
  vi.stubEnv("CODEX_HOME", makeTempDir("openclaw-worker-empty-codex-"));
});

it.for([
  { owner: "configured Gateway", prepareInboundPluginRegistry: true, version: "built" },
  { owner: "standalone", prepareInboundPluginRegistry: false, version: "v1" },
])(
  "keeps the $owner artifact selection in catalog and auth workers",
  async ({ version, prepareInboundPluginRegistry }, { signal }) => {
    const captureReleases = new Map<string, Promise<void>>();
    const createOwner = captureResources.createPluginCaptureOwner;
    const observeCapture = vi
      .spyOn(captureResources, "createPluginCaptureOwner")
      .mockImplementation(async (...args) => {
        const owner = await createOwner(...args);
        const releases = new Map<number, Deferred>();
        return {
          ...owner,
          createSource: async (...params) => {
            const root = await owner.createSource(...params);
            const released = createDeferredCore();
            releases.set(params[0], released);
            captureReleases.set(root.directory, released.promise);
            return root;
          },
          releaseSource: (id) => {
            const pending = owner.releaseSource(id);
            releases.get(id)?.resolve(pending);
            return pending;
          },
        };
      });
    retireAfterTest(() => observeCapture.mockRestore());
    const { snapshot, root, env, supersede } = await createStaticSnapshot(
      0,
      {},
      {
        builtPluginVersion: "built",
        prepareInboundPluginRegistry,
      },
    );
    using observedFs = observeMainThreadFs();
    await snapshot.loadFullModelCatalog!();
    const auth = await loadPreparedModelRuntimeAuth(snapshot, {
      providerIds: [PROVIDER_ID],
    });
    // The foreground read can return starter rows while cold discovery continues.
    await expect
      .poll(() => snapshot.readFullModelCatalog?.()?.entries, { timeout: 30_000 })
      .toContainEqual(catalogEntry(`plugin-generation-${version}`));
    expect(auth?.authStore.profiles[EXTERNAL_AUTH_PROFILE_ID]).toMatchObject({
      access: `${version}:A`,
    });
    expect(new Set(readFixtureLines(root, "discovery-artifacts.txt"))).toEqual(new Set([version]));
    const captures = readCatalogDiscoveryCaptures(root);
    const exists = (capture: (typeof captures)[number]) => fs.existsSync(capture.filename);
    const workerCaptures = captures.filter((capture) => capture.threadId !== threadId);
    const parentCaptures = captures.filter((capture) => capture.threadId === threadId);
    expect(workerCaptures.length).toBeGreaterThan(0);
    expect(parentCaptures.length).toBeGreaterThan(0);
    expect(captures.every(exists)).toBe(true);
    const filename = workerCaptures[0]!.filename;
    const captureRoot = filename.slice(0, filename.indexOf(`${path.sep}openclaw-plugin-build-`));
    const instanceRoot = path.dirname(path.dirname(captureRoot));
    expect(path.basename(captureRoot)).toMatch(/^openclaw-model-catalog-/);
    const stateDir = env.OPENCLAW_STATE_DIR!;
    expect(path.dirname(instanceRoot)).toBe(path.join(stateDir, "tmp", "plugin-captures"));
    expect(fs.existsSync(path.join(instanceRoot, "owner.sqlite"))).toBe(true);
    const old = new Date(Date.now() - 2 * 60 * 60 * 1_000);
    fs.utimesSync(instanceRoot, old, old);
    await sweepPluginSourceCapturesForTest(stateDir);
    expect(fs.existsSync(filename)).toBe(true);
    const exitRequested = createDeferredCore();
    const allowExit = createDeferredCore();
    const worker = readCatalogWorkers().find(
      (candidate) => candidate.threadId === workerCaptures[0]!.threadId,
    );
    expect(worker).toBeDefined();
    expect(worker?.resourceLimits).toMatchObject({
      maxOldGenerationSizeMb: 512,
      maxYoungGenerationSizeMb: 32,
    });
    const terminate = worker!.terminate.bind(worker!);
    const resume = () => allowExit.resolve();
    signal.addEventListener("abort", resume, { once: true });
    if (signal.aborted) {
      resume();
    }
    const termination = vi.spyOn(worker!, "terminate").mockImplementation(async () => {
      exitRequested.resolve();
      await allowExit.promise;
      return terminate();
    });
    try {
      supersede();
      await withinTest(exitRequested.promise, signal);
      await sweepPluginSourceCapturesForTest(stateDir);
      expect(workerCaptures.every(exists)).toBe(true);
    } finally {
      signal.removeEventListener("abort", resume);
      resume();
      termination.mockRestore();
    }
    await waitForWorkers();
    const released = captureReleases.get(captureRoot);
    expect(released, "the worker capture release owner was observed").toBeDefined();
    await withinTest(released!, signal);
    expect(fs.existsSync(captureRoot)).toBe(false);
    expect(workerCaptures.filter(exists)).toEqual([]);
    expect(parentCaptures.every(exists)).toBe(true);
    expect(
      observedFs
        .stacks()
        .filter(({ stack }) => stack.includes("prepared-model-catalog-worker.pool")),
    ).toEqual([]);
  },
);

async function createGatewayNativeAdmissionFixture(gateCount: number, signal: AbortSignal) {
  const fixture = await createCatalogFixture(makeTempDir, 0);
  const pluginRoot = path.join(fixture.root, "plugin");
  const dependency = path.join(pluginRoot, "node_modules", "native-fixture");
  fs.mkdirSync(dependency, { recursive: true });
  writeFixtureFiles(dependency, {
    "package.json": { name: "native-fixture", version: "1.0.0", main: "index.cjs" },
    "index.cjs": 'module.exports = require.resolve("./artifact-0.exe");',
  });
  const binary = path.join(dependency, "artifact-0.exe");
  fs.writeFileSync(binary, "synthetic native companion");

  const admissionMarker = path.join(fixture.root, "native-admissions.txt");
  const providerHold = path.join(fixture.root, "provider-hold");
  const authHold = path.join(fixture.root, "auth-hold");
  const broadcastName = `catalog-admission:${fixture.root}`;
  writeFixtureFiles(pluginRoot, {
    "index.cjs": `const fs = require("node:fs");
const path = require("node:path");
const { BroadcastChannel, threadId } = require("node:worker_threads");
const receipts = new BroadcastChannel(${JSON.stringify(broadcastName)});
receipts.unref();
let native;
if (threadId !== ${threadId}) {
  const { realpathSync: realpath, linkSync: link, symlinkSync: symlink } = fs;
  const referenceDirectories = new Map();
  let elapsed = 0;
  const now = performance.now.bind(performance);
  Object.defineProperty(performance, "now", { configurable: true, value: () => now() + elapsed });
  fs.symlinkSync = (source, target, ...options) => {
    if (String(source).includes("admission-") && String(target).endsWith(".exe")) {
      throw Object.assign(new Error("fixture Windows file-symlink restriction"), { code: "EPERM" });
    }
    return symlink(source, target, ...options);
  };
  fs.linkSync = (source, target) => {
    link(source, target);
    if (String(source).includes("admission-") && !String(target).includes("admission-")) {
      referenceDirectories.set(path.dirname(String(target)), path.dirname(String(source)));
    }
  };
  const held = new Set();
  fs.realpathSync = Object.assign(function(filename, ...options) {
    const resolved = realpath(filename, ...options);
    if (held.size < ${gateCount} && !held.has(resolved) && referenceDirectories.has(path.dirname(String(filename))) && String(filename).endsWith(".exe")) {
      held.add(resolved);
      fs.appendFileSync(${JSON.stringify(admissionMarker)}, JSON.stringify({ event: held.size === 1 ? "started" : "member", filename: __filename, native: resolved, admission: referenceDirectories.get(path.dirname(String(filename))) }) + "\\n");
      const gate = new Int32Array(new SharedArrayBuffer(8));
      receipts.postMessage(gate.buffer);
      Atomics.wait(gate, 0, 0);
      elapsed += Atomics.load(gate, 1);
    }
    return resolved;
  }, realpath);
  try {
    native = require("native-fixture");
    fs.appendFileSync(${JSON.stringify(admissionMarker)}, JSON.stringify({ event: "admitted", filename: __filename, native }) + "\\n");
  } finally {
    Object.assign(fs, { realpathSync: realpath, linkSync: link, symlinkSync: symlink });
  }
}
module.exports = { id: ${JSON.stringify(PROVIDER_ID)}, register(api) {
  api.registerProvider({ id: ${JSON.stringify(PROVIDER_ID)}, label: "Admission fixture", auth: [],
    async prepareSyntheticAuth({ signal }) {
      if (!fs.existsSync(${JSON.stringify(authHold)})) return;
      await new Promise((resolve, reject) => {
        const fail = () => {
          receipts.removeEventListener("message", message);
          signal?.removeEventListener("abort", fail);
          reject(new Error("fixture parent auth failed"));
        };
        const message = ({ data }) => { if (data === "fail-auth") fail(); };
        receipts.addEventListener("message", message);
        signal?.addEventListener("abort", fail, { once: true });
        if (signal?.aborted) fail();
        else receipts.postMessage("auth");
      });
    },
    catalog: { async run() {
      fs.appendFileSync(${JSON.stringify(admissionMarker)}, JSON.stringify({ event: "catalog", filename: __filename, native }) + "\\n");
      if (fs.existsSync(${JSON.stringify(providerHold)})) {
        receipts.postMessage("provider");
        await new Promise(() => {});
      }
      return { provider: { api: "openai-completions", baseUrl: "https://fixture.invalid/v1",
        models: [{ id: "native-admitted", name: "Admitted model" }] } };
    } },
  });
} };`,
  });
  const makeGate = () => createDeferred<Int32Array<SharedArrayBuffer>>();
  const entered = Array.from({ length: gateCount }, makeGate);
  const gates: Int32Array<SharedArrayBuffer>[] = [];
  const providerEntered = createDeferred();
  const authEntered = createDeferred();
  const broadcastChannel = new BroadcastChannel(broadcastName);
  broadcastChannel.addEventListener("message", ({ data }: { data: unknown }) => {
    if (data instanceof SharedArrayBuffer) {
      const gate = new Int32Array(data);
      gates.push(gate);
      if (closing) {
        release(gate);
      } else {
        entered[gates.length - 1]?.resolve(gate);
      }
    } else if (data === "provider") {
      providerEntered.resolve();
    } else if (data === "auth") {
      fs.rmSync(authHold, { force: true });
      authEntered.resolve();
    }
  });
  const release = (gate: Int32Array<SharedArrayBuffer>, elapsed = 0) => {
    Atomics.store(gate, 1, elapsed);
    Atomics.store(gate, 0, 1);
    Atomics.notify(gate, 0);
  };
  let unsubscribe = () => {};
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      unsubscribe();
      for (const gate of gates) {
        release(gate);
      }
      fs.rmSync(providerHold, { force: true });
      fs.rmSync(authHold, { force: true });
      try {
        await closePreparedModelRuntimeSnapshots();
      } finally {
        broadcastChannel.close();
      }
    })());
  retireAfterTest(close);
  const fleet = await createCatalogFleetFixture(makeTempDir)(
    (seed) => {
      seed.config.plugins.load.paths = [path.join(pluginRoot, "index.cjs")];
    },
    true,
    { agentCount: 1, publication: "individual" },
  );
  const snapshot = fleet.snapshots[0]!;
  const failures: string[] = [];
  unsubscribe = registerPreparedModelRuntimePublicationListener((event) => {
    if (event.phase === "catalog-failed") {
      failures.push(event.phase);
    }
  });
  const started = performance.now();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const fakeNow = performance.now.bind(performance);
  const clock = vi.spyOn(performance, "now").mockImplementation(() => started + fakeNow());
  return {
    snapshot,
    failures,
    entered,
    release,
    async [Symbol.asyncDispose]() {
      clock.mockRestore();
      vi.useRealTimers();
      await close();
    },
    wait<T>(gate: PromiseLike<T>, operation: PromiseLike<unknown>, message: string) {
      return withinTest(awaitGateBeforeSettlement(gate, operation, message), signal);
    },
    settled<T>(work: PromiseLike<T>) {
      return withinTest(work, signal);
    },
    /** Host sleep: the clock jumps, then each overdue timer fires once at the resumed time. */
    async freeze(ms: number) {
      const resumedAt = performance.now() + ms;
      clock.mockImplementation(() => resumedAt);
      await vi.advanceTimersByTimeAsync(ms);
      clock.mockImplementation(() => started + fakeNow());
    },
    holdProvider() {
      fs.writeFileSync(providerHold, "");
      return providerEntered.promise;
    },
    holdAuth() {
      fs.writeFileSync(authHold, "");
      const completed = loadPreparedModelRuntimeAuth(snapshot, { providerIds: [PROVIDER_ID] });
      void completed.catch(() => {});
      return { entered: authEntered.promise, completed };
    },
    failAuth: broadcastChannel.postMessage.bind(broadcastChannel, "fail-auth"),
    records: () =>
      fs
        .readFileSync(admissionMarker, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    refresh() {
      const foreground = snapshot.loadFullModelCatalog!({ refresh: true });
      void foreground.catch(() => {});
      const completed = snapshot.loadFullModelCatalog!({ refresh: true, wait: true });
      void completed.catch(() => {});
      return { foreground, completed };
    },
  };
}
it("keeps stalled native admission terminal after parent auth failure", async ({ signal }) => {
  await using fixture = await createGatewayNativeAdmissionFixture(1, signal);
  const first = fixture.refresh();
  await fixture.wait(fixture.entered[0]!.promise, first.completed, "Native capture did not enter");
  const worker = readCatalogWorkers()[0]!;
  const exited = new Promise<number>((resolve) => {
    worker.once("exit", resolve);
  });
  await checkpoint();
  await vi.advanceTimersByTimeAsync(2_000);
  const auth = fixture.holdAuth();
  await fixture.wait(auth.entered, auth.completed, "Parent auth probe did not enter");
  await vi.advanceTimersByTimeAsync(PREPARED_MODEL_CATALOG_WORKER_TIMEOUT_MS - 1_000);
  expect(fixture.failures).toHaveLength(1);
  const failure = await first.completed.catch((error: unknown) => error);
  expect(failure).toMatchObject({ name: "PreparedModelCatalogAdmissionStalledError" });
  await expect(first.completed).rejects.toThrow(PROVIDER_ID);
  await expect(first.completed).rejects.toThrow("native reference verification");
  await expect(first.completed).rejects.toBe(failure);
  const retained = await fixture.settled(first.foreground);
  expect([retained.refreshFailed, retained.pendingProviders]).toEqual([true, undefined]);
  expect(fixture.snapshot.isCurrent()).toBe(true);
  await fixture.settled(exited);
  expect(fixture.failures).toHaveLength(1);
  await expect(fixture.refresh().completed).rejects.toBe(failure);
  // A later parent-probe error must not recover the terminally stalled shared pool.
  fixture.failAuth();
  await expect(fixture.settled(auth.completed)).rejects.toThrow("fixture parent auth failed");
  await vi.advanceTimersByTimeAsync(PREPARED_MODEL_CATALOG_WORKER_TIMEOUT_MS * 2);
  expect(fixture.snapshot.isCurrent()).toBe(true);
  expect(readCatalogWorkers()).toHaveLength(1);
  expect(worker.threadId).toBe(-1);
  const records = fixture.records();
  expect(records.filter(({ event }) => event === "started")).toHaveLength(1);
  expect(records.some(({ event }) => event === "admitted" || event === "catalog")).toBe(false);
  expect([retained.refreshFailed, retained.pendingProviders]).toEqual([true, undefined]);
});
it("does not count host sleep toward the native admission stall", async ({ signal }) => {
  await using fixture = await createGatewayNativeAdmissionFixture(1, signal);
  const first = fixture.refresh();
  const gate = await fixture.wait(
    fixture.entered[0]!.promise,
    first.completed,
    "Native capture did not enter",
  );
  await checkpoint();
  // Two sleeps longer than the stall budget, one second apart.
  await fixture.freeze(PREPARED_MODEL_CATALOG_WORKER_TIMEOUT_MS + 4_000);
  await vi.advanceTimersByTimeAsync(1_000);
  await fixture.freeze(PREPARED_MODEL_CATALOG_WORKER_TIMEOUT_MS + 4_000);
  expect(fixture.failures).toEqual([]);
  fixture.release(gate);
  const catalog = await fixture.settled(first.completed);
  expect(catalog.entries).toContainEqual(catalogEntry("native-admitted"));
  expect(fixture.failures).toEqual([]);
});
