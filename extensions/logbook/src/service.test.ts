import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { dayKeyFor } from "./day.js";
import { LogbookStore } from "./store.js";
import { batchInput, quietLogger, useLogbookFixture } from "./test-fixtures.test-support.js";

const fixture = useLogbookFixture("logbook-service-test-");
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
  const dataDir = fixture.makeDir();
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
  const service = await fixture.startService(
    { captureEnabled: true, ...params.config },
    {
      runtime: runtime as never,
      fullConfig: (params.fullConfig ?? {}) as never,
      logger: { ...quietLogger, warn },
      dataDir,
    },
  );
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
  it.each([false, true])(
    "warns only for pending work, with frames batched: %s",
    async (batched) => {
      const { service, tick, analyze, warn } = await makeService({});
      await analyze();
      expect(warn).not.toHaveBeenCalled();
      await tick();
      if (batched) {
        const store = (service as unknown as { store: LogbookStore }).store;
        const frame = expectDefined((await store.unbatchedActiveFrames(1))[0], "captured frame");
        await store.createBatch(
          batchInput(
            [frame.id],
            frame.capturedAtMs,
            frame.capturedAtMs + 1000,
            dayKeyFor(frame.capturedAtMs),
          ),
        );
        expect(await store.countUnbatchedActiveFrames()).toBe(0);
        expect(await store.nextPendingBatch()).not.toBeNull();
      }
      await analyze();
      await analyze();
      expect(warn).toHaveBeenCalledExactlyOnceWith(missingModelWarning);
    },
  );

  it("borrows only a media provider with structured extraction", async () => {
    const models = ["openai", " Codex "].map((provider) => ({
      provider,
      model: "gpt-5.5",
      capabilities: ["image"],
    }));
    const { service } = await makeService({
      nodeIds: [],
      fullConfig: { tools: { media: { models } } },
    });

    expect(await service.status()).toMatchObject({
      visionModel: "codex/gpt-5.5",
      visionModelSource: "media-defaults",
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    expect(await service.status()).not.toHaveProperty("dataDir");
  });
});
