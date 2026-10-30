import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
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
  fullConfig?: Record<string, unknown>;
}) {
  const warn = vi.fn();
  const invoke = vi.fn(async (args: { nodeId: string; command: string }) =>
    params.invoke ? await params.invoke(args) : framePayload,
  );
  const nodes = (params.nodeIds ?? ["capture-node"]).map((nodeId) => ({
    nodeId,
    commands: ["logbook.snapshot"],
  }));
  const service = await fixture.startService(
    { captureEnabled: true },
    {
      runtime: { nodes: { list: async () => ({ nodes }), invoke } } as never,
      fullConfig: (params.fullConfig ?? {}) as never,
      logger: { ...quietLogger, warn },
      dataDir: fixture.makeDir(),
    },
  );
  const tick = () =>
    (service as unknown as { captureTick(): Promise<void> }).captureTick.call(service);
  const analyze = () =>
    (service as unknown as { analysisTick(): Promise<void> }).analysisTick.call(service);
  return { service, invoke, tick, analyze, warn };
}

const invalidImage = "logbook.snapshot returned invalid image payload";
it.each([
  [
    { error: "logbook.snapshot is not supported on linux" },
    "logbook.snapshot is not supported on linux",
  ],
  [{ format: "jpeg", base64: "not-base64!" }, invalidImage],
  [{ format: "jpeg", base64: ["ZmFrZQ=="] }, invalidImage],
])("rejects bad capture %j and rotates to the next node", async (payload, error) => {
  const { service, invoke, tick } = await makeService({
    nodeIds: ["a-broken", "b-working"],
    invoke: async ({ nodeId }) => (nodeId === "a-broken" ? { payload } : framePayload),
  });
  await tick();
  expect(await service.status()).toMatchObject({ pendingFrames: 0, lastCaptureError: error });
  await tick();
  expect(invoke.mock.calls.map(([call]) => call.nodeId)).toEqual(["a-broken", "b-working"]);
  expect((await service.status()).lastCaptureError).toBeUndefined();
});
it.each([false, true])("warns only for pending work, with frames batched: %s", async (batched) => {
  const { service, tick, analyze, warn } = await makeService({});
  await analyze();
  expect(warn).not.toHaveBeenCalled();
  await tick();
  if (batched) {
    const store = (service as unknown as { store: LogbookStore }).store;
    const { id, capturedAtMs } = expectDefined((await store.unbatchedActiveFrames(1))[0], "frame");
    await store.createBatch(
      batchInput([id], capturedAtMs, capturedAtMs + 1000, dayKeyFor(capturedAtMs)),
    );
  }
  await analyze();
  await analyze();
  expect(warn).toHaveBeenCalledExactlyOnceWith(missingModelWarning);
});

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
