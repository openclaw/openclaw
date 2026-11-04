import fs from "node:fs";
import path from "node:path";
import { threadId } from "node:worker_threads";
import { beforeEach, expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import * as captureDirectory from "../plugins/plugin-source-capture-directory.js";
import { sweepPluginSourceCapturesForTest } from "../plugins/plugin-source-capture-directory.test-support.js";
import { createDeferredCore } from "../shared/deferred.js";
import { readFixtureLines } from "./prepared-model-catalog-worker.shared.test-support.js";
import {
  catalogEntry,
  EXTERNAL_AUTH_PROFILE_ID,
  PROVIDER_ID,
} from "./prepared-model-catalog-worker.test-support.js";
import { loadPreparedModelRuntimeAuth } from "./prepared-model-runtime-auth.js";
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
    const createCapture = captureDirectory.createPluginSourceCaptureRoot;
    const observeCapture = vi
      .spyOn(captureDirectory, "createPluginSourceCaptureRoot")
      .mockImplementation((...args) => {
        const capture = createCapture(...args);
        const released = createDeferredCore();
        captureReleases.set(capture.directory, released.promise);
        return {
          ...capture,
          release: () => {
            const pending = capture.release();
            released.resolve(pending);
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
  },
);
