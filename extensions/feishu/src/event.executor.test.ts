import { describe, expect, it, vi } from "vitest";
import {
  buildFeishuEventIngressOpts,
  createFeishuEventSubscriptionExecutionHandler,
  executeFeishuEventTriggerPlan,
} from "./event.executor.js";
import { normalizeFeishuEvent } from "./event.model.js";
import { resolveFeishuEventTriggerPlan } from "./event.trigger.js";

function createBitablePlan() {
  const event = normalizeFeishuEvent({
    accountId: "acct-1",
    eventType: "drive.file.bitable_record_changed_v1",
    payload: {
      event_id: "evt_1",
      app_token: "bascn_123",
      table_id: "tbl_123",
      record: {
        record_id: "rec_123",
      },
    },
  });
  return resolveFeishuEventTriggerPlan({
    event,
    trigger: {
      mode: "isolated",
      agentId: "ops",
      command: "/feishu-sync",
    },
  });
}

describe("event.executor", () => {
  it("maps trigger plans to ingress agent options", () => {
    const ingress = buildFeishuEventIngressOpts(createBitablePlan());

    expect(ingress).toMatchObject({
      agentId: "ops",
      accountId: "acct-1",
      channel: "feishu",
      senderIsOwner: false,
      allowModelOverride: false,
      bootstrapContextMode: "lightweight",
      bootstrapContextRunKind: "cron",
      sessionKey: "agent:ops:cron:feishu-event:acct-1:bitable.record:rec_123",
    });
    expect(ingress.message).toContain("/feishu-sync drive.file.bitable_record_changed_v1");
  });

  it("executes plans via the injected ingress runner", async () => {
    const execute = vi.fn(async () => ({ runId: "run-1" }));

    const result = await executeFeishuEventTriggerPlan({
      plan: createBitablePlan(),
      execute,
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(result.result).toEqual({ runId: "run-1" });
    expect(result.ingress.agentId).toBe("ops");
  });

  it("creates a subscription match handler that skips missing trigger plans", async () => {
    const execute = vi.fn(async () => ({ runId: "run-2" }));
    const onExecuted = vi.fn(async () => {});
    const handleMatch = createFeishuEventSubscriptionExecutionHandler({
      execute,
      onExecuted,
    });

    expect(
      await handleMatch({
        subscriptionId: "no-trigger",
        delivery: {
          topic: "feishu.drive.file.bitable_record_changed_v1",
          event: createBitablePlan().event,
          publishedAt: Date.now(),
        },
      }),
    ).toBeNull();

    const executed = await handleMatch({
      subscriptionId: "with-trigger",
      delivery: {
        topic: "feishu.drive.file.bitable_record_changed_v1",
        event: createBitablePlan().event,
        publishedAt: Date.now(),
      },
      triggerPlan: createBitablePlan(),
    });

    expect(executed?.result).toEqual({ runId: "run-2" });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(onExecuted).toHaveBeenCalledTimes(1);
  });
});
