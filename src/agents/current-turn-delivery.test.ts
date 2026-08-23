import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mintMessageActionTurnCapability,
  revokeMessageActionTurnCapability,
} from "../gateway/message-action-turn-capability.js";
import type { MessageActionResult } from "../infra/outbound/message-action-contracts.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import {
  createCurrentTurnDelivery,
  createCurrentTurnDeliveryTool,
  projectCurrentTurnDeliveryResult,
  type CurrentTurnDelivery,
} from "./current-turn-delivery.js";
import { isAgentToolReplaySafe, isAgentToolRestartSafe } from "./tool-replay-safety.js";

const route = { channel: "telegram", to: "chat-1", accountId: "account-1", threadId: 7 };
type CurrentTurnDeliveryResult = Awaited<ReturnType<CurrentTurnDelivery["send"]>>;

function action(
  deliveryStatus: "sent" | "suppressed" | "partial_failed" | "failed",
  extra: Record<string, unknown> = {},
): MessageActionResult {
  return {
    kind: "send",
    channel: "telegram",
    action: "send",
    to: "untrusted-result-target",
    handledBy: "core",
    payload: {},
    sendResult: {
      channel: "telegram",
      to: "untrusted-result-target",
      via: "direct",
      mediaUrl: null,
      deliveryStatus,
      ...extra,
    },
    dryRun: false,
  } as MessageActionResult;
}

function delivery(send: CurrentTurnDelivery["send"]): CurrentTurnDelivery {
  return { route, send };
}

describe("current-turn delivery", () => {
  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

  it("withholds incomplete current-turn authority", () => {
    expect(
      createCurrentTurnDelivery({
        deliveryContext: { channel: "telegram", to: "chat-1" },
        runtimeConfig: {},
        getRuntimeConfig: () => ({}),
      }),
    ).toBeUndefined();
  });

  it("normalizes raw delivery context before binding authority", () => {
    setActivePluginRegistry(createEmptyPluginRegistry());
    const capability = mintMessageActionTurnCapability({
      agentId: "main",
      runId: "run-1",
      sessionKey: "agent:main:main",
    });
    try {
      const current = createCurrentTurnDelivery({
        deliveryContext: {
          channel: " TELEGRAM ",
          to: " chat-1 ",
          accountId: " work ",
          threadId: " 7 ",
        },
        agentId: "main",
        runId: "run-1",
        sessionKey: "agent:main:main",
        messageActionTurnCapability: capability,
        runtimeConfig: {},
        getRuntimeConfig: () => ({}),
      });

      expect(current?.route).toEqual({
        channel: "telegram",
        to: "chat-1",
        accountId: "work",
        threadId: "7",
      });
    } finally {
      revokeMessageActionTurnCapability(capability);
    }
  });

  it("projects canonical closed delivery facts for every send status", () => {
    const results = [
      projectCurrentTurnDeliveryResult(
        action("sent", { result: { messageId: "message-1" } }),
        route,
      ),
      projectCurrentTurnDeliveryResult(
        action("suppressed", { suppressionReason: "hook_suppressed" }),
        route,
      ),
      projectCurrentTurnDeliveryResult(
        action("partial_failed", { error: "second payload failed", sentBeforeError: true }),
        route,
      ),
      projectCurrentTurnDeliveryResult(action("failed", { error: "send failed" }), route),
    ];

    expect(results).toEqual([
      { status: "sent", channel: "telegram", to: "chat-1", messageId: "message-1" },
      {
        status: "suppressed",
        channel: "telegram",
        to: "chat-1",
        suppressionReason: "hook_suppressed",
      },
      {
        status: "partial_failed",
        channel: "telegram",
        to: "chat-1",
        error: "second payload failed",
        sentBeforeError: true,
      },
      { status: "failed", channel: "telegram", to: "chat-1", error: "send failed" },
    ]);

    const tool = createCurrentTurnDeliveryTool(delivery(async () => results[0]!));
    for (const result of results) {
      expect(Value.Check(tool.outputSchema!, result)).toBe(true);
    }
    expect(Value.Check(tool.outputSchema!, { ...results[0], raw: true })).toBe(false);
    expect(Value.Check(tool.parameters, { text: "hello", route })).toBe(false);
    expect(isAgentToolReplaySafe(tool)).toBe(false);
    expect(isAgentToolRestartSafe(tool)).toBe(false);
  });

  it("validates malformed input before consuming authority", async () => {
    const send = vi.fn(
      async () =>
        ({
          status: "sent",
          channel: route.channel,
          to: route.to,
        }) satisfies CurrentTurnDeliveryResult,
    );
    const tool = createCurrentTurnDeliveryTool(delivery(send));

    await expect(tool.execute("bad", { text: "   " })).rejects.toThrow("text required");
    await expect(tool.execute("good", { text: "hello" })).resolves.toMatchObject({
      details: { status: "sent" },
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("consumes authority synchronously before the first await", async () => {
    let release!: (result: CurrentTurnDeliveryResult) => void;
    const pending = new Promise<CurrentTurnDeliveryResult>((resolve) => {
      release = resolve;
    });
    const tool = createCurrentTurnDeliveryTool(delivery(async () => pending));

    const first = tool.execute("first", { text: "hello" });
    await expect(tool.execute("second", { text: "again" })).rejects.toThrow(
      "already been consumed",
    );
    release({ status: "sent", channel: route.channel, to: route.to });
    await expect(first).resolves.toMatchObject({ details: { status: "sent" } });
  });

  it.each([
    {
      name: "suppression",
      send: async () =>
        ({
          status: "suppressed",
          channel: route.channel,
          to: route.to,
          suppressionReason: "hook_suppressed",
        }) satisfies CurrentTurnDeliveryResult,
      status: "suppressed",
    },
    {
      name: "failure",
      send: async () => {
        throw new Error("send failed");
      },
      status: "failed",
    },
    {
      name: "revocation after send",
      send: async () => {
        throw Object.assign(new Error("capability revoked"), { sentBeforeError: true });
      },
      status: "partial_failed",
    },
  ])("consumes authority after $name", async ({ send, status }) => {
    const tool = createCurrentTurnDeliveryTool(delivery(send));
    await expect(tool.execute("first", { text: "hello" })).resolves.toMatchObject({
      details: { status },
    });
    await expect(tool.execute("second", { text: "again" })).rejects.toThrow(
      "already been consumed",
    );
  });
});
