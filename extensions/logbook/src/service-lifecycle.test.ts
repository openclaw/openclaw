import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenClawPluginApi, OpenClawPluginService } from "openclaw/plugin-sdk/plugin-entry";
import {
  createCapturedPluginRegistration,
  createPluginRuntimeMock,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "../index.js";
import { resolveLogbookConfig } from "./config.js";
import { dayKeyFor } from "./day.js";
import { LogbookService } from "./service.js";
import { LogbookStore } from "./store.js";

const workerModuleUrl = new URL("./store.worker.ts", import.meta.url);
const runtimeSource = fileURLToPath(new URL("../index.ts", import.meta.url));
const quietLogger = { info() {}, warn() {}, error() {}, debug() {} };
const snapshot = { payload: { base64: Buffer.from("synthetic image").toString("base64") } };

afterEach(() => vi.restoreAllMocks());
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

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

describe("Logbook service disposal", () => {
  it.each([false, true])(
    "publishes synthesized cards with queued retention (prune=%s)",
    async (prune) => {
      const dataDir = tempDirs.make("logbook-publication-retention-");
      const day = dayKeyFor(Date.now());
      const startMs = new Date(`${day}T10:00:00`).getTime();
      const endMs = startMs + 10 * 60_000;
      const runtime = createPluginRuntimeMock();
      runtime.mediaUnderstanding.extractStructuredWithModel = vi.fn(async () => ({
        text: JSON.stringify([
          { start: "10:00:00", end: "10:10:00", description: "Synthetic activity" },
        ]),
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
          JSON.stringify([
            {
              startTime: "10:00:00",
              endTime: "10:10:00",
              title: "Retained synthesis",
              summary: "Published through retention",
              category: "coding",
            },
          ]),
        );
      });
      const logger = { ...quietLogger, warn: vi.fn(), error: vi.fn() };
      const service = new LogbookService(
        resolveLogbookConfig({ captureEnabled: false, visionModel: "codex/gpt-5.6-sol" }),
        { dataDir, workerModuleUrl, runtime, fullConfig: {}, logger },
      );
      const peer = await LogbookStore.open(dataDir, workerModuleUrl);
      try {
        const frameId = await peer.captureFrame({
          day,
          capturedAtMs: startMs + 5 * 60_000,
          screenIndex: 0,
          buffer: Buffer.from("synthetic keyframe"),
        });
        await peer.createBatch({ day, startMs, endMs, frameIds: [frameId] });
        await service.start();
        expect(await service.analyzeNow()).toEqual({ started: true });
        await synthesized.promise;
        await setImmediate();
        expect(await pruning).toEqual({ status: "fulfilled", value: prune ? 1 : 0 });
        await service.stop();
        expect(await peer.latestBatch()).toMatchObject({ status: "done", error: undefined });
        expect(logger.warn).not.toHaveBeenCalled();
        const cards = await peer.cardsForDay(day);
        expect(cards).toHaveLength(1);
        expect(cards[0]).toMatchObject({
          title: "Retained synthesis",
          keyframeId: prune ? undefined : frameId,
        });
        await peer.close();
        const reopened = await LogbookStore.open(dataDir, workerModuleUrl);
        try {
          expect(await reopened.cardsForDay(day)).toEqual(cards);
        } finally {
          await reopened.close();
        }
      } finally {
        await pruning;
        await service.stop();
        await peer.close();
      }
    },
  );

  it("joins a pending database open and asynchronous close when the runtime retires", async () => {
    const stateDir = tempDirs.make("logbook-opening-");
    const store = await LogbookStore.open(path.join(stateDir, "logbook"), workerModuleUrl);
    const opened = createDeferred<void>();
    const releaseOpen = createDeferred<void>();
    const closing = createDeferred<void>();
    const releaseClose = createDeferred<void>();
    vi.spyOn(LogbookStore, "open").mockImplementationOnce(async () => {
      opened.resolve();
      await releaseOpen.promise;
      return store;
    });
    const closeStore = store.close.bind(store);
    vi.spyOn(store, "close").mockImplementationOnce(async () => {
      closing.resolve();
      await releaseClose.promise;
      await closeStore();
    });
    const captured = createCapturedPluginRegistration({ id: "logbook" });
    captured.api.pluginConfig = { captureEnabled: false };
    const services: OpenClawPluginService[] = [];
    captured.api.registerService = (service) => services.push(service);
    plugin.register({ ...captured.api, runtimeSource });
    const service = services[0]!;
    const context = { config: {}, stateDir, logger: quietLogger };
    const starting = service.start(context);
    await opened.promise;
    const completed = vi.fn();
    const stopping = Promise.all(
      captured.runtimeLifecycles.map(async (lifecycle) => {
        await lifecycle.cleanup?.({ reason: "disable" });
      }),
    ).then(completed);
    try {
      releaseOpen.resolve();
      await closing.promise;
      expect(completed).not.toHaveBeenCalled();
      await expect(service.start(context)).rejects.toThrow("runtime has been retired");
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
    const service = new LogbookService(resolveLogbookConfig({ captureEnabled: false }), {
      dataDir,
      workerModuleUrl,
      runtime: createPluginRuntimeMock(),
      fullConfig: {},
      logger: quietLogger,
    });
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
    const service = new LogbookService(
      resolveLogbookConfig({ captureEnabled: false, visionModel: "synthetic/vision" }),
      {
        dataDir,
        workerModuleUrl,
        runtime: createPluginRuntimeMock(),
        fullConfig: {},
        logger: quietLogger,
      },
    );
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
    "capture-invoke",
    "capture-write",
    "vision-success",
    "vision-error",
    "standup",
    "standup-write",
    "status-read",
    "ask-read",
    "frame-read",
  ])("drains %s before closing SQLite", async (kind) => {
    const dataDir = realpathSync(mkdtempSync(path.join(tmpdir(), "logbook-service-drain-")));
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
    runtime.nodes.invoke = vi.fn(async () => {
      if (kind === "capture-invoke") {
        entered.resolve();
        await release.promise;
      }
      return snapshot;
    });
    runtime.mediaUnderstanding.extractStructuredWithModel = vi.fn(async () => {
      entered.resolve();
      await release.promise;
      if (kind === "vision-error") {
        throw new Error("synthetic vision failure");
      }
      return {
        text: JSON.stringify([
          { start: "10:00:00", end: "10:01:00", description: "Synthetic activity" },
        ]),
      };
    });
    runtime.llm.complete = vi.fn(async () => {
      if (kind.startsWith("standup")) {
        if (kind === "standup") {
          entered.resolve();
          await release.promise;
        }
        return completion("Synthetic standup");
      }
      return completion(
        JSON.stringify([
          {
            startTime: "10:00:00",
            endTime: "10:01:00",
            title: "Synthetic activity",
            summary: "Completed before shutdown",
            category: "coding",
          },
        ]),
      );
    });
    if (kind.startsWith("vision")) {
      const seed = await LogbookStore.open(dataDir, workerModuleUrl);
      try {
        for (let index = 0; index < 2; index++) {
          const time = startMs + index * 120_000;
          const framePath = seed.frameFilePath(day, time);
          mkdirSync(path.dirname(framePath), { recursive: true });
          writeFileSync(framePath, "synthetic image");
          const frameId = await seed.insertFrame({
            capturedAtMs: time,
            day,
            path: framePath,
            screenIndex: 0,
            byteSize: 15,
            contentHash: `synthetic-${index}`,
            idle: false,
          });
          await seed.createBatch({
            day,
            startMs: time,
            endMs: time + 60_000,
            frameIds: [frameId],
          });
        }
      } finally {
        await seed.close();
      }
    }
    const activeStore = await LogbookStore.open(dataDir, workerModuleUrl);
    vi.spyOn(LogbookStore, "open").mockResolvedValueOnce(activeStore);
    if (kind === "frame-read") {
      await activeStore.captureFrame({
        capturedAtMs: Date.now(),
        day,
        screenIndex: 0,
        buffer: Buffer.from("synthetic frame payload"),
      });
      const framePayload = activeStore.framePayload.bind(activeStore);
      vi.spyOn(activeStore, "framePayload").mockImplementation(async (id) => {
        entered.resolve();
        await release.promise;
        return await framePayload(id);
      });
    }
    if (kind === "capture-write") {
      const captureFrame = activeStore.captureFrame.bind(activeStore);
      vi.spyOn(activeStore, "captureFrame").mockImplementation(async (frame) => {
        entered.resolve();
        await release.promise;
        return await captureFrame(frame);
      });
    }
    if (kind === "standup-write") {
      const saveStandup = activeStore.saveStandup.bind(activeStore);
      vi.spyOn(activeStore, "saveStandup").mockImplementation(async (...args) => {
        entered.resolve();
        await release.promise;
        await saveStandup(...args);
      });
    }
    if (kind === "status-read") {
      const latestBatch = activeStore.latestBatch.bind(activeStore);
      vi.spyOn(activeStore, "latestBatch").mockImplementation(async () => {
        entered.resolve();
        await release.promise;
        return await latestBatch();
      });
    }
    if (kind === "ask-read") {
      const observationsInRange = activeStore.observationsInRange.bind(activeStore);
      vi.spyOn(activeStore, "observationsInRange").mockImplementation(async (...args) => {
        entered.resolve();
        await release.promise;
        return await observationsInRange(...args);
      });
    }
    const service = new LogbookService(
      resolveLogbookConfig({
        captureEnabled: true,
        captureIntervalSeconds: 600,
        visionModel: "synthetic/vision",
      }),
      { runtime, fullConfig: {}, logger, dataDir, workerModuleUrl },
    );
    await service.start();
    const ticks = service as unknown as {
      captureTick(): Promise<void>;
      analysisTick(): Promise<void>;
    };
    const active = kind.startsWith("capture")
      ? ticks.captureTick()
      : kind.startsWith("vision")
        ? ticks.analysisTick()
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
      expect(logger.error).not.toHaveBeenCalled();
      const reopened = await LogbookStore.open(dataDir, workerModuleUrl);
      try {
        if (kind.startsWith("capture")) {
          expect(await reopened.countUnbatchedActiveFrames()).toBe(1);
          expect(runtime.nodes.invoke).toHaveBeenCalledTimes(1);
        } else if (kind.startsWith("standup")) {
          expect((await reopened.getStandup(day))?.text).toBe("Synthetic standup");
        } else if (kind.endsWith("-read")) {
          expect(await reopened.latestBatch()).toBeNull();
        } else {
          const db = new DatabaseSync(path.join(dataDir, "logbook.sqlite"), { readOnly: true });
          try {
            expect(db.prepare("SELECT status, error FROM batches ORDER BY id").all()).toEqual([
              {
                status: kind === "vision-success" ? "done" : "error",
                error: kind === "vision-success" ? null : "synthetic vision failure",
              },
              { status: "pending", error: null },
            ]);
            expect(runtime.mediaUnderstanding.extractStructuredWithModel).toHaveBeenCalledTimes(1);
          } finally {
            db.close();
          }
        }
      } finally {
        await reopened.close();
      }
    } finally {
      release.resolve();
      await active.catch(() => {});
      await settled;
      await service.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it.each(["restart", "disable"] as const)(
    "joins service stop and whole-plugin %s cleanup without stopping sessions",
    async (reason) => {
      const stateDir = realpathSync(mkdtempSync(path.join(tmpdir(), "logbook-runtime-drain-")));
      const captured = createCapturedPluginRegistration({ id: "logbook" });
      captured.api.pluginConfig = { captureEnabled: false };
      const services: OpenClawPluginService[] = [];
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
      const context = { config: {}, stateDir, logger: quietLogger };
      await service.start(context);
      const call = async (name: string, params = {}) => {
        const respond = vi.fn();
        await handlers.get(name)!({ params, respond } as never);
        return respond.mock.calls[0];
      };
      const cleanup = async (scope: {
        reason: typeof reason | "reset" | "delete";
        sessionKey?: string;
        runId?: string;
      }) => {
        for (const lifecycle of captured.runtimeLifecycles) {
          await lifecycle.cleanup?.(scope);
        }
      };
      try {
        for (const scope of [
          { reason: "reset" as const },
          { reason: "delete" as const },
          { reason, sessionKey: "" },
          { reason, runId: "" },
        ]) {
          await cleanup(scope);
          expect((await call("logbook.status"))?.[0]).toBe(true);
        }
        const standup = call("logbook.standup");
        await entered.promise;
        const retired = vi.fn();
        const retiring = cleanup({ reason }).then(retired);
        await setImmediate();
        expect.soft(retired).not.toHaveBeenCalled();
        expect.soft((await call("logbook.status"))?.[0]).toBe(false);
        const stopping = Promise.resolve(service.stop?.(context));
        release.resolve();
        expect((await standup)?.[0]).toBe(true);
        await Promise.all([retiring, stopping, cleanup({ reason })]);
        const reopened = await LogbookStore.open(path.join(stateDir, "logbook"), workerModuleUrl);
        try {
          expect((await reopened.getStandup(dayKeyFor(Date.now())))?.text).toBe("Accepted standup");
        } finally {
          await reopened.close();
        }
      } finally {
        release.resolve();
        await service.stop?.(context);
        rmSync(stateDir, { recursive: true, force: true });
      }
    },
  );

  it("does not start a service after its registered runtime has retired", async () => {
    const stateDir = realpathSync(mkdtempSync(path.join(tmpdir(), "logbook-retired-start-")));
    const captured = createCapturedPluginRegistration({ id: "logbook" });
    captured.api.pluginConfig = { captureEnabled: false };
    const services: OpenClawPluginService[] = [];
    captured.api.registerService = (service) => services.push(service);
    plugin.register({ ...captured.api, runtimeSource });
    const context = { config: {}, stateDir, logger: quietLogger };
    try {
      for (const lifecycle of captured.runtimeLifecycles) {
        await lifecycle.cleanup?.({ reason: "restart" });
      }
      await expect(services[0]!.start(context)).rejects.toThrow("runtime has been retired");
      expect(existsSync(path.join(stateDir, "logbook", "logbook.sqlite"))).toBe(false);
    } finally {
      await services[0]!.stop?.(context);
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
