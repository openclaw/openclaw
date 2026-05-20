import { describe, expect, it, vi } from "vitest";
import { bridgeImMessage } from "./im-bridge.js";
import type { ClaworksRuntime } from "./runtime-types.js";

function mockRuntime(overrides?: {
  ingressAction?: string;
  rbacAllowed?: boolean;
}): ClaworksRuntime {
  const publish = vi.fn().mockResolvedValue([]);
  const trigger = vi.fn().mockResolvedValue({ id: "run-1", status: "completed" });
  return {
    ingress: {
      decide: () => ({
        action: overrides?.ingressAction ?? "intent_route",
        hint: "classify_im_to_business_event",
      }),
    },
    rbac: {
      check: () =>
        overrides?.rbacAllowed === false
          ? { allowed: false, reason: "denied by test" }
          : { allowed: true },
    },
    playbookEngine: {
      list: () => [{ id: "classify_im_to_business_event" }],
      trigger,
    },
    kernel: { publish },
  } as unknown as ClaworksRuntime;
}

describe("bridgeImMessage", () => {
  it("denies when RBAC check fails", async () => {
    const runtime = mockRuntime({ rbacAllowed: false });
    const result = await bridgeImMessage(runtime, {
      channel: "feishu",
      messageId: "m1",
      userId: "u1",
      text: "hello",
    });
    expect(result.action).toBe("denied");
    expect(runtime.kernel.publish).toHaveBeenCalledWith(
      "rbac.denied",
      "im-bridge",
      expect.objectContaining({ action: "playbook.trigger" }),
    );
  });

  it("intent_routes to classify playbook when allowed", async () => {
    const runtime = mockRuntime({ rbacAllowed: true, ingressAction: "intent_route" });
    const result = await bridgeImMessage(runtime, {
      channel: "feishu",
      messageId: "m2",
      userId: "u2",
      text: "alarm on pump-001",
    });
    expect(result.action).toBe("intent_routed");
    expect(runtime.kernel.publish).not.toHaveBeenCalled();
    expect(runtime.playbookEngine.trigger).toHaveBeenCalled();
  });

  it("publishes to kernel when ingress is kernel", async () => {
    const runtime = mockRuntime({ rbacAllowed: true, ingressAction: "kernel" });
    const result = await bridgeImMessage(runtime, {
      channel: "feishu",
      messageId: "m3",
      userId: "u3",
      text: "direct",
    });
    expect(result.action).toBe("published");
    expect(runtime.kernel.publish).toHaveBeenCalled();
  });
});
