import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { expect, it, vi } from "vitest";
import { buildAskPrompt } from "./prompts.js";
import { LogbookStore } from "./store.js";
import * as fixtures from "./test-fixtures.test-support.js";

const fixture = fixtures.useLogbookFixture("logbook-observation-reads-");
const day = fixtures.DAY;

it("asks with the latest 200 observations in chronological order", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-03T12:00:00"));
  const dataDir = fixture.makeDir();
  const store = await fixture.open(dataDir);
  const end = Number.MAX_SAFE_INTEGER;
  const segments = Array.from({ length: 201 }, (_, index) => ({
    startMs: 1 + Math.floor(index / 3) * 1000,
    endMs: 1001 + Math.floor(index / 3) * 1000,
    text: `Observation ${index} 🦞`,
  }));
  const seedBatch = async (batchDay: string) => {
    const frameId = await store.captureFrame({
      capturedAtMs: Date.now(),
      day: batchDay,
      screenIndex: 0,
      buffer: Buffer.from(batchDay),
    });
    return await store.createBatch(fixtures.batchInput([frameId], 1, end, batchDay));
  };
  const batchId = await seedBatch(day);
  await store.replaceObservations(batchId, day, [
    ...segments,
    { startMs: -10, endMs: 0, text: "Excluded end boundary" },
    { startMs: end, endMs: end, text: "Excluded start boundary" },
  ]);
  await store.replaceObservations(await seedBatch("2026-07-04"), "2026-07-04", [
    { startMs: 1, endMs: 2, text: "Excluded day" },
  ]);
  await store.close();
  const runtime = createPluginRuntimeMock();
  const complete = vi.spyOn(runtime.llm, "complete").mockResolvedValue({
    text: "Synthetic answer",
    provider: "synthetic",
    model: "synthetic",
    agentId: "main",
    usage: {},
    execution: { mode: "direct-provider", owner: { kind: "provider", id: "synthetic" } },
    audit: { caller: { kind: "plugin", id: "logbook" } },
  });
  const service = await fixture.startService(
    { captureEnabled: false },
    {
      dataDir,
      runtime,
      fullConfig: {},
      logger: fixtures.quietLogger,
    },
  );
  const observations = vi.spyOn(LogbookStore.prototype, "observationsInRange");
  expect(await service.ask(day, "What happened?")).toBe("Synthetic answer");
  expect(complete).toHaveBeenCalledTimes(1);
  expect(complete.mock.calls[0]?.[0].messages).toEqual([
    {
      role: "user",
      content: buildAskPrompt({
        day,
        cards: [],
        observations: segments
          .map((segment, index) => Object.assign({ id: index + 1, batchId, day }, segment))
          .slice(-200),
        question: "What happened?",
      }),
    },
  ]);
  expect(observations).toHaveBeenCalledExactlyOnceWith(day, 0, end, 200);
});
