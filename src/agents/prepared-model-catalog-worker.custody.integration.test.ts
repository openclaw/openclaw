import { channel } from "node:diagnostics_channel";
import fs from "node:fs";
import path from "node:path";
import { threadId, Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sweepPluginSourceCaptureDirectories } from "../plugins/plugin-source-capture-directory.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  EXTERNAL_AUTH_PROFILE_ID,
  PROVIDER_ID,
} from "./prepared-model-catalog-worker.test-support.js";
import { loadPreparedModelRuntimeAuth } from "./prepared-model-runtime-auth.js";
import { createStaticCatalogSnapshotFixture } from "./test-helpers/prepared-model-catalog-static-fixture.js";
import {
  readCatalogDiscoveryCaptures,
  usePreparedCatalogWorkerFixtures,
} from "./test-helpers/prepared-model-catalog-worker-fixture.js";

const { makeTempDir, retireAfterTest, waitForWorkers } = usePreparedCatalogWorkerFixtures();
const createStaticSnapshot = createStaticCatalogSnapshotFixture({ makeTempDir, retireAfterTest });
const workers: Worker[] = [];
const workerChannel = channel("worker_threads");
const recordWorker = (message: unknown) => {
  if (isRecord(message) && message.worker instanceof Worker) {
    workers.push(message.worker);
  }
};

describe("catalog worker capture custody", () => {
  beforeEach(() => {
    workers.length = 0;
    workerChannel.subscribe(recordWorker);
    vi.stubEnv("CODEX_HOME", makeTempDir("openclaw-worker-empty-codex-"));
  });
  afterEach(() => workerChannel.unsubscribe(recordWorker));

  it.for([
    { owner: "configured Gateway", prepareInboundPluginRegistry: true, version: "built" },
    { owner: "standalone", prepareInboundPluginRegistry: false, version: "v1" },
  ])(
    "keeps the $owner artifact selection in catalog and auth workers",
    async (selection, { signal }) => {
      const fixture = await createStaticSnapshot(
        0,
        {},
        {
          builtPluginVersion: "built",
          prepareInboundPluginRegistry: selection.prepareInboundPluginRegistry,
        },
      );
      await fixture.snapshot.loadFullModelCatalog!();
      const auth = await loadPreparedModelRuntimeAuth(fixture.snapshot, {
        providerIds: [PROVIDER_ID],
      });
      // The foreground read can return starter rows while cold discovery continues.
      await expect
        .poll(() => fixture.snapshot.readFullModelCatalog?.()?.entries, { timeout: 30_000 })
        .toContainEqual(
          expect.objectContaining({
            provider: PROVIDER_ID,
            id: `plugin-generation-${selection.version}`,
          }),
        );
      expect(auth?.authStore.profiles[EXTERNAL_AUTH_PROFILE_ID]).toMatchObject({
        access: `${selection.version}:A`,
      });
      expect(
        new Set(
          fs
            .readFileSync(path.join(fixture.root, "discovery-artifacts.txt"), "utf8")
            .trim()
            .split("\n"),
        ),
      ).toEqual(new Set([selection.version]));
      const captures = readCatalogDiscoveryCaptures(fixture.root);
      const workerCaptures = captures.filter((capture) => capture.threadId !== threadId);
      const parentCaptures = captures.filter((capture) => capture.threadId === threadId);
      expect(workerCaptures.length).toBeGreaterThan(0);
      expect(parentCaptures.length).toBeGreaterThan(0);
      expect(captures.every((capture) => fs.existsSync(capture.filename))).toBe(true);
      const filename = workerCaptures[0]!.filename;
      const captureRoot = filename.slice(0, filename.indexOf(`${path.sep}openclaw-plugin-build-`));
      const instanceRoot = path.dirname(path.dirname(captureRoot));
      expect(path.basename(captureRoot)).toMatch(/^openclaw-model-catalog-/);
      expect(path.dirname(instanceRoot)).toBe(
        path.join(fixture.env.OPENCLAW_STATE_DIR!, "tmp", "plugin-captures"),
      );
      expect(fs.existsSync(path.join(instanceRoot, "owner.sqlite"))).toBe(true);
      const old = new Date(Date.now() - 2 * 60 * 60 * 1_000);
      fs.utimesSync(instanceRoot, old, old);
      await sweepPluginSourceCaptureDirectories(fixture.env.OPENCLAW_STATE_DIR!);
      expect(fs.existsSync(filename)).toBe(true);
      const exitRequested = createDeferredCore();
      const allowExit = createDeferredCore();
      const worker = workers.find(
        (candidate) => candidate.threadId === workerCaptures[0]!.threadId,
      );
      expect(worker).toBeDefined();
      expect(worker?.resourceLimits).toMatchObject({ maxOldGenerationSizeMb: 512 });
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
        fixture.supersede();
        await exitRequested.promise;
        await sweepPluginSourceCaptureDirectories(fixture.env.OPENCLAW_STATE_DIR!);
        expect(workerCaptures.every((capture) => fs.existsSync(capture.filename))).toBe(true);
      } finally {
        signal.removeEventListener("abort", resume);
        resume();
        termination.mockRestore();
      }
      await waitForWorkers();
      await expect.poll(() => fs.existsSync(captureRoot)).toBe(false);
      expect(workerCaptures.filter((capture) => fs.existsSync(capture.filename))).toEqual([]);
      expect(parentCaptures.every((capture) => fs.existsSync(capture.filename))).toBe(true);
    },
  );
});
