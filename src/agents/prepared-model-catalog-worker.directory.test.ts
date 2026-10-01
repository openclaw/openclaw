import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureClawInstallSchemaVersionFacts } from "../claws/provenance-runtime-read.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import * as stagingOwner from "../infra/sqlite-snapshot-staging-owner.js";
import "../claws/tool-policy-runtime.js";
import * as workerCpu from "../infra/worker-cpu.js";
import * as sourceCapture from "../plugins/plugin-source-capture-directory.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { unregisterResolvedAgentDir } from "./agent-dir-registry.js";
import { resolveAgentDir } from "./agent-scope-config.js";
import { saveAuthProfileStore } from "./auth-profiles/store-runtime.js";
import * as catalogPools from "./prepared-model-catalog-pool.js";
import { createCatalogPool } from "./prepared-model-catalog-pool.js";
import {
  createPreparedModelCatalogWorker,
  createPreparedModelCatalogWorkerInput,
} from "./prepared-model-catalog-worker.js";
import {
  createCatalogFixture,
  EXTERNAL_AUTH_PATH_ENV,
  PROVIDER_ID,
  REF_ONLY_API_ENV,
  REF_ONLY_TOKEN_ENV,
} from "./prepared-model-catalog-worker.test-support.js";
import { prepareWorkspaceBuildGroup } from "./prepared-model-runtime.facts.js";
import {
  capturePreparedModelRuntimeLifetime,
  closePreparedModelRuntimeSnapshots,
  registerPreparedModelRuntimeClose,
} from "./prepared-model-runtime.lifecycle.js";
import { retainPreparedPluginGeneration } from "./prepared-model-runtime.plugin-lifetime.js";
import { createCatalogInspectionPool } from "./test-helpers/prepared-model-catalog-inspection.js";
import { usePreparedCatalogWorkerFixtures } from "./test-helpers/prepared-model-catalog-worker-fixture.js";

type CaptureAdmission = ReturnType<typeof sourceCapture.startPluginSourceCaptureRoot>;
type CaptureRoot = Awaited<CaptureAdmission["result"]>;

const { makeTempDir, retireAfterTest } = usePreparedCatalogWorkerFixtures();

function createFixture() {
  const fixture = createCatalogFixture(makeTempDir, 0);
  for (const name of [
    "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_WORKER_CATALOG_MARKER",
    EXTERNAL_AUTH_PATH_ENV,
    REF_ONLY_API_ENV,
    REF_ONLY_TOKEN_ENV,
  ] as const) {
    vi.stubEnv(name, fixture.env[name]);
  }
  return fixture;
}

describe("catalog request existing directory ownership", () => {
  beforeEach(() => {
    vi.stubEnv("CODEX_HOME", makeTempDir("openclaw-directory-request-empty-codex-"));
  });

  it.each([
    { kind: "direct", phase: "preparation" },
    { kind: "Gateway", phase: "preparation" },
    { kind: "direct", phase: "acquisition" },
    { kind: "Gateway", phase: "acquisition" },
    { kind: "Gateway", phase: "publication" },
  ] as const)(
    "retains $kind $phase cleanup after refusal until a later explicit process close",
    async ({ kind, phase: heldPhase }) => {
      const fixture = createFixture();
      const prepared = await prepareWorkspaceBuildGroup(
        [
          {
            agentId: "main",
            agentDir: fixture.agentDir,
            config: fixture.config,
            allowGatewaySubagentBinding: true,
            ...(kind === "direct" ? { env: fixture.env } : {}),
          },
        ],
        "static",
      );
      const agentFacts = prepared.agentFacts[0]!;
      expect(agentFacts.input.allowGatewaySubagentBinding).toBe(true);
      expect(agentFacts.input.env === undefined).toBe(kind === "Gateway");
      const releaseGeneration = retainPreparedPluginGeneration(prepared.pluginGeneration);
      const retirement = new AbortController();
      let current = true;
      const retire = () => {
        current = false;
        retirement.abort();
      };
      retireAfterTest(retire);
      const entered = createDeferredCore();
      const proceed = createDeferredCore();
      let capture: CaptureRoot | undefined;
      let admission: CaptureAdmission | undefined;
      let originalAdmission: CaptureAdmission | undefined;
      let genuinePreparationFailure: unknown;
      let replacement: CaptureAdmission | undefined;
      let ownedRoot: string | undefined;
      let nativeAdmission:
        | ReturnType<typeof stagingOwner.startWorkerOwnedSqliteStagingToken>
        | undefined;
      const primary = Object.assign(new Error("Fixture first catalog capture creation refused"), {
        code: "EACCES",
      });
      const startNative = stagingOwner.startWorkerOwnedSqliteStagingToken;
      const nativeOpening =
        heldPhase === "preparation"
          ? vi
              .spyOn(stagingOwner, "startWorkerOwnedSqliteStagingToken")
              .mockImplementation((...args) => {
                const original = startNative(...args);
                if (args[1] === "create") {
                  ownedRoot = args[0];
                  nativeAdmission = original;
                }
                return original;
              })
          : undefined;
      let preparationRefused = false;
      const makeDirectory = fsPromises.mkdtemp.bind(fsPromises);
      const preparing =
        heldPhase === "preparation"
          ? vi.spyOn(fsPromises, "mkdtemp").mockImplementation(async (...args) => {
              if (
                ownedRoot &&
                !preparationRefused &&
                args[0].startsWith(path.join(ownedRoot, "captures") + path.sep)
              ) {
                entered.resolve();
                await proceed.promise;
                preparationRefused = true;
                throw primary;
              }
              return makeDirectory(...args);
            })
          : undefined;
      const acquire = sourceCapture.startPluginSourceCaptureRoot;
      const createPool = catalogPools.createCatalogPool;
      const observing = vi
        .spyOn(sourceCapture, "startPluginSourceCaptureRoot")
        .mockImplementation((...args) => {
          const acquired = acquire(...args);
          originalAdmission = acquired;
          admission = {
            result: acquired.result.then(
              async (root) => {
                capture = root;
                if (heldPhase === "acquisition") {
                  entered.resolve();
                  await proceed.promise;
                }
                return root;
              },
              (error: unknown) => {
                genuinePreparationFailure = error;
                throw error;
              },
            ),
            release: (reason) => acquired.release(reason),
          };
          return admission;
        });
      let acquiredPool: catalogPools.CatalogPool | undefined;
      const openingPool = vi
        .spyOn(catalogPools, "createCatalogPool")
        .mockImplementation(async (...args) => {
          const pool = await createPool(...args);
          if (heldPhase === "publication") {
            acquiredPool = pool;
            entered.resolve();
            await proceed.promise;
          }
          return pool;
        });
      let successfulCloses = 0;
      let closeReason: Error | undefined;
      const unregisterProbe = registerPreparedModelRuntimeClose(async (error) => {
        successfulCloses += 1;
        closeReason = error;
      });
      const originalLifetime = capturePreparedModelRuntimeLifetime();
      const worker = createPreparedModelCatalogWorker({
        agentFacts,
        pluginMetadataSnapshot: prepared.pluginGeneration.pluginMetadataSnapshot,
        pluginRegistry: prepared.pluginGeneration.pluginRegistry,
        isCurrent: () => current,
        retirementSignal: retirement.signal,
      });
      const request = worker.loadCatalog();
      const requestFailure = request.catch((error: unknown) => error);
      let closing: Promise<void> | undefined;
      let retry: Promise<void> | undefined;
      let restoreRemoval: (() => void) | undefined;
      let restoreRelease: (() => void) | undefined;
      try {
        const phase = await Promise.race([
          entered.promise.then(() => "capture-held"),
          requestFailure.then(() => "request-settled"),
        ]);
        expect(phase).toBe("capture-held");
        if (!admission || !originalAdmission) {
          throw new Error("Expected the opening owner's original admission");
        }
        const root = capture ? path.dirname(path.dirname(capture.directory)) : ownedRoot;
        if (!root) {
          throw new Error("Expected the real native capture root");
        }
        if (heldPhase === "preparation") {
          expect(capture).toBeUndefined();
          if (!nativeAdmission) {
            throw new Error("Expected actual native create admission before first capture");
          }
          await nativeAdmission.result;
        } else {
          expect(capture).toBeDefined();
        }
        const release = vi.spyOn(admission, "release");
        restoreRelease = () => release.mockRestore();
        const failure = Object.assign(new Error("Fixture opening capture removal refused once"), {
          code: "EPERM",
        });
        const remove = fsPromises.rm.bind(fsPromises);
        let refused = false;
        const removing = vi.spyOn(fsPromises, "rm").mockImplementation(async (target, options) => {
          if (target === path.join(root, "captures") && !refused) {
            refused = true;
            throw failure;
          }
          await remove(target, options);
        });
        restoreRemoval = () => removing.mockRestore();
        const generationRelease = releaseGeneration();
        const firstClose = closePreparedModelRuntimeSnapshots();
        expect(closePreparedModelRuntimeSnapshots()).toBe(firstClose);
        closing = Promise.all([generationRelease, firstClose]).then(() => {});
        const closeFailure = closing.catch((error: unknown) => error);
        proceed.resolve();
        const rejected = await requestFailure;
        expect(closeReason).toBeDefined();
        if (heldPhase === "preparation") {
          expect(capture).toBeUndefined();
          if (
            !(genuinePreparationFailure instanceof AggregateError) ||
            !(rejected instanceof AggregateError)
          ) {
            throw new Error("Expected original preparation and independent cleanup failures");
          }
          expect(genuinePreparationFailure.cause).toBe(primary);
          expect(genuinePreparationFailure.errors).toHaveLength(2);
          expect(genuinePreparationFailure.errors[0]).toBe(primary);
          expect(genuinePreparationFailure.errors[1]).toBe(failure);
          await expect(originalAdmission.result).rejects.toBe(genuinePreparationFailure);
          expect(rejected.cause).toBe(genuinePreparationFailure);
          expect(rejected.errors).toHaveLength(2);
          expect(rejected.errors[0]).toBe(genuinePreparationFailure);
          expect(rejected.errors[1]).toBe(failure);
        } else {
          expect(rejected).toMatchObject({
            cause: closeReason,
            errors: expect.arrayContaining([closeReason, failure]),
          });
        }
        expect(await closeFailure).toBeInstanceOf(AggregateError);
        expect(release).toHaveBeenCalledTimes(1);
        if (heldPhase === "publication") {
          expect(acquiredPool?.isClosed).toBe(true);
          expect(acquiredPool?.getSnapshot().workers).toBe(0);
        }
        expect(successfulCloses).toBe(1);
        expect(fs.existsSync(root)).toBe(true);
        expect(() => capturePreparedModelRuntimeLifetime()).toThrow("process lifetime closed");
        const stateDir = fixture.env.OPENCLAW_STATE_DIR;
        if (!stateDir) {
          throw new Error("Catalog fixture omitted its state root");
        }
        const refusedAdmission = acquire(stateDir, "catalog-opening-retry-");
        try {
          await expect(refusedAdmission.result).rejects.toThrow("cleanup is incomplete");
        } finally {
          await refusedAdmission.release();
        }
        retry = closePreparedModelRuntimeSnapshots();
        await expect(retry).resolves.toBeUndefined();
        expect(release).toHaveBeenCalledTimes(2);
        expect(fs.existsSync(root)).toBe(false);
        if (heldPhase === "preparation") {
          await expect(originalAdmission.result).rejects.toBe(genuinePreparationFailure);
        }
        expect(successfulCloses).toBe(1);
        expect(originalLifetime).toThrow("process lifetime closed");
        expect(() => capturePreparedModelRuntimeLifetime()).not.toThrow();
        replacement = acquire(stateDir, "catalog-opening-retry-");
        (await replacement.result).assertCurrent();
        await replacement.release();
      } finally {
        proceed.resolve();
        await Promise.allSettled([request, closing, retry]);
        restoreRemoval?.();
        restoreRelease?.();
        observing.mockRestore();
        openingPool.mockRestore();
        preparing?.mockRestore();
        nativeOpening?.mockRestore();
        unregisterProbe();
        retire();
        await releaseGeneration();
        await admission?.release();
        await replacement?.release();
      }
    },
  );

  it.each(["direct", "Gateway"] as const)(
    "joins %s catalog acquisition during process close without retaining a failed lifetime",
    async (kind) => {
      const fixture = createFixture();
      const prepared = await prepareWorkspaceBuildGroup(
        [
          {
            agentId: "main",
            agentDir: fixture.agentDir,
            config: fixture.config,
            allowGatewaySubagentBinding: true,
            ...(kind === "direct" ? { env: fixture.env } : {}),
          },
        ],
        "static",
      );
      const agentFacts = prepared.agentFacts[0]!;
      expect(agentFacts.input.allowGatewaySubagentBinding).toBe(true);
      expect(agentFacts.input.env === undefined).toBe(kind === "Gateway");
      const releaseGeneration = retainPreparedPluginGeneration(prepared.pluginGeneration);
      const retirement = new AbortController();
      let current = true;
      const retire = () => {
        current = false;
        retirement.abort();
      };
      retireAfterTest(retire);
      const entered = createDeferredCore();
      const proceed = createDeferredCore();
      let capture: CaptureRoot | undefined;
      let admission: CaptureAdmission | undefined;
      const acquire = sourceCapture.startPluginSourceCaptureRoot;
      const observing = vi
        .spyOn(sourceCapture, "startPluginSourceCaptureRoot")
        .mockImplementation((...args) => {
          const acquired = acquire(...args);
          admission = {
            result: acquired.result.then(async (root) => {
              capture = root;
              entered.resolve();
              await proceed.promise;
              return root;
            }),
            release: (reason) => acquired.release(reason),
          };
          return admission;
        });
      const worker = createPreparedModelCatalogWorker({
        agentFacts,
        pluginMetadataSnapshot: prepared.pluginGeneration.pluginMetadataSnapshot,
        pluginRegistry: prepared.pluginGeneration.pluginRegistry,
        isCurrent: () => current,
        retirementSignal: retirement.signal,
      });
      const request = worker.loadCatalog();
      void request.catch(() => {});
      let closing: Promise<void> | undefined;
      try {
        const held = await Promise.race([
          entered.promise.then(() => true),
          request.then(
            () => false,
            () => false,
          ),
        ]);
        expect(held).toBe(true);
        if (!capture || !admission) {
          throw new Error("Expected the catalog owner's original capture");
        }
        const root = path.dirname(path.dirname(capture.directory));
        expect(fs.existsSync(root)).toBe(true);
        closing = Promise.all([releaseGeneration(), closePreparedModelRuntimeSnapshots()]).then(
          () => {},
        );
        proceed.resolve();
        await expect(request).rejects.toThrow("prepared model runtime process lifetime closed");
        await expect(closing).resolves.toBeUndefined();
        expect(fs.existsSync(root)).toBe(false);
        expect(() => capturePreparedModelRuntimeLifetime()).not.toThrow();
      } finally {
        proceed.resolve();
        await Promise.allSettled([request, closing]);
        observing.mockRestore();
        retire();
        await releaseGeneration();
        await admission?.release();
      }
    },
  );

  it("reports transferred capture cleanup failure and retries the original root after worker exit", async () => {
    const fixture = createFixture();
    const prepared = await prepareWorkspaceBuildGroup(
      [{ agentId: "main", agentDir: fixture.agentDir, config: fixture.config, env: fixture.env }],
      "static",
    );
    retireAfterTest(retainPreparedPluginGeneration(prepared.pluginGeneration));
    const value = createPreparedModelCatalogWorkerInput({
      agentFacts: prepared.agentFacts[0]!,
      pluginMetadataSnapshot: prepared.pluginGeneration.pluginMetadataSnapshot,
    });
    let capture: CaptureRoot | undefined;
    let admission: CaptureAdmission | undefined;
    const acquire = sourceCapture.startPluginSourceCaptureRoot;
    const observing = vi
      .spyOn(sourceCapture, "startPluginSourceCaptureRoot")
      .mockImplementation((...args) => {
        const acquired = acquire(...args);
        admission = {
          result: acquired.result.then((root) => {
            capture = root;
            return root;
          }),
          release: (reason) => acquired.release(reason),
        };
        return admission;
      });
    const pool = await createCatalogPool(fixture.env, () => {});
    if (!capture || !admission) {
      await pool.close();
      throw new Error("Expected the catalog pool's actual capture");
    }
    const original = capture;
    const release = vi.spyOn(admission, "release");
    const root = path.dirname(path.dirname(original.directory));
    let replacement: CaptureAdmission | undefined;
    try {
      const result = await pool.run(
        {
          value,
          request: {
            kind: "catalog",
            syntheticAuth: [],
            clawInstallSchemaVersions: captureClawInstallSchemaVersionFacts({ env: fixture.env }),
          },
        },
        { timeoutMs: 30_000 },
      );
      if (result.status !== "ok" || result.kind !== "catalog") {
        throw new Error("Expected the actual catalog worker's completed inventory");
      }
      expect(result.snapshot.entries).toContainEqual(
        expect.objectContaining({
          provider: PROVIDER_ID,
          id: "plugin-generation-v1",
        }),
      );
      expect(pool.getSnapshot()).toMatchObject({ workers: 1, workersCreated: 1 });
      const entered = createDeferredCore();
      const proceed = createDeferredCore();
      const failure = Object.assign(new Error("Fixture transferred capture removal refused once"), {
        code: "EPERM",
      });
      const remove = fsPromises.rm.bind(fsPromises);
      let refused = false;
      const removing = vi.spyOn(fsPromises, "rm").mockImplementation(async (target, options) => {
        if (target === path.join(root, "captures") && !refused) {
          refused = true;
          entered.resolve();
          await proceed.promise;
          throw failure;
        }
        await remove(target, options);
      });
      const outcomes: Array<Promise<unknown>> = [];
      try {
        const first = pool.close();
        const firstFailure = first.catch((error: unknown) => error);
        outcomes.push(firstFailure);
        const phase = await Promise.race([
          entered.promise.then(() => "removal-entered"),
          firstFailure.then(() => "close-settled"),
        ]);
        expect(phase).toBe("removal-entered");
        const secondFailure = pool.close().catch((error: unknown) => error);
        outcomes.push(secondFailure);
        expect(release).toHaveBeenCalledTimes(1);
        expect(pool.getSnapshot()).toMatchObject({ workers: 0, workersCreated: 1 });
        proceed.resolve();
        expect(await firstFailure).toBe(failure);
        expect(await secondFailure).toBe(failure);
        expect(release).toHaveBeenCalledTimes(1);
        expect(fs.existsSync(root)).toBe(true);
        const stateDir = fixture.env.OPENCLAW_STATE_DIR;
        if (!stateDir) {
          throw new Error("Catalog fixture omitted its state root");
        }
        const refusedAdmission = acquire(stateDir, "catalog-after-refusal-");
        try {
          await expect(refusedAdmission.result).rejects.toThrow("cleanup is incomplete");
        } finally {
          await refusedAdmission.release();
        }
        await pool.close();
        expect(release).toHaveBeenCalledTimes(2);
        expect(fs.existsSync(root)).toBe(false);
        await pool.close();
        expect(release).toHaveBeenCalledTimes(2);
        replacement = acquire(stateDir, "catalog-after-refusal-");
        const nextRoot = await replacement.result;
        expect(nextRoot.directory).not.toBe(original.directory);
        nextRoot.assertCurrent();
        await replacement.release();
      } finally {
        proceed.resolve();
        await Promise.allSettled(outcomes);
        removing.mockRestore();
      }
    } finally {
      observing.mockRestore();
      release.mockRestore();
      await Promise.allSettled([pool.close()]);
      await admission?.release();
      await replacement?.release();
    }
  });

  it("retries unused catalog capture cleanup after a shared close attempt fails", async () => {
    const fixture = createFixture();
    const entered = createDeferredCore();
    const refusalGate = createDeferredCore();
    const failure = Object.assign(new Error("Fixture capture removal refused once"), {
      code: "EPERM",
    });
    let capture: CaptureRoot | undefined;
    let admission: CaptureAdmission | undefined;
    const acquire = sourceCapture.startPluginSourceCaptureRoot;
    const observing = vi
      .spyOn(sourceCapture, "startPluginSourceCaptureRoot")
      .mockImplementation((...args) => {
        const acquired = acquire(...args);
        admission = {
          result: acquired.result.then((root) => {
            capture = root;
            return root;
          }),
          release: (reason) => acquired.release(reason),
        };
        return admission;
      });
    const pool = await createCatalogPool(fixture.env, () => {
      throw new Error("An unused pool must not receive a worker result");
    });
    if (!capture || !admission) {
      await pool.close();
      throw new Error("Expected the catalog pool's actual source capture");
    }
    const original = capture;
    const root = path.dirname(path.dirname(original.directory));
    const release = vi.spyOn(admission, "release");
    const remove = fsPromises.rm.bind(fsPromises);
    let refused = false;
    const removing = vi.spyOn(fsPromises, "rm").mockImplementation(async (target, options) => {
      if (target === path.join(root, "captures") && !refused) {
        refused = true;
        entered.resolve();
        await refusalGate.promise;
        throw failure;
      }
      await remove(target, options);
    });
    const outcomes: Array<Promise<unknown>> = [];
    try {
      expect(pool.getSnapshot().workersCreated).toBe(0);
      const first = pool.close();
      const firstFailure = first.catch((error: unknown) => error);
      outcomes.push(firstFailure);
      const phase = await Promise.race([
        entered.promise.then(() => "removal-entered"),
        firstFailure.then(() => "close-settled"),
      ]);
      expect(phase).toBe("removal-entered");
      const second = pool.close();
      const secondFailure = second.catch((error: unknown) => error);
      outcomes.push(secondFailure);
      expect(release.mock.calls.length).toBe(1);
      refusalGate.resolve();
      expect((await firstFailure) === failure).toBe(true);
      expect((await secondFailure) === failure).toBe(true);
      expect(fs.existsSync(root)).toBe(true);
      const retry = await pool.close().then(
        () => ({ ok: true }),
        (error: unknown) => ({ ok: false, error }),
      );
      expect(release.mock.calls.length).toBe(2);
      expect(retry.ok).toBe(true);
      expect(pool.getSnapshot().workersCreated).toBe(0);
      expect(fs.existsSync(root)).toBe(false);
    } finally {
      refusalGate.resolve();
      await Promise.allSettled(outcomes);
      removing.mockRestore();
      release.mockRestore();
      observing.mockRestore();
      await Promise.allSettled([pool.close()]);
      await admission?.release();
    }
  });

  it("retries catalog worker retirement after an owner refusal and a failed stop", async () => {
    const fixture = createFixture();
    const prepared = await prepareWorkspaceBuildGroup(
      [{ agentId: "main", agentDir: fixture.agentDir, config: fixture.config, env: fixture.env }],
      "static",
    );
    retireAfterTest(retainPreparedPluginGeneration(prepared.pluginGeneration));
    const task = {
      value: createPreparedModelCatalogWorkerInput({
        agentFacts: prepared.agentFacts[0]!,
        pluginMetadataSnapshot: prepared.pluginGeneration.pluginMetadataSnapshot,
      }),
      request: {
        kind: "catalog" as const,
        syntheticAuth: [],
        clawInstallSchemaVersions: captureClawInstallSchemaVersionFacts({ env: fixture.env }),
      },
    };
    const sourceFailure = new Error("Fixture catalog owner refused the next request");
    const stopFailure = new Error("Fixture catalog worker stop refused once");
    let sourceRefused = false;
    let capture: CaptureRoot | undefined;
    let admission: CaptureAdmission | undefined;
    const release = vi.fn<(reason?: Error) => Promise<void>>();
    const acquire = sourceCapture.startPluginSourceCaptureRoot;
    const observing = vi
      .spyOn(sourceCapture, "startPluginSourceCaptureRoot")
      .mockImplementation((...args) => {
        const acquired = acquire(...args);
        admission = acquired;
        release.mockImplementation((reason) => acquired.release(reason));
        return {
          result: acquired.result.then((root) => {
            capture = root;
            return {
              directory: root.directory,
              managedRoot: root.managedRoot,
              assertCurrent() {
                root.assertCurrent();
                // Inject an owner refusal without changing or replacing the captured files.
                if (sourceRefused) {
                  throw sourceFailure;
                }
              },
            };
          }),
          release,
        };
      });
    const tracking = vi.mocked(workerCpu.createCpuTrackedWorker);
    const construct = tracking.getMockImplementation();
    if (!construct) {
      observing.mockRestore();
      throw new Error("Expected the catalog fixture's actual worker creation observer");
    }
    const workerUrl = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.preparedModelCatalog).href;
    let computeWorker: ReturnType<typeof workerCpu.createCpuTrackedWorker> | undefined;
    tracking.mockImplementation((...args) => {
      const worker = construct(...args);
      if (String(args[0]) === workerUrl) {
        computeWorker = worker;
      }
      return worker;
    });
    const stopEntered = createDeferredCore();
    const stopAllowed = createDeferredCore();
    const outcomes: Array<Promise<unknown>> = [];
    let pool: catalogPools.CatalogPool | undefined;
    let restoreStop: (() => void) | undefined;
    try {
      pool = await createCatalogPool(fixture.env, () => {});
      const accepted = await pool.run(task, { timeoutMs: 30_000 });
      expect(accepted).toMatchObject({ status: "ok", kind: "catalog" });
      if (!capture || !computeWorker) {
        throw new Error("Expected the real catalog capture and computation worker");
      }
      const worker = computeWorker;
      const root = path.dirname(path.dirname(capture.directory));
      const identity = fs.statSync(root);
      const stop = vi.spyOn(worker, "terminate").mockImplementationOnce(async () => {
        stopEntered.resolve();
        await stopAllowed.promise;
        throw stopFailure;
      });
      restoreStop = () => stop.mockRestore();
      sourceRefused = true;
      const requestFailure = pool.run(task, { timeoutMs: 30_000 }).catch((error: unknown) => error);
      outcomes.push(requestFailure);
      await stopEntered.promise;
      const closeFailure = pool.close().catch((error: unknown) => error);
      outcomes.push(closeFailure);
      expect(release).not.toHaveBeenCalled();
      expect(worker.threadId).toBeGreaterThan(0);
      stopAllowed.resolve();
      const failure = await requestFailure;
      expect(await closeFailure).toBe(stopFailure);
      if (!(failure instanceof AggregateError)) {
        throw new Error("Expected the original source refusal and failed worker stop");
      }
      expect(failure.cause).toBe(sourceFailure);
      expect(failure.errors).toHaveLength(2);
      expect(failure.errors[0]).toBe(sourceFailure);
      expect(failure.errors[1]).toBe(stopFailure);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(release).not.toHaveBeenCalled();
      expect(worker.threadId).toBeGreaterThan(0);
      expect(fs.statSync(root)).toMatchObject({ dev: identity.dev, ino: identity.ino });
      await expect(pool.close()).resolves.toBeUndefined();
      expect(stop).toHaveBeenCalledTimes(2);
      expect(worker.threadId).toBe(-1);
      expect(release).toHaveBeenCalledTimes(1);
      expect(fs.existsSync(root)).toBe(false);
      await expect(pool.run(task, { timeoutMs: 30_000 })).rejects.toBe(sourceFailure);
      expect(stop).toHaveBeenCalledTimes(2);
    } finally {
      stopAllowed.resolve();
      await Promise.allSettled(outcomes);
      restoreStop?.();
      // Also join the actual Worker on the pre-fix path, whose pool cannot retry its failed stop.
      await computeWorker?.terminate();
      await Promise.allSettled([pool?.close()]);
      await admission?.release();
      tracking.mockImplementation(construct);
      observing.mockRestore();
    }
  });

  it("captures the catalog environment before lazy worker startup", async () => {
    const fixture = createFixture();
    const prepared = await prepareWorkspaceBuildGroup(
      [{ agentId: "main", agentDir: fixture.agentDir, config: fixture.config, env: fixture.env }],
      "static",
    );
    retireAfterTest(retainPreparedPluginGeneration(prepared.pluginGeneration));
    const value = createPreparedModelCatalogWorkerInput({
      agentFacts: prepared.agentFacts[0]!,
      pluginMetadataSnapshot: prepared.pluginGeneration.pluginMetadataSnapshot,
    });
    const expectedState = fixture.env.OPENCLAW_STATE_DIR;
    if (!expectedState) {
      throw new Error("Catalog fixture omitted its state root");
    }
    const constructorEnv = { ...fixture.env };
    const tracking = vi.mocked(workerCpu.createCpuTrackedWorker);
    const construct = tracking.getMockImplementation();
    if (!construct) {
      throw new Error("Catalog fixture worker tracking is unavailable");
    }
    const workerUrl = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.preparedModelCatalog).href;
    let stateAtStart: string | undefined;
    let captureDirectory: string | undefined;
    tracking.mockImplementation((...args) => {
      if (String(args[0]) === workerUrl) {
        const options = args[1];
        stateAtStart =
          typeof options?.env === "object" ? options.env.OPENCLAW_STATE_DIR : undefined;
        const data: unknown = options?.workerData;
        if (isRecord(data) && typeof data.sourceCaptureDirectory === "string") {
          captureDirectory = data.sourceCaptureDirectory;
        }
      }
      return construct(...args);
    });
    let pool: Awaited<ReturnType<typeof createCatalogPool>> | undefined;
    try {
      pool = await createCatalogPool(constructorEnv, (result) => {
        expect(result.status).toBe("ok");
      });
      expect(pool.getSnapshot().workersCreated).toBe(0);
      constructorEnv.OPENCLAW_STATE_DIR = makeTempDir("catalog-later-state-");
      const result = await pool.run(
        {
          value,
          request: {
            kind: "catalog",
            syntheticAuth: [],
            clawInstallSchemaVersions: captureClawInstallSchemaVersionFacts({ env: fixture.env }),
          },
        },
        { timeoutMs: 30_000 },
      );
      expect(stateAtStart).toBe(expectedState);
      if (!captureDirectory) {
        throw new Error("Catalog worker did not expose its original capture directory");
      }
      expect(
        captureDirectory.startsWith(
          path.join(fs.realpathSync(expectedState), "tmp", "plugin-captures") + path.sep,
        ),
      ).toBe(true);
      expect(fs.existsSync(captureDirectory)).toBe(true);
      if (result.status !== "ok" || result.kind !== "catalog") {
        throw new Error("Catalog fixture did not complete its real request");
      }
      expect(
        result.snapshot.entries.some(
          (entry) => entry.provider === PROVIDER_ID && entry.id === "plugin-generation-v1",
        ),
      ).toBe(true);
    } finally {
      try {
        await pool?.close();
      } finally {
        tracking.mockImplementation(construct);
      }
    }
    expect(captureDirectory !== undefined && fs.existsSync(captureDirectory)).toBe(false);
  });

  it("serves repeated catalog requests from prepared provenance without copying shared state", async () => {
    const fixture = createFixture();
    const prepared = await prepareWorkspaceBuildGroup(
      [{ agentId: "main", agentDir: fixture.agentDir, config: fixture.config, env: fixture.env }],
      "static",
    );
    retireAfterTest(retainPreparedPluginGeneration(prepared.pluginGeneration));
    const value = createPreparedModelCatalogWorkerInput({
      agentFacts: prepared.agentFacts[0]!,
      pluginMetadataSnapshot: prepared.pluginGeneration.pluginMetadataSnapshot,
    });
    const database = openOpenClawStateDatabase({ env: fixture.env });
    const clawInstallSchemaVersions = captureClawInstallSchemaVersionFacts({ env: fixture.env });
    await closeOpenClawStateDatabaseByPathAsync(database.path);
    const { pool } = await createCatalogInspectionPool(fixture.env, retireAfterTest);
    try {
      for (let tick = 0; tick < 3; tick++) {
        const { inspection, ...result } = await pool.run(
          {
            value,
            request: { kind: "catalog", syntheticAuth: [], clawInstallSchemaVersions },
            ...(tick === 0 ? { inspection: { copyProbePath: database.path } } : {}),
          },
          { timeoutMs: 30_000 },
        );
        expect(result).toMatchObject({
          status: "ok",
          kind: "catalog",
          snapshot: {
            entries: expect.arrayContaining([
              expect.objectContaining({ provider: PROVIDER_ID, id: "plugin-generation-v1" }),
            ]),
          },
        });
        expect(inspection.sqliteCopies).toBe(0);
        if (tick === 0) {
          expect(inspection.copyHookObserved).toBe(true);
        }
      }
    } finally {
      await pool.close();
      await closeOpenClawStateDatabaseByPathAsync(database.path);
    }
  });

  it.each([
    { label: "same normalized owner", existing: ["MAIN"], conflict: false },
    { label: "foreign owner", existing: ["foreign"], conflict: true },
    { label: "ambiguous owners", existing: ["main", "foreign"], conflict: true },
  ])("preserves $label across the request", async ({ existing, conflict }) => {
    const fixture = createFixture();
    const config = {
      ...fixture.config,
      agents: {
        ...fixture.config.agents,
        entries: { main: { agentDir: path.join(fixture.root, "custom-owner", "agent") } },
      },
    } satisfies OpenClawConfig;
    const agentDir = resolveAgentDir(config, "main", fixture.env);
    retireAfterTest(() => {
      unregisterResolvedAgentDir({ agentId: "main", agentDir, env: fixture.env });
      unregisterResolvedAgentDir({ agentId: "foreign", agentDir, env: fixture.env });
    });
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [`${PROVIDER_ID}:main`]: {
            type: "api_key",
            provider: PROVIDER_ID,
            key: "existing-owner-key-not-real",
          },
        },
      },
      agentDir,
    );
    const prepared = await prepareWorkspaceBuildGroup(
      [{ agentId: "main", agentDir, inheritedAuthDir: agentDir, config, env: fixture.env }],
      "static",
    );
    retireAfterTest(retainPreparedPluginGeneration(prepared.pluginGeneration));
    const value = structuredClone(
      createPreparedModelCatalogWorkerInput({
        agentFacts: prepared.agentFacts[0]!,
        pluginMetadataSnapshot: prepared.pluginGeneration.pluginMetadataSnapshot,
      }),
    );
    unregisterResolvedAgentDir({ agentId: "main", agentDir, env: fixture.env });
    const { pool } = await createCatalogInspectionPool(fixture.env, retireAfterTest);
    let completed: Awaited<ReturnType<typeof pool.run>>;
    try {
      completed = await pool.run(
        {
          value,
          request: {
            kind: "catalog",
            syntheticAuth: [],
            clawInstallSchemaVersions: captureClawInstallSchemaVersionFacts({ env: fixture.env }),
          },
          inspection: { existingAgentIds: existing },
        },
        { timeoutMs: 30_000 },
      );
    } finally {
      await pool.close();
    }
    const { inspection, ...result } = completed;
    if (conflict) {
      expect(result).toEqual({
        status: "failed",
        error: `Conflicting registered agent owners for ${agentDir}`,
      });
      expect(fs.existsSync(fixture.marker)).toBe(false);
      expect(inspection.foreignReleased).toBe(true);
    } else {
      expect(result).toMatchObject({
        status: "ok",
        kind: "catalog",
        snapshot: {
          entries: expect.arrayContaining([
            expect.objectContaining({ provider: PROVIDER_ID, id: "plugin-generation-v1" }),
          ]),
        },
      });
      expect(fs.readFileSync(fixture.marker, "utf8")).toBe("start\ndone\n");
    }
    expect(inspection.registeredAgentId).toBe(
      existing.some((agentId) => agentId.toLowerCase() === "main") ? "main" : undefined,
    );
  });
});
