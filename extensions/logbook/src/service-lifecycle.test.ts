import { realpathSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
  createTestPluginServiceScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import {
  createCapturedPluginRegistration,
  createPluginRuntimeMock,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "../index.js";
import { resolveLogbookConfig, type LogbookConfig } from "./config.js";
import { dayKeyFor } from "./day.js";
import { LogbookService } from "./service.js";
import { logbookSqliteBackendEntrypoint } from "./sqlite-backend-entrypoint.test-support.js";
import { LogbookStore } from "./store.js";

const workerModuleUrl = resolveRuntimeWorkerUrl(logbookSqliteBackendEntrypoint);
const runtimeSource = fileURLToPath(new URL("../index.ts", import.meta.url));
const quietLogger = { info() {}, warn() {}, error() {}, debug() {} };
const snapshot = { payload: { base64: Buffer.from("synthetic image").toString("base64") } };

afterEach(() => vi.restoreAllMocks());
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function makeService(
  dataDir: string,
  config: Partial<LogbookConfig> = {},
  deps: Partial<ConstructorParameters<typeof LogbookService>[1]> = {},
) {
  return new LogbookService(resolveLogbookConfig({ captureEnabled: false, ...config }), {
    dataDir,
    workerModuleUrl,
    runtime: createPluginRuntimeMock(),
    fullConfig: {},
    logger: quietLogger,
    scheduler: createTestPluginServiceScheduler(),
    ...deps,
  });
}

function block<Args extends unknown[], Result>(
  run: (...args: Args) => Promise<Result>,
  entered: ReturnType<typeof createDeferred<void>>,
  release: ReturnType<typeof createDeferred<void>>,
) {
  return async (...args: Args) => {
    entered.resolve();
    await release.promise;
    return await run(...args);
  };
}

function completion(
  text: string,
): Awaited<ReturnType<OpenClawPluginApi["runtime"]["llm"]["complete"]>> {
  return {
    text,
    provider: "synthetic",
    model: "synthetic",
    agentId: "main",
    usage: {},
    execution: { mode: "direct-provider", owner: { kind: "provider", id: "synthetic" } },
    audit: { caller: { kind: "plugin", id: "logbook" } },
  };
}

function observationText(end: string) {
  return JSON.stringify([{ start: "10:00:00", end, description: "Synthetic activity" }]);
}

function cardText(endTime: string, title: string, summary: string) {
  return JSON.stringify([{ startTime: "10:00:00", endTime, title, summary, category: "coding" }]);
}

async function openStore(dataDir: string) {
  const store = await LogbookStore.open(dataDir, workerModuleUrl);
  return Object.assign(store, { [Symbol.asyncDispose]: () => store.close() });
}

function capture(store: LogbookStore, day: string, capturedAtMs: number, text: string) {
  return store.captureFrame({ day, capturedAtMs, screenIndex: 0, buffer: Buffer.from(text) });
}

describe("Logbook service disposal", () => {
  it.each([
    { prune: true, pending: false },
    { prune: false, pending: true },
  ])(
    "publishes synthesized cards with queued retention (prune=$prune, pending=$pending)",
    async ({ prune, pending }) => {
      const dataDir = tempDirs.make("logbook-publication-retention-");
      const day = dayKeyFor(Date.now());
      const startMs = new Date(`${day}T10:00:00`).getTime();
      const endMs = startMs + 10 * 60_000;
      const runtime = createPluginRuntimeMock();
      runtime.mediaUnderstanding.extractStructuredWithModel = vi.fn(async () => ({
        text: observationText("10:10:00"),
      }));
      const synthesized = createDeferred<void>();
      let pruning: Promise<PromiseSettledResult<number>> = Promise.resolve({
        status: "fulfilled",
        value: 0,
      });
      runtime.llm.complete = vi.fn(async () => {
        if (prune) {
          // Let synthesis enqueue its next worker command, then queue retention before its reply.
          queueMicrotask(() =>
            queueMicrotask(() => {
              pruning = peer.pruneFrames(endMs).then(
                (value) => ({ status: "fulfilled", value }),
                (reason: unknown) => ({ status: "rejected", reason }),
              );
            }),
          );
        }
        synthesized.resolve();
        return completion(
          cardText("10:10:00", "Retained synthesis", "Published through retention"),
        );
      });
      const logger = { ...quietLogger, warn: vi.fn(), error: vi.fn() };
      const service = makeService(
        dataDir,
        { visionModel: "codex/gpt-5.6-sol", analysisIntervalMinutes: 10 },
        { runtime, logger },
      );
      const peer = await LogbookStore.open(dataDir, workerModuleUrl);
      try {
        const frameTimes = pending
          ? [...Array.from({ length: 10 }, (_, index) => startMs + index * 60_000), endMs - 1]
          : [startMs + 5 * 60_000];
        const frameIds: number[] = [];
        for (const capturedAtMs of frameTimes) {
          frameIds.push(
            await capture(peer, day, capturedAtMs, `synthetic keyframe ${capturedAtMs}`),
          );
        }
        const frameId = frameIds[pending ? 5 : 0];
        if (pending) {
          expect(await peer.latestBatch()).toBeNull();
          expect(await peer.countUnbatchedActiveFrames()).toBe(11);
        } else {
          await peer.createBatch({ day, startMs, endMs, frameIds });
        }
        await service.start();
        expect(await service.analyzeNow()).toEqual({ started: true });
        await synthesized.promise;
        await setImmediate();
        expect(await pruning).toEqual({ status: "fulfilled", value: prune ? 1 : 0 });
        await service.stop();
        const batch = await peer.latestBatch();
        if (!batch) {
          throw new Error("Expected the analyzed batch to persist");
        }
        expect(batch).toMatchObject({
          day,
          startMs,
          endMs,
          frameCount: frameIds.length,
          status: "done",
          error: undefined,
        });
        const frames = (await peer.batchImages(batch.id)).map(({ frame }) => frame);
        expect(frames).toEqual(
          prune
            ? []
            : frameIds.map((id, index) =>
                expect.objectContaining({ id, capturedAtMs: frameTimes[index], idle: false }),
              ),
        );
        expect(await peer.countUnbatchedActiveFrames()).toBe(0);
        expect(logger.warn).not.toHaveBeenCalled();
        const cards = await peer.cardsForDay(day);
        expect(cards).toHaveLength(1);
        expect(cards[0]).toMatchObject({
          title: "Retained synthesis",
          day,
          startMs,
          endMs,
          keyframeId: prune ? undefined : frameId,
        });
        await peer.close();
        await using reopened = await openStore(dataDir);
        expect(await reopened.cardsForDay(day)).toEqual(cards);
        expect(await reopened.latestBatch()).toEqual(batch);
        expect((await reopened.batchImages(batch.id)).map(({ frame }) => frame)).toEqual(frames);
        expect(await reopened.countUnbatchedActiveFrames()).toBe(0);
      } finally {
        await pruning;
        await service.stop();
        await peer.close();
      }
    },
  );

  it("settles startup storage and asynchronous close before service stop finishes", async () => {
    const dataDir = tempDirs.make("logbook-opening-");
    const store = await LogbookStore.open(dataDir, workerModuleUrl);
    const opened = createDeferred<void>();
    const releaseOpen = createDeferred<void>();
    const closing = createDeferred<void>();
    const releaseClose = createDeferred<void>();
    vi.spyOn(LogbookStore, "open").mockImplementationOnce(
      block(async () => store, opened, releaseOpen),
    );
    const closeStore = store.close.bind(store);
    vi.spyOn(store, "close").mockImplementationOnce(block(closeStore, closing, releaseClose));
    const service = makeService(dataDir);
    const starting = service.start();
    await opened.promise;
    const completed = vi.fn();
    const stopping = service.stop().then(completed);
    try {
      releaseOpen.resolve();
      await closing.promise;
      expect(completed).not.toHaveBeenCalled();
    } finally {
      releaseOpen.resolve();
      releaseClose.resolve();
      await Promise.all([starting, stopping]);
    }
    await expect(store.lastFrame()).rejects.toThrow();
  });

  it("closes storage when startup recovery fails without publishing a running service", async () => {
    const dataDir = tempDirs.make("logbook-startup-failure-");
    const close = vi.spyOn(LogbookStore.prototype, "close");
    vi.spyOn(LogbookStore.prototype, "resetRunningBatches").mockRejectedValueOnce(
      new Error("storage unavailable"),
    );
    const service = makeService(dataDir);
    try {
      await expect(service.start()).rejects.toThrow("storage unavailable");
      await expect(service.status()).rejects.toThrow("not running");
    } finally {
      await service.stop();
    }
    expect(close).toHaveBeenCalledOnce();
  });

  it("owns delayed manual analysis preparation through rejection and stop", async () => {
    const dataDir = tempDirs.make("logbook-analysis-admission-");
    const service = makeService(dataDir, { visionModel: "synthetic/vision" });
    await service.start();
    const entered = createDeferred<void>();
    const reset = createDeferred<number>();
    vi.spyOn(LogbookStore.prototype, "resetErrorBatches").mockImplementationOnce(() => {
      entered.resolve();
      return reset.promise;
    });
    const close = vi.spyOn(LogbookStore.prototype, "close");
    const analysis = service.analyzeNow();
    const rejected = expect(analysis).rejects.toThrow("storage unavailable");
    await entered.promise;
    expect(await service.analyzeNow()).toEqual({
      started: false,
      reason: "analysis already running",
    });
    const stopping = service.stop();
    try {
      await setImmediate();
      expect(close).not.toHaveBeenCalled();
      await expect(service.analyzeNow()).rejects.toThrow("not running");
    } finally {
      reset.reject(new Error("storage unavailable"));
      await rejected;
      await stopping;
    }
    expect(close).toHaveBeenCalledOnce();
  });

  it.each([
    "capture-list",
    "capture-write",
    "vision-success",
    "vision-error",
    "standup-write",
    "status-read",
    "ask-read",
    "frame-read",
  ])("drains %s before closing SQLite", async (kind) => {
    const dataDir = realpathSync(tempDirs.make("logbook-service-drain-"));
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const runtime = createPluginRuntimeMock();
    const day = dayKeyFor(Date.now());
    const startMs = new Date(`${day}T10:00:00`).getTime();
    const logger = { ...quietLogger, error: vi.fn(), warn: vi.fn() };
    const nodes = { nodes: [{ nodeId: "synthetic-node", commands: ["screen.snapshot"] }] };
    runtime.nodes.list = vi.fn(async () => {
      if (kind === "capture-list") {
        entered.resolve();
        await release.promise;
      }
      return nodes;
    });
    runtime.nodes.invoke = vi.fn(async () => snapshot);
    runtime.mediaUnderstanding.extractStructuredWithModel = vi.fn(async () => {
      entered.resolve();
      await release.promise;
      if (kind === "vision-error") {
        throw new Error("synthetic vision failure");
      }
      return { text: observationText("10:01:00") };
    });
    runtime.llm.complete = vi.fn(async () => {
      if (kind.startsWith("standup")) {
        return completion("Synthetic standup");
      }
      return completion(cardText("10:01:00", "Synthetic activity", "Completed before shutdown"));
    });
    if (kind.startsWith("vision")) {
      await using seed = await openStore(dataDir);
      for (let index = 0; index < 2; index++) {
        const time = startMs + index * 120_000;
        const frameId = await capture(seed, day, time, `synthetic image ${index}`);
        await seed.createBatch({ day, startMs: time, endMs: time + 60_000, frameIds: [frameId] });
      }
    }
    const activeStore = await LogbookStore.open(dataDir, workerModuleUrl);
    vi.spyOn(LogbookStore, "open").mockResolvedValueOnce(activeStore);
    if (kind === "frame-read") {
      await capture(activeStore, day, Date.now(), "synthetic frame payload");
      const framePayload = activeStore.framePayload.bind(activeStore);
      vi.spyOn(activeStore, "framePayload").mockImplementation(
        block(framePayload, entered, release),
      );
    }
    if (kind === "capture-write") {
      const captureFrame = activeStore.captureFrame.bind(activeStore);
      vi.spyOn(activeStore, "captureFrame").mockImplementation(
        block(captureFrame, entered, release),
      );
    }
    if (kind === "standup-write") {
      const saveStandup = activeStore.saveStandup.bind(activeStore);
      vi.spyOn(activeStore, "saveStandup").mockImplementation(block(saveStandup, entered, release));
    }
    if (kind === "status-read") {
      const latestBatch = activeStore.latestBatch.bind(activeStore);
      vi.spyOn(activeStore, "latestBatch").mockImplementation(block(latestBatch, entered, release));
    }
    if (kind === "ask-read") {
      const observationsInRange = activeStore.observationsInRange.bind(activeStore);
      vi.spyOn(activeStore, "observationsInRange").mockImplementation(
        block(observationsInRange, entered, release),
      );
    }
    const clock = createGatewaySchedulerClock();
    const service = makeService(
      dataDir,
      {
        captureEnabled: true,
        captureIntervalSeconds: kind.startsWith("capture") ? 5 : 600,
        visionModel: "synthetic/vision",
      },
      {
        runtime,
        logger,
        scheduler: createTestPluginServiceScheduler(createTestGatewayScheduler(clock.clock)),
      },
    );
    await service.start();
    const active =
      kind.startsWith("capture") || kind.startsWith("vision")
        ? Promise.resolve(clock.wake())
        : kind === "status-read"
          ? service.status()
          : kind === "ask-read"
            ? service.ask(day, "What happened?")
            : kind === "frame-read"
              ? service.framePayload(1)
              : service.standup(day, true);
    void active.catch(() => {});
    await entered.promise;
    const stopped = vi.fn();
    const stopping = service.stop();
    const settled = Promise.resolve(stopping).then(stopped);
    try {
      expect(service.stop()).toBe(stopping);
      await setImmediate();
      expect.soft(stopped).not.toHaveBeenCalled();
      await expect(service.standup(day, true)).rejects.toThrow("not running");
      await expect(service.analyzeNow()).rejects.toThrow("not running");
      release.resolve();
      const result = await active;
      if (kind === "frame-read") {
        expect(result).toMatchObject({
          frameId: 1,
          base64: Buffer.from("synthetic frame payload").toString("base64"),
        });
      }
      await settled;
      expect(clock.armedAtMs).toBeNull();
      expect(logger.error).not.toHaveBeenCalled();
      await using reopened = await openStore(dataDir);
      if (kind.startsWith("capture")) {
        expect(await reopened.countUnbatchedActiveFrames()).toBe(1);
        expect(runtime.nodes.invoke).toHaveBeenCalledTimes(1);
      } else if (kind.startsWith("standup")) {
        expect(result).toEqual({ day, text: "Synthetic standup", updatedMs: expect.any(Number) });
        expect(await reopened.getStandup(day)).toEqual(result);
      } else if (kind.endsWith("-read")) {
        expect(await reopened.latestBatch()).toBeNull();
      } else {
        using db = new DatabaseSync(path.join(dataDir, "logbook.sqlite"), { readOnly: true });
        expect(db.prepare("SELECT status, error FROM batches ORDER BY id").all()).toEqual([
          {
            status: kind === "vision-success" ? "done" : "error",
            error: kind === "vision-success" ? null : "synthetic vision failure",
          },
          { status: "pending", error: null },
        ]);
        expect(runtime.mediaUnderstanding.extractStructuredWithModel).toHaveBeenCalledTimes(1);
      }
    } finally {
      release.resolve();
      await active.catch(() => {});
      await settled;
      await service.stop();
    }
  });

  it("drains an admitted standup through the registered service stop", async () => {
    const stateDir = realpathSync(tempDirs.make("logbook-runtime-drain-"));
    const captured = createCapturedPluginRegistration({ id: "logbook" });
    captured.api.pluginConfig = { captureEnabled: false };
    const services: Parameters<OpenClawPluginApi["registerService"]>[0][] = [];
    captured.api.registerService = (service) => services.push(service);
    const handlers = new Map<string, Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1]>();
    captured.api.registerGatewayMethod = (name, handler) => handlers.set(name, handler);
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    captured.api.runtime.llm.complete = async () => {
      entered.resolve();
      await release.promise;
      return completion("Accepted standup");
    };
    plugin.register({ ...captured.api, runtimeSource });
    const service = services[0]!;
    const context = {
      config: {},
      stateDir,
      logger: quietLogger,
      scheduler: createTestPluginServiceScheduler(),
    };
    await service.start(context);
    const call = async (name: string, params = {}) => {
      const respond = vi.fn();
      await handlers.get(name)!({ params, respond } as never);
      return respond.mock.calls[0];
    };
    try {
      const standup = call("logbook.standup");
      await entered.promise;
      const retired = vi.fn();
      context.scheduler.beginClose();
      const stopping = Promise.resolve(service.stop?.(context)).then(retired);
      await setImmediate();
      expect.soft(retired).not.toHaveBeenCalled();
      expect.soft((await call("logbook.status"))?.[0]).toBe(false);
      release.resolve();
      expect((await standup)?.[0]).toBe(true);
      await stopping;
      await using reopened = await openStore(path.join(stateDir, "logbook"));
      expect((await reopened.getStandup(dayKeyFor(Date.now())))?.text).toBe("Accepted standup");
    } finally {
      release.resolve();
      context.scheduler.beginClose();
      await service.stop?.(context);
      await context.scheduler.stop();
    }
  });
});
