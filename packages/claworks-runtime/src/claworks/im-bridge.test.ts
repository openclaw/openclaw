import { describe, expect, it, vi } from "vitest";
import { bridgeImMessage, normalizeImBridgeInput } from "./im-bridge.js";
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
  it("normalizes legacy snake_case IM payload", () => {
    const normalized = normalizeImBridgeInput({
      channel_id: "feishu",
      user_id: "sales-001",
      message: "quote please",
      tenant_id: "acme",
    } as never);
    expect(normalized.channel).toBe("feishu");
    expect(normalized.userId).toBe("sales-001");
    expect(normalized.text).toBe("quote please");
    expect(normalized.extra).toEqual({ tenant_id: "acme" });
  });

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

  it("payload includes normalized fields text/user_id/channel/timestamp", async () => {
    const runtime = mockRuntime({ rbacAllowed: true, ingressAction: "kernel" });
    await bridgeImMessage(runtime, {
      channel: "feishu",
      messageId: "m4",
      userId: "u4",
      text: "查一下知识库",
      groupId: "g1",
    });
    const [, , payload] = (runtime.kernel.publish as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
    ];
    expect(payload.text).toBe("查一下知识库");
    expect(payload.user_id).toBe("u4");
    expect(payload.channel).toBe("feishu");
    expect(payload.group_id).toBe("g1");
    expect(payload.session_id).toBe("feishu:group:g1");
    expect(typeof payload.timestamp).toBe("string");
    // raw fields still present
    expect(payload._im_message).toBe("查一下知识库");
    expect(payload._im_user_id).toBe("u4");
  });

  it("passes session_id to intent_route playbook trigger payload", async () => {
    const runtime = mockRuntime({ rbacAllowed: true, ingressAction: "intent_route" });
    await bridgeImMessage(runtime, {
      channel: "feishu",
      messageId: "m5",
      userId: "u5",
      text: "help me",
    });
    const [, triggerPayload] = (runtime.playbookEngine.trigger as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, Record<string, unknown>];
    expect(triggerPayload.session_id).toBe("feishu:user:u5");
  });
});
