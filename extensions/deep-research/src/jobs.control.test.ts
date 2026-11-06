import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
  createTestPluginServiceScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, expect, it, vi } from "vitest";
import { createResearchJobsFixture, handle } from "./jobs.test-support.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
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
