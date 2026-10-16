import fs from "node:fs";
import path from "node:path";
import { setImmediate as checkpoint } from "node:timers/promises";
import { BroadcastChannel, threadId } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { PREPARED_MODEL_CATALOG_WORKER_TIMEOUT_MS } from "./model-catalog-timeouts.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import {
  createCatalogFixture,
  expectNativeHarnessModelsPublishedFromWorker,
  PROVIDER_ID,
} from "./prepared-model-catalog-worker.test-support.js";
import { loadPreparedModelRuntimeAuth } from "./prepared-model-runtime-auth.js";
import { getPreparedModelRuntimeSnapshot } from "./prepared-model-runtime.js";
import { closePreparedModelRuntimeSnapshots } from "./prepared-model-runtime.lifecycle.js";
import { registerPreparedModelRuntimePublicationListener } from "./prepared-model-runtime.publication-events.js";
import { createCatalogFleetFixture } from "./test-helpers/prepared-model-catalog-fleet-fixture.js";
import { expectLegacyWorkerCatalogRetention } from "./test-helpers/prepared-model-catalog-legacy-fixture.js";
import { usePreparedCatalogWorkerFixtures } from "./test-helpers/prepared-model-catalog-worker-fixture.js";

const { makeTempDir, retireAfterTest, readCatalogWorkers } = usePreparedCatalogWorkerFixtures();

describe("prepared native model catalog worker boundary", () => {
  it("retains configured dynamic models alongside native harness models after full refresh", async () => {
    await expectNativeHarnessModelsPublishedFromWorker({ makeTempDir, retireAfterTest });
  });

  it.each([
    { catalogReturnsRows: true, aliasOnly: false },
    { catalogReturnsRows: false, aliasOnly: false },
    { catalogReturnsRows: true, aliasOnly: true },
  ])("refreshes legacy catalogs (rows=$catalogReturnsRows, alias=$aliasOnly)", async (options) => {
    await expectLegacyWorkerCatalogRetention({
      makeTempDir,
      retireAfterTest,
      ...options,
    });
  });
});

async function createGatewayNativeAdmissionFixture(
  gateCount: number,
  holdImport?: "before" | "after",
) {
  const fixture = await createCatalogFixture(makeTempDir, 0);
  const pluginRoot = path.join(fixture.root, "plugin");
  const dependency = path.join(pluginRoot, "node_modules", "native-fixture");
  fs.mkdirSync(dependency, { recursive: true });
  fs.writeFileSync(
    path.join(dependency, "package.json"),
    JSON.stringify({ name: "native-fixture", version: "1.0.0", main: "index.cjs" }),
  );
  fs.writeFileSync(
    path.join(dependency, "index.cjs"),
    'module.exports = require.resolve("./artifact-0.exe");',
  );
  const binary = path.join(dependency, "artifact-0.exe");
  fs.writeFileSync(binary, "synthetic native companion");
  for (let member = 1; member < 33; member++) {
    fs.linkSync(binary, path.join(dependency, `artifact-${member}.exe`));
  }
  for (let member = 0; member < 21; member++) {
    fs.writeFileSync(path.join(dependency, `companion-${member}.txt`), "companion");
  }
  const admissionMarker = path.join(fixture.root, "native-admissions.txt");
  const providerHold = path.join(fixture.root, "provider-hold");
  const authHold = path.join(fixture.root, "auth-hold");
  const importHold = path.join(fixture.root, "import-hold");
  if (holdImport) {
    fs.writeFileSync(importHold, "");
  }
  const broadcastName = `catalog-admission:${fixture.root}`;
  fs.writeFileSync(
    path.join(pluginRoot, "index.cjs"),
    `const fs = require("node:fs");
const path = require("node:path");
const { BroadcastChannel, threadId } = require("node:worker_threads");
const receipts = new BroadcastChannel(${JSON.stringify(broadcastName)});
receipts.unref();
let native;
if (threadId !== ${threadId}) {
  if (${JSON.stringify(holdImport)} === "before" && fs.existsSync(${JSON.stringify(importHold)})) {
    fs.unlinkSync(${JSON.stringify(importHold)});
    const gate = new Int32Array(new SharedArrayBuffer(8));
    receipts.postMessage(gate.buffer);
    Atomics.wait(gate, 0, 0);
  }
  const realpath = fs.realpathSync;
  const link = fs.linkSync;
  const symlink = fs.symlinkSync;
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
    if (${JSON.stringify(holdImport)} === "after" && fs.existsSync(${JSON.stringify(importHold)})) {
      fs.unlinkSync(${JSON.stringify(importHold)});
      const gate = new Int32Array(new SharedArrayBuffer(8));
      receipts.postMessage(gate.buffer);
      Atomics.wait(gate, 0, 0);
    }
  } finally {
    fs.realpathSync = realpath;
    fs.linkSync = link;
    fs.symlinkSync = symlink;
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
  );
  const entered = Array.from({ length: gateCount + Number(Boolean(holdImport)) }, () =>
    createDeferred<Int32Array<SharedArrayBuffer>>(),
  );
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
  const failures: Error[] = [];
  const recovered = createDeferred();
  let waiting: ReturnType<typeof createDeferred<ModelCatalogSnapshot>> | undefined;
  unsubscribe = registerPreparedModelRuntimePublicationListener((event) => {
    if (event.phase === "published" && !snapshot.isCurrent()) {
      recovered.resolve();
    } else if (event.phase === "catalog-failed") {
      failures.push(event.error);
      waiting?.reject(event.error);
    } else if (event.phase === "catalog-published" && snapshot.isCurrent()) {
      const catalog = snapshot.readFullModelCatalog!();
      if (catalog?.entries.some((entry) => entry.id === "native-admitted")) {
        waiting?.resolve(catalog);
      }
    }
  });
  return {
    snapshot,
    recovered: recovered.promise,
    currentSnapshot: () =>
      getPreparedModelRuntimeSnapshot({
        agentId: fleet.agentIds[0]!,
        agentDir: fleet.entries[fleet.agentIds[0]!]!.agentDir,
        config: fleet.config,
      }),
    failures,
    entered,
    release,
    close,
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
      const completion = createDeferred<ModelCatalogSnapshot>();
      waiting = completion;
      const foreground = snapshot.loadFullModelCatalog!({ refresh: true });
      void foreground.catch(completion.reject);
      const completed = completion.promise.finally(() => {
        if (waiting === completion) {
          waiting = undefined;
        }
      });
      void completed.catch(() => {});
      return { foreground, completed };
    },
  };
}

it("finishes progressing native admission once across Gateway catalog refreshes", async ({
  signal,
}) => {
  const fixture = await createGatewayNativeAdmissionFixture(3);
  const started = performance.now();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const fakeNow = performance.now.bind(performance);
  const clock = vi.spyOn(performance, "now").mockImplementation(() => started + fakeNow());
  try {
    const first = fixture.refresh();
    for (const entered of fixture.entered) {
      const gate = await withinTest(
        awaitGateBeforeSettlement(entered.promise, first.completed, "Native member did not enter"),
        signal,
      );
      await checkpoint();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(fixture.failures).toEqual([]);
      expect(readCatalogWorkers()).toHaveLength(1);
      expect(readCatalogWorkers()[0]!.threadId).not.toBe(-1);
      fixture.release(gate, 120_000);
    }
    const catalog = await withinTest(first.completed, signal);
    expect(catalog.entries).toContainEqual(
      expect.objectContaining({ provider: PROVIDER_ID, id: "native-admitted" }),
    );
    // Publication precedes acquisition settlement; the next turn starts a separate refresh.
    await checkpoint();
    const refreshed = await withinTest(fixture.refresh().completed, signal);
    expect(refreshed.entries).toEqual(catalog.entries);
    const records = fixture.records();
    const starts = records.filter(({ event }) => event === "started");
    const members = records.filter(({ event }) => event === "started" || event === "member");
    const admitted = records.filter(({ event }) => event === "admitted");
    const executions = records.filter(({ event }) => event === "catalog");
    expect(starts).toHaveLength(1);
    expect(new Set(members.map(({ native }) => native)).size).toBe(3);
    expect(admitted).toHaveLength(1);
    expect(executions).toHaveLength(2);
    expect(starts[0].admission).toContain(`${path.sep}native${path.sep}admission-`);
    expect(new Set(members.map(({ admission }) => admission)).size).toBe(1);
    expect(executions.map(({ native }) => native)).toEqual([
      admitted[0].native,
      admitted[0].native,
    ]);
    expect(fs.existsSync(admitted[0].native)).toBe(true);
    expect(readCatalogWorkers()).toHaveLength(1);
    expect(fixture.snapshot.isCurrent()).toBe(true);
    expect(fixture.failures).toEqual([]);
    await checkpoint();
    const providerEntered = fixture.holdProvider();
    const blocked = fixture.refresh();
    await withinTest(
      awaitGateBeforeSettlement(providerEntered, blocked.completed, "Provider hook did not enter"),
      signal,
    );
    await vi.advanceTimersByTimeAsync(PREPARED_MODEL_CATALOG_WORKER_TIMEOUT_MS);
    await expect(withinTest(blocked.completed, signal)).rejects.toMatchObject({
      name: "WorkerTaskError",
      code: "timeout",
    });
  } finally {
    clock.mockRestore();
    vi.useRealTimers();
    await fixture.close();
  }
});

it("records a stalled native admission without restarting its Gateway capture", async ({
  signal,
}) => {
  const fixture = await createGatewayNativeAdmissionFixture(1);
  const started = performance.now();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const fakeNow = performance.now.bind(performance);
  const clock = vi.spyOn(performance, "now").mockImplementation(() => started + fakeNow());
  try {
    const first = fixture.refresh();
    await withinTest(
      awaitGateBeforeSettlement(
        fixture.entered[0]!.promise,
        first.completed,
        "Native capture did not enter",
      ),
      signal,
    );
    const worker = readCatalogWorkers()[0]!;
    const exited = new Promise<number>((resolve) => {
      worker.once("exit", resolve);
    });
    await checkpoint();
    await vi.advanceTimersByTimeAsync(2_000);
    const auth = fixture.holdAuth();
    await withinTest(
      awaitGateBeforeSettlement(auth.entered, auth.completed, "Parent auth probe did not enter"),
      signal,
    );
    await vi.advanceTimersByTimeAsync(PREPARED_MODEL_CATALOG_WORKER_TIMEOUT_MS - 1_000);
    expect(fixture.failures).toHaveLength(1);
    const failure = fixture.failures[0]!;
    expect(failure).toMatchObject({ name: "PreparedModelCatalogAdmissionStalledError" });
    expect(failure.message).toContain(PROVIDER_ID);
    expect(failure.message).toContain("native reference verification");
    await expect(first.completed).rejects.toBe(failure);
    const retained = await withinTest(first.foreground, signal);
    expect(retained.refreshFailed).toBe(true);
    expect(retained.pendingProviders).toBeUndefined();
    expect(fixture.snapshot.isCurrent()).toBe(true);
    await withinTest(exited, signal);
    expect(fixture.failures).toHaveLength(1);
    await expect(fixture.refresh().completed).rejects.toBe(failure);
    // A later parent-probe error must not recover the terminally stalled shared pool.
    fixture.failAuth();
    await expect(withinTest(auth.completed, signal)).rejects.toThrow("fixture parent auth failed");
    await vi.advanceTimersByTimeAsync(PREPARED_MODEL_CATALOG_WORKER_TIMEOUT_MS * 2);
    expect(fixture.snapshot.isCurrent()).toBe(true);
    expect(readCatalogWorkers()).toHaveLength(1);
    expect(worker.threadId).toBe(-1);
    const records = fixture.records();
    expect(records.filter(({ event }) => event === "started")).toHaveLength(1);
    expect(records.some(({ event }) => event === "admitted" || event === "catalog")).toBe(false);
    expect(retained.refreshFailed).toBe(true);
    expect(retained.pendingProviders).toBeUndefined();
  } finally {
    clock.mockRestore();
    vi.useRealTimers();
    await fixture.close();
  }
});

it.for(["before", "after"] as const)(
  "recovers a catalog worker stalled $0 native verification",
  async (holdImport, { signal }) => {
    const fixture = await createGatewayNativeAdmissionFixture(0, holdImport);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const first = fixture.refresh();
      await withinTest(
        awaitGateBeforeSettlement(
          fixture.entered[0]!.promise,
          first.completed,
          "Plugin import did not enter",
        ),
        signal,
      );
      await checkpoint();
      await vi.advanceTimersByTimeAsync(PREPARED_MODEL_CATALOG_WORKER_TIMEOUT_MS);
      await expect(withinTest(first.completed, signal)).rejects.toMatchObject({
        name: "WorkerTaskError",
        code: "timeout",
      });
      await withinTest(first.foreground, signal);
      await withinTest(fixture.recovered, signal);
      expect(fixture.snapshot.isCurrent()).toBe(false);
      const recovered = fixture.currentSnapshot();
      expect(recovered?.isCurrent()).toBe(true);
      const catalog = await withinTest(recovered!.loadFullModelCatalog!({ refresh: true }), signal);
      expect(catalog.entries).toContainEqual(
        expect.objectContaining({ provider: PROVIDER_ID, id: "native-admitted" }),
      );
    } finally {
      vi.useRealTimers();
      await fixture.close();
    }
  },
);
