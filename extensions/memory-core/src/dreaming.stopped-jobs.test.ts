import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupDreamingServicesForTest,
  createDreamingTestContext,
  registerShortTermPromotionDreamingForTest,
  triggerDreamingServiceStart,
} from "./dreaming.test-support.js";

const constants = { RUNTIME_CRON_RECONCILE_INTERVAL_MS: 60_000 };

afterEach(cleanupDreamingServicesForTest);

describe("dreaming service reconciliation", () => {
  it("keeps stopped managed dreaming jobs stopped while repairing their schedule", async () => {
    vi.useFakeTimers();
    const { api, harness } = createDreamingTestContext();
    registerShortTermPromotionDreamingForTest(api);
    await triggerDreamingServiceStart(api, { config: api.config, getCron: () => harness.cron });
    const created = expectDefined(harness.jobs[0], "created dreaming job");
    expect(created.enabled).toBe(true);
    created.enabled = false;
    const failureState = {
      consecutiveErrors: 10,
      autoDisabled: { reason: "consecutive-failures", atMs: 1, consecutiveErrors: 10 },
      lastErrorReason: "timeout",
    };
    Object.assign(created, { state: failureState });

    await vi.advanceTimersByTimeAsync(constants.RUNTIME_CRON_RECONCILE_INTERVAL_MS);

    const autoDisabled = expectDefined(harness.jobs[0], "auto-disabled dreaming job");
    expect(autoDisabled.enabled).toBe(false);
    expect(autoDisabled).toMatchObject({ state: failureState });
    expect(harness.updateCalls).toEqual([]);

    autoDisabled.schedule = { kind: "cron", expr: "0 3 * * *", tz: "UTC" };
    Object.assign(autoDisabled, { state: { consecutiveErrors: 2 } });
    await vi.advanceTimersByTimeAsync(constants.RUNTIME_CRON_RECONCILE_INTERVAL_MS);

    const paused = expectDefined(harness.jobs[0], "paused dreaming job");
    expect(paused.enabled).toBe(false);
    expect(paused.schedule).toEqual({ kind: "cron", expr: "15 4 * * *", tz: "UTC" });
    expect(paused).toMatchObject({ state: { consecutiveErrors: 2 } });
    expect(harness.updateCalls).toEqual([
      {
        id: paused.id,
        patch: { schedule: { kind: "cron", expr: "15 4 * * *", tz: "UTC" } },
      },
    ]);
  });
});
