import { realpathSync } from "node:fs";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveLogbookConfig } from "./config.js";
import { LogbookService } from "./service.js";
import { logbookSqliteBackendEntrypoint } from "./sqlite-backend-entrypoint.test-support.js";
import { LogbookStore } from "./store.js";

const workerModuleUrl = resolveRuntimeWorkerUrl(logbookSqliteBackendEntrypoint);
const services: LogbookService[] = [];
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    try {
      await Promise.all(services.splice(0).map((service) => service.stop()));
    } finally {
      cleanup();
    }
  }),
);

type NodeRecord = { nodeId: string; displayName?: string; commands: string[] };

const quietLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

async function makeService(params: {
  nodes: NodeRecord[];
  invoke: (args: { nodeId: string; command: string }) => Promise<unknown>;
  config?: Record<string, unknown>;
  fullConfig?: Record<string, unknown>;
  logger?: typeof quietLogger;
}) {
  const dataDir = realpathSync(tempDirs.make("logbook-service-test-"));
  const invoked: Array<{ nodeId: string; command: string }> = [];
  const runtime = {
    nodes: {
      list: async () => ({ nodes: params.nodes }),
      invoke: async (args: { nodeId: string; command: string }) => {
        invoked.push({ nodeId: args.nodeId, command: args.command });
        return await params.invoke(args);
      },
    },
  };
  const service = new LogbookService(
    resolveLogbookConfig({ captureEnabled: true, ...params.config }),
    {
      runtime: runtime as never,
      fullConfig: (params.fullConfig ?? {}) as never,
      logger: (params.logger ?? quietLogger) as never,
      dataDir,
      workerModuleUrl,
      scheduler: createTestPluginServiceScheduler(),
    },
  );
  services.push(service);
  await service.start();
  const tick = () =>
    (service as unknown as { captureTick(): Promise<void> }).captureTick.call(service);
  return { service, invoked, tick };
}

const framePayload = {
  payload: { format: "jpeg", base64: Buffer.from("fake-jpeg").toString("base64") },
};

describe("LogbookService capture node selection", () => {
  it("rotates to the next capture node after a failure instead of re-picking the broken one", async () => {
    const { service, invoked, tick } = await makeService({
      nodes: [
        { nodeId: "a-broken", commands: ["logbook.snapshot"] },
        { nodeId: "b-working", commands: ["logbook.snapshot"] },
      ],
      invoke: async ({ nodeId }) => {
        if (nodeId === "a-broken") {
          return { payload: { error: "logbook.snapshot is not supported on linux" } };
        }
        return framePayload;
      },
    });

    await tick();
    await tick();
    expect(invoked.map((call) => call.nodeId)).toEqual(["a-broken", "b-working"]);
    expect((await service.status()).lastCaptureError).toBeUndefined();
  });

  it.each([
    ["malformed string", "not-base64!"],
    ["array", ["ZmFrZQ=="]],
  ])("rejects a %s snapshot payload before storing a frame", async (_label, base64) => {
    const { service, tick } = await makeService({
      nodes: [{ nodeId: "capture-node", commands: ["logbook.snapshot"] }],
      invoke: async () => ({ payload: { format: "jpeg", base64 } }),
    });

    await tick();

    expect(await service.status()).toMatchObject({
      pendingFrames: 0,
      lastCaptureError: "logbook.snapshot returned invalid image payload",
    });
  });
});

describe("LogbookService vision model selection", () => {
  it("warns about a missing model only when analysis work is pending", async () => {
    const warn = vi.fn();
    const { service, tick } = await makeService({
      nodes: [{ nodeId: "capture-node", commands: ["logbook.snapshot"] }],
      invoke: async () => framePayload,
      logger: { ...quietLogger, warn },
    });
    const analyze = () =>
      (service as unknown as { analysisTick(): Promise<void> }).analysisTick.call(service);

    await analyze();
    expect(warn).not.toHaveBeenCalled();

    await tick();
    await analyze();
    await analyze();
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("logbook: analysis paused; no vision model"),
    );
  });

  it("warns when a pending batch has no unbatched frames", async () => {
    const warn = vi.fn();
    const { service } = await makeService({
      nodes: [],
      invoke: async () => framePayload,
      config: { captureEnabled: false },
      logger: { ...quietLogger, warn },
    });
    const store = (service as unknown as { store: LogbookStore }).store;
    const capturedAtMs = Date.now();
    const day = new Date(capturedAtMs).toISOString().slice(0, 10);
    const frameId = await store.captureFrame({
      capturedAtMs,
      day,
      screenIndex: 0,
      buffer: Buffer.from("fake-jpeg"),
    });
    await store.createBatch({
      day,
      startMs: capturedAtMs,
      endMs: capturedAtMs + 1000,
      frameIds: [frameId],
    });

    expect(await store.countUnbatchedActiveFrames()).toBe(0);
    expect(await store.nextPendingBatch()).not.toBeNull();
    await (service as unknown as { analysisTick(): Promise<void> }).analysisTick();
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("logbook: analysis paused; no vision model"),
    );
  });

  it("borrows only a media provider with structured extraction", async () => {
    const { service } = await makeService({
      nodes: [],
      invoke: async () => framePayload,
      fullConfig: {
        tools: {
          media: {
            models: [
              { provider: "openai", model: "gpt-5.5", capabilities: ["image"] },
              { provider: " Codex ", model: "gpt-5.5", capabilities: ["image"] },
            ],
          },
        },
      },
    });

    expect(await service.status()).toMatchObject({
      visionModel: "codex/gpt-5.5",
      visionModelSource: "media-defaults",
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    expect(await service.status()).not.toHaveProperty("dataDir");
  });
});
