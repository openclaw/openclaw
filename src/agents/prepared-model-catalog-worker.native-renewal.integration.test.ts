import { channel } from "node:diagnostics_channel";
import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { threadId } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import { PROVIDER_ID, HARNESS_ID } from "./prepared-model-catalog-worker.test-support.js";
import {
  loadPublishedPreparedModelCatalogOwnerSnapshot,
  refreshExpiredPreparedModelCatalog,
} from "./prepared-model-catalog.js";
import { getPreparedModelFullCatalogAuth } from "./prepared-model-runtime-auth.js";
import { registerPreparedModelRuntimePublicationListener } from "./prepared-model-runtime.publication-events.js";
import type { PreparedModelRuntimeSnapshot } from "./prepared-model-runtime.types.js";
import { readCatalogCaptureFootprint } from "./test-helpers/catalog-capture-footprint.js";
import { createCatalogFleetFixture } from "./test-helpers/prepared-model-catalog-fleet-fixture.js";
import {
  loadCompletedFullCatalog,
  usePreparedCatalogWorkerFixtures,
} from "./test-helpers/prepared-model-catalog-worker-fixture.js";

const { makeTempDir } = usePreparedCatalogWorkerFixtures();
const createFleetFixture = createCatalogFleetFixture(makeTempDir);
const UNSEEN_NATIVE_PROVIDER = "native-only-fixture";

it("admits cold native discovery during expired fleet provider renewal and preserves both publications", async () => {
  let revision = 0;
  let clock = Date.now();
  let held: ReturnType<typeof createDeferred<void>> | undefined;
  let entered: ReturnType<typeof createDeferred<void>> | undefined;
  let nativeEntered: ReturnType<typeof createDeferred<void>> | undefined;
  let nativeHeld: ReturnType<typeof createDeferred<void>> | undefined;
  let nativeTarget: { agent: string; revision: number } | undefined;
  let snapshots: PreparedModelRuntimeSnapshot[] = [];
  const requests: Array<{ agent: string; revision: number; authorization: string | undefined }> =
    [];
  const nativeReads: Array<{ agent: string; revision: number }> = [];
  const taskMetrics = {
    completed: 0,
    failed: 0,
    totalQueueMs: 0,
    maxQueueMs: 0,
    totalRunMs: 0,
    maxRunMs: 0,
  };
  const admissionMs: number[] = [];
  const work: Promise<unknown>[] = [];
  const publications: Promise<unknown>[] = [];
  const waiters = new Set<() => void>();
  const unsubscribe = registerPreparedModelRuntimePublicationListener(() => {
    for (const check of waiters) {
      check();
    }
  });
  const taskChannel = channel("openclaw.worker.task");
  const recordTask = (message: unknown) => {
    if (
      isRecord(message) &&
      typeof message.worker === "string" &&
      message.worker.includes("prepared-model-catalog") &&
      typeof message.queueMs === "number" &&
      typeof message.runMs === "number"
    ) {
      taskMetrics.completed += 1;
      taskMetrics.failed += message.outcome === "failed" ? 1 : 0;
      taskMetrics.totalQueueMs += message.queueMs;
      taskMetrics.maxQueueMs = Math.max(taskMetrics.maxQueueMs, message.queueMs);
      taskMetrics.totalRunMs += message.runMs;
      taskMetrics.maxRunMs = Math.max(taskMetrics.maxRunMs, message.runMs);
    }
  };
  taskChannel.subscribe(recordTask);
  const waitForCatalogs = (expectedRevision: number) => {
    const completed = createDeferred();
    const check = () => {
      if (
        snapshots.length &&
        snapshots.every((snapshot) =>
          snapshot
            .readFullModelCatalog?.()
            ?.entries.some((entry) => entry.id === `provider-${expectedRevision}`),
        )
      ) {
        waiters.delete(check);
        completed.resolve();
      }
    };
    waiters.add(check);
    check();
    return withTestTimeout(completed.promise, 30_000, "Fleet provider catalogs did not publish");
  };
  const server = await reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      createServer((request, response) => {
        const url = new URL(request.url!, "http://fixture.invalid");
        const agent = url.searchParams.get("agent")!;
        if (url.pathname === "/native") {
          const nativeRevision = revision;
          const release = nativeHeld;
          nativeReads.push({ agent, revision: nativeRevision });
          if (agent === nativeTarget?.agent && nativeRevision === nativeTarget.revision) {
            nativeEntered?.resolve();
          }
          const pending = (async () => {
            await release?.promise;
            response.setHeader("content-type", "application/json");
            response.end(
              JSON.stringify(
                nativeRevision
                  ? [
                      {
                        provider: nativeRevision === 3 ? UNSEEN_NATIVE_PROVIDER : PROVIDER_ID,
                        id: `native-${nativeRevision}`,
                        name: "Native model",
                        nativeRuntime: HARNESS_ID,
                      },
                    ]
                  : [],
              ),
            );
          })();
          work.push(pending);
          void pending.catch((error: unknown) =>
            response.destroy(error instanceof Error ? error : new Error(String(error))),
          );
          return;
        }
        if (url.pathname !== "/catalog") {
          response.writeHead(404).end();
          return;
        }
        const currentRevision = revision;
        const release = held;
        requests.push({
          agent,
          revision: currentRevision,
          authorization: request.headers.authorization,
        });
        entered?.resolve();
        const pending = (async () => {
          await release?.promise;
          response.setHeader("content-type", "application/json");
          response.end(
            JSON.stringify({
              provider: {
                api: "openai-completions",
                baseUrl: "https://fleet.invalid/v1",
                models: [{ id: `provider-${currentRevision}`, name: "Provider model" }],
              },
            }),
          );
        })();
        work.push(pending);
        void pending.catch((error: unknown) =>
          response.destroy(error instanceof Error ? error : new Error(String(error))),
        );
      }),
  });
  let registrations = "";
  let restoreClock: (() => void) | undefined;
  let pendingNative: Promise<unknown> | undefined;
  try {
    const endpoint = `http://127.0.0.1:${server.claim.port}`;
    const date = vi.spyOn(Date, "now").mockImplementation(() => clock);
    restoreClock = () => date.mockRestore();
    const fixture = await createFleetFixture(
      (seed) => {
        const clockFile = path.join(seed.root, "catalog-clock.txt");
        registrations = path.join(seed.root, "catalog-registrations.txt");
        fs.writeFileSync(clockFile, String(clock));
        fs.writeFileSync(registrations, "");
        fs.writeFileSync(
          path.join(seed.root, "plugin", "payload.bin"),
          Buffer.alloc(1024 * 1024, 1),
        );
        fs.writeFileSync(
          path.join(seed.root, "plugin", "openclaw.plugin.json"),
          JSON.stringify({
            id: PROVIDER_ID,
            providers: [PROVIDER_ID],
            cliBackends: [HARNESS_ID],
            modelCatalog: { discovery: { [PROVIDER_ID]: "runtime" }, runtimeAugment: true },
            configSchema: { type: "object", additionalProperties: false },
          }),
        );
        fs.writeFileSync(
          path.join(seed.root, "plugin", "index.cjs"),
          `
const fs = require("node:fs");
const { getCachedLiveCatalogValue } = require("openclaw/plugin-sdk/provider-catalog-shared");
module.exports = { id: ${JSON.stringify(PROVIDER_ID)}, register(api) {
  fs.appendFileSync(${JSON.stringify(registrations)}, JSON.stringify({ thread: require("node:worker_threads").threadId, filename: __filename }) + "\\n");
  api.registerAgentHarness({
    id: ${JSON.stringify(HARNESS_ID)}, label: "Native fleet proof", authBootstrap: "harness",
    supports: () => ({ supported: true }), runAttempt: async () => ({ ok: false, error: "unused" }),
    loadModelCatalog: async (params) => (await fetch(${JSON.stringify(endpoint + "/native?agent=")} + encodeURIComponent(params.agentId))).json(),
  });
  api.registerProvider({
    id: ${JSON.stringify(PROVIDER_ID)}, label: "Fleet proof", auth: [],
    catalog: { async run(ctx) {
      const credential = ctx.resolveProviderAuth(${JSON.stringify(PROVIDER_ID)}).discoveryApiKey;
      return getCachedLiveCatalogValue({
        keyParts: [ctx.agentDir, credential], ttlMs: 1000,
        now: () => Number(fs.readFileSync(${JSON.stringify(clockFile)}, "utf8")),
        load: async () => (await fetch(${JSON.stringify(endpoint + "/catalog?agent=")} + encodeURIComponent(require("node:path").basename(require("node:path").dirname(ctx.agentDir))), {
          headers: { authorization: "Bearer " + credential },
        })).json(),
      });
    } },
  });
} };\n`,
        );
      },
      true,
      { agentCount: 2 },
    );
    snapshots = fixture.snapshots;
    await Promise.all(snapshots.map((snapshot) => loadCompletedFullCatalog(snapshot)));
    expect(requests).toHaveLength(2);
    for (const snapshot of snapshots) {
      expect(snapshot.readFullModelCatalog?.()?.entries).toContainEqual(
        expect.objectContaining({ provider: PROVIDER_ID, id: "provider-0" }),
      );
    }
    const preparedRegistrations = fs.readFileSync(registrations, "utf8");
    const registeredSources = preparedRegistrations
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { thread: number; filename: string });
    const workerSources = registeredSources.filter((source) => source.thread !== threadId);
    expect(workerSources).toHaveLength(1);
    const filename = workerSources[0]!.filename;
    const captureOffset = filename.indexOf(`${path.sep}openclaw-plugin-build-`);
    expect(captureOffset).toBeGreaterThan(0);
    const captureRoot = filename.slice(0, captureOffset);
    expect(path.basename(captureRoot)).toMatch(/^openclaw-model-catalog-/);
    const nativeArtifacts = [path.join(path.dirname(filename), "payload.bin")];
    const initialFootprint = readCatalogCaptureFootprint(captureRoot, nativeArtifacts);
    expect(initialFootprint.captures).toHaveLength(1);
    expect(initialFootprint.references).toEqual([expect.objectContaining({ bytes: 1024 * 1024 })]);
    expect(initialFootprint.bytes).toBeGreaterThanOrEqual(1024 * 1024);
    for (revision = 1; revision <= 3; revision++) {
      const nativeProvider = revision === 3 ? UNSEEN_NATIVE_PROVIDER : PROVIDER_ID;
      clock += 1001;
      fs.writeFileSync(path.join(fixture.root, "catalog-clock.txt"), String(clock));
      held = createDeferred();
      entered = createDeferred();
      nativeEntered = createDeferred();
      nativeTarget = { agent: fixture.agentIds[0]!, revision };
      nativeHeld = revision === 2 ? createDeferred() : undefined;
      const publication = waitForCatalogs(revision);
      publications.push(publication);
      // The admission barrier can fail first; the original publication is still awaited below.
      void publication.catch(() => undefined);
      // Resolve the published owner before explicit inventory demand, as Gateway requests do.
      await Promise.all(
        snapshots.map(async (snapshot) => {
          const params = {
            agentId: snapshot.agentId,
            agentDir: snapshot.agentDir,
            config: fixture.config,
            readOnly: true,
          };
          await loadPublishedPreparedModelCatalogOwnerSnapshot(params);
          refreshExpiredPreparedModelCatalog(params);
        }),
      );
      await withTestTimeout(entered.promise, 30_000, "Expired provider catalog did not renew");
      const started = performance.now();
      pendingNative = snapshots[0]!.loadNativeModelCatalog!({
        provider: nativeProvider,
        modelId: `native-${revision}`,
        runtime: HARNESS_ID,
      });
      await withTestTimeout(
        nativeEntered.promise,
        5_000,
        "Native selection waited behind unrelated provider renewal",
      );
      if (nativeHeld) {
        // Exercise both completion orders; late native results must retain newer provider rows.
        held.resolve();
        held = undefined;
        await publication;
        nativeHeld.resolve();
        nativeHeld = undefined;
      }
      const native = await withTestTimeout(
        pendingNative,
        5_000,
        "Native selection did not complete",
      );
      admissionMs.push(performance.now() - started);
      expect(native).toMatchObject({
        entries: expect.arrayContaining([
          expect.objectContaining({
            provider: nativeProvider,
            id: `native-${revision}`,
            nativeRuntime: HARNESS_ID,
          }),
        ]),
      });
      held?.resolve();
      held = undefined;
      await publication;
      // A stable registration count alone cannot detect growth inside a live capture.
      const footprint = readCatalogCaptureFootprint(captureRoot, nativeArtifacts);
      expect(footprint).toEqual(initialFootprint);
      console.info("Catalog expiry capture footprint", JSON.stringify({ revision, ...footprint }));
      const published = snapshots[0]!.readFullModelCatalog!()!;
      expect(published.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: `provider-${revision}` }),
          expect.objectContaining({
            provider: nativeProvider,
            id: `native-${revision}`,
            nativeRuntime: HARNESS_ID,
          }),
        ]),
      );
      for (const [index, snapshot] of snapshots.entries()) {
        const auth = getPreparedModelFullCatalogAuth(snapshot.readFullModelCatalog!()!)!;
        expect(auth.authStore.profiles[`${PROVIDER_ID}:default`]).toMatchObject({
          key: `synthetic-catalog-${fixture.agentIds[index]}`,
        });
        if (revision === 3) {
          expect(auth.credentials?.[UNSEEN_NATIVE_PROVIDER]).toBeUndefined();
          expect(auth.authModes[UNSEEN_NATIVE_PROVIDER]).toBeUndefined();
          expect(
            Object.values(auth.authStore.profiles).some(
              (profile) => profile.provider === UNSEEN_NATIVE_PROVIDER,
            ),
          ).toBe(false);
        }
      }
    }
    for (const request of requests) {
      expect(request.authorization).toBe(`Bearer synthetic-catalog-${request.agent}`);
    }
    expect(fs.readFileSync(registrations, "utf8")).toBe(preparedRegistrations);
  } finally {
    held?.resolve();
    nativeHeld?.resolve();
    await Promise.allSettled([...work, pendingNative, ...publications]);
    restoreClock?.();
    unsubscribe();
    taskChannel.unsubscribe(recordTask);
    console.info(
      "Catalog native renewal proof",
      JSON.stringify({
        requests,
        nativeReads,
        admissionMs,
        taskMetrics,
        registrations: registrations
          ? fs.readFileSync(registrations, "utf8").trim().split("\n").filter(Boolean).length
          : 0,
      }),
    );
    server.listener.closeAllConnections();
    await server.releaseListener();
    await server.claim.release();
  }
}, 120_000);
