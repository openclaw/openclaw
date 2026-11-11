import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
  createTestPluginServiceScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, expect, it, vi } from "vitest";
import { ResearchState } from "./job-state.js";
import { ResearchJobs } from "./jobs.js";
import { createResearchJobsFixture, completed, descriptor, handle } from "./jobs.test-support.js";
import { requestResearchWake } from "./view-state.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) {
    await close();
  }
});

it("recovers an explicitly renewed deferred job after interruption at its durable commit", async () => {
  const clock = createGatewaySchedulerClock(100);
  let scheduler = createTestPluginServiceScheduler(createTestGatewayScheduler(clock.clock));
  const target = {
    agentId: "main",
    sessionKey: "agent:main:research-fixture",
    sessionId: "generation-1",
  };
  const { jobs, api, runtime, context, sessionWork } = await createResearchJobsFixture(
    {
      scheduler,
      sessionWork: {
        version: 1,
        admit: async () => ({ recoverable: true, target }),
        run: async (_id, work) => ({
          status: "completed",
          value: await work({
            target,
            signal: scheduler.signal,
            assertCurrent: () => scheduler.signal.throwIfAborted(),
          }),
        }),
      },
    },
    (close) => cleanup.push(close),
  );
  const request = vi
    .mocked(runtime.gateway.request)
    .mockResolvedValueOnce(descriptor)
    .mockResolvedValueOnce({
      version: 1,
      ok: true,
      value: { state: "running", handle, citations: [] },
    })
    .mockResolvedValueOnce({
      version: 1,
      ok: false,
      state: "blocked",
      reason: "Account unavailable",
    })
    .mockResolvedValue(completed);
  const deferred = await jobs.start(
    { question: "Interrupted renewal", engine: "google" },
    "interrupted-renewal",
    context,
  );
  const state = new ResearchState(api, scheduler);
  expect(deferred).toMatchObject({ recovery: "deferred", handle });
  expect(await state.wakes().count()).toBe(0);
  const store = state.open<unknown>("jobs", context);
  const compare = store.compareAndApply;
  vi.spyOn(store, "compareAndApply").mockImplementation(async (...args) => {
    await compare(...args);
    throw new Error("Interrupted after durable renewal");
  });
  vi.spyOn(state, "open").mockReturnValue(store);
  await expect(requestResearchWake(state, deferred.id, context, 100, false)).rejects.toThrow(
    "Interrupted after durable renewal",
  );
  expect(await store.lookup(deferred.id)).toMatchObject({ recovery: "ready", handle });
  await scheduler.stop();
  scheduler = createTestPluginServiceScheduler(createTestGatewayScheduler(clock.clock));
  cleanup.push(() => scheduler.stop());
  const restarted = new ResearchJobs(api, scheduler, sessionWork);
  await restarted.startRecovery();
  await clock.advanceBy(1000);
  expect(await restarted.read(deferred.id, context)).toMatchObject({ state: "completed", handle });
  expect(request.mock.calls.map(([, params]) => params?.request)).toEqual([
    { version: 1, action: "describe" },
    { version: 1, action: "start", question: "Interrupted renewal" },
    { version: 1, action: "poll", handle },
    { version: 1, action: "poll", handle },
  ]);
});

it.each(["resume", "cancel"] as const)(
  "expedites an explicit %s without resubmitting a retained provider handle",
  async (action) => {
    const clock = createGatewaySchedulerClock(100);
    const scheduler = createTestPluginServiceScheduler(createTestGatewayScheduler(clock.clock));
    const { jobs, context, readStore, runtime } = await createResearchJobsFixture(
      {
        scheduler,
        sessionWork: {
          version: 1,
          admit: async () => ({
            recoverable: true,
            target: {
              agentId: "main",
              sessionKey: "agent:main:research-fixture",
              sessionId: "generation-1",
            },
          }),
          run: vi.fn(async () => ({
            status: "unavailable" as const,
            reason: "fixture not dispatched",
          })),
        },
      },
      (close) => cleanup.push(close),
    );
    const accepted = await jobs.start(
      { question: "Retained provider job", engine: "google" },
      action,
      context,
      undefined,
      undefined,
      true,
    );
    await readStore().register(accepted.id, {
      ...(await jobs.read(accepted.id, context)),
      state: "paused",
      recovery: "deferred",
      wakeFailures: 5,
      nextWakeAt: 3_600_000,
      handle,
    });
    const paused = await jobs.read(accepted.id, context);
    const updated =
      action === "resume"
        ? await jobs.requestResume(paused, context)
        : await jobs.cancel(paused, context, undefined, true);
    expect(updated).toMatchObject({
      state: "paused",
      recovery: "ready",
      wakeFailures: 0,
      nextWakeAt: 100,
      handle,
    });
    expect(await readStore().lookup(accepted.id)).toMatchObject({
      recovery: "ready",
      nextWakeAt: 100,
      handle,
    });
    const wakes = runtime.state.openKeyedStoreV2<{ nextWakeAt: number }>({
      namespace: "research-wakes-v1",
      maxEntries: 4096,
      overflowPolicy: "reject-new",
    });
    expect(await wakes.lookup(accepted.id)).toMatchObject({ nextWakeAt: 100 });
    expect(runtime.gateway.request).not.toHaveBeenCalled();
    expect((await jobs.read(accepted.id, context)).cancelRequested ?? false).toBe(
      action === "cancel",
    );
  },
);
