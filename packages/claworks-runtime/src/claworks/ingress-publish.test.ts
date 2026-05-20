import { describe, expect, it, vi } from "vitest";
import { applyIngressPublish } from "./ingress-publish.js";
import type { ClaworksRuntime } from "./runtime-types.js";

function mockRuntime(overrides?: {
  ingressAction?: string;
  hint?: string;
  hasPlaybook?: boolean;
}): ClaworksRuntime {
  const publish = vi.fn().mockResolvedValue([{ playbookId: "pb1" }]);
  const trigger = vi.fn().mockResolvedValue({ id: "run-1", status: "completed" });
  return {
    ingress: {
      decide: () => ({
        action: overrides?.ingressAction ?? "kernel",
        ...(overrides?.hint ? { hint: overrides.hint } : {}),
      }),
    },
    playbookEngine: {
      list: () =>
        overrides?.hasPlaybook === false
          ? []
          : [{ id: overrides?.hint ?? "classify_im_to_business_event" }],
      trigger,
    },
    kernel: { publish },
    logger: vi.fn(),
  } as unknown as ClaworksRuntime;
}

describe("applyIngressPublish", () => {
  it("intent_route triggers classify playbook without kernel.publish", async () => {
    const runtime = mockRuntime({ ingressAction: "intent_route" });
    const result = await applyIngressPublish(runtime, {
      source: "im",
      eventType: "im.message.received",
      subjectId: "feishu:u1",
      payload: { _im_message: "hello" },
    });
    expect(result.action).toBe("intent_routed");
    if (result.action === "intent_routed") {
      expect(result.playbookId).toBe("classify_im_to_business_event");
      expect(result.runId).toBe("run-1");
    }
    expect(runtime.kernel.publish).not.toHaveBeenCalled();
    expect(runtime.playbookEngine.trigger).toHaveBeenCalledWith(
      "classify_im_to_business_event",
      expect.objectContaining({ _ingress_decision: "intent_route" }),
    );
  });

  it("kernel action publishes to event bus", async () => {
    const runtime = mockRuntime({ ingressAction: "kernel" });
    const result = await applyIngressPublish(runtime, {
      source: "connector",
      eventType: "alarm.created",
      subjectId: "opc-1",
      payload: { id: "a1" },
    });
    expect(result.action).toBe("published");
    expect(runtime.kernel.publish).toHaveBeenCalled();
  });
});
