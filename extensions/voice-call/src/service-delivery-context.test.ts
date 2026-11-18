import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
  createTestPluginServiceScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import { expect, it, vi } from "vitest";
import { scheduleServiceDelivery } from "./service-delivery-context.js";

it("dispatches delivery through the service scheduler and propagates its result", async () => {
  const clock = createGatewaySchedulerClock();
  const scheduler = createTestPluginServiceScheduler(createTestGatewayScheduler(clock.clock));
  const run = vi.fn(async () => "summary");
  const pending = scheduleServiceDelivery(scheduler, run);
  expect(run).not.toHaveBeenCalled();
  await clock.advanceBy(1);
  await expect(pending).resolves.toBe("summary");
  await scheduler.stop();
});

it("rejects queued delivery when its service closes, without running it", async () => {
  const clock = createGatewaySchedulerClock();
  const scheduler = createTestPluginServiceScheduler(createTestGatewayScheduler(clock.clock));
  const run = vi.fn();
  const pending = scheduleServiceDelivery(scheduler, run);
  const rejection = expect(pending).rejects.toBeDefined();
  await scheduler.stop();
  await rejection;
  await clock.advanceBy(1);
  expect(run).not.toHaveBeenCalled();
  await expect(scheduleServiceDelivery(scheduler, run)).rejects.toBeDefined();
});
