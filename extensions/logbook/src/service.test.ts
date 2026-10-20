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

const quietLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};
const framePayload = {
  payload: { format: "jpeg", base64: Buffer.from("fake-jpeg").toString("base64") },
};
const missingModelWarning = expect.stringContaining("logbook: analysis paused; no vision model");

async function makeService(params: {
  nodeIds?: string[];
  invoke?: (args: { nodeId: string; command: string }) => Promise<unknown>;
  config?: Record<string, unknown>;
  fullConfig?: Record<string, unknown>;
}) {
  const dataDir = realpathSync(tempDirs.make("logbook-service-test-"));
  const warn = vi.fn();
  const invoked: Array<{ nodeId: string; command: string }> = [];
  const runtime = {
    nodes: {
      list: async () => ({
        nodes: (params.nodeIds ?? ["capture-node"]).map((nodeId) => ({
          nodeId,
          commands: ["logbook.snapshot"],
        })),
      }),
      invoke: async (args: { nodeId: string; command: string }) => {
        invoked.push({ nodeId: args.nodeId, command: args.command });
        return params.invoke ? await params.invoke(args) : framePayload;
      },
    },
  };
  const service = new LogbookService(
    resolveLogbookConfig({ captureEnabled: true, ...params.config }),
    {
      runtime: runtime as never,
      fullConfig: (params.fullConfig ?? {}) as never,
      logger: { ...quietLogger, warn },
      dataDir,
      workerModuleUrl,
      scheduler: createTestPluginServiceScheduler(),
    },
  );
  services.push(service);
  await service.start();
  const tick = () =>
    (service as unknown as { captureTick(): Promise<void> }).captureTick.call(service);
  const analyze = () =>
    (service as unknown as { analysisTick(): Promise<void> }).analysisTick.call(service);
  return { service, invoked, tick, analyze, warn };
}

describe("LogbookService capture node selection", () => {
  it("rotates to the next capture node after a failure instead of re-picking the broken one", async () => {
    const { service, invoked, tick } = await makeService({
      nodeIds: ["a-broken", "b-working"],
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
    const { tick, analyze, warn } = await makeService({});

    await analyze();
    expect(warn).not.toHaveBeenCalled();

    await tick();
    await analyze();
    await analyze();
    expect(warn).toHaveBeenCalledExactlyOnceWith(missingModelWarning);
  });

  it("warns when a pending batch has no unbatched frames", async () => {
    const { service, analyze, warn } = await makeService({
      nodeIds: [],
      config: { captureEnabled: false },
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
    await analyze();
    expect(warn).toHaveBeenCalledExactlyOnceWith(missingModelWarning);
  });

  it("borrows only a media provider with structured extraction", async () => {
    const { service } = await makeService({
      nodeIds: [],
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
