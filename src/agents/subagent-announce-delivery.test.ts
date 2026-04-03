import { describe, expect, it } from "vitest";
import {
  resolveAnnounceOrigin,
  deliverSubagentAnnouncement,
  __testing,
} from "./subagent-announce-delivery.js";

describe("resolveAnnounceOrigin telegram forum topics", () => {
  it("preserves stored forum topic thread ids when requester origin omits one for the same chat", () => {
    expect(
      resolveAnnounceOrigin(
        {
          lastChannel: "telegram",
          lastTo: "telegram:-1001234567890:topic:99",
          lastThreadId: 99,
        },
        {
          channel: "telegram",
          to: "telegram:-1001234567890",
        },
      ),
    ).toEqual({
      channel: "telegram",
      to: "telegram:-1001234567890",
      threadId: 99,
    });
  });

  it("preserves stored forum topic thread ids for legacy group-prefixed requester targets", () => {
    expect(
      resolveAnnounceOrigin(
        {
          lastChannel: "telegram",
          lastTo: "telegram:-1001234567890:topic:99",
          lastThreadId: 99,
        },
        {
          channel: "telegram",
          to: "group:-1001234567890",
        },
      ),
    ).toEqual({
      channel: "telegram",
      to: "group:-1001234567890",
      threadId: 99,
    });
  });

  it("still strips stale thread ids when the stored telegram route points at a different chat", () => {
    expect(
      resolveAnnounceOrigin(
        {
          lastChannel: "telegram",
          lastTo: "telegram:-1009999999999:topic:99",
          lastThreadId: 99,
        },
        {
          channel: "telegram",
          to: "telegram:-1001234567890",
        },
      ),
    ).toEqual({
      channel: "telegram",
      to: "telegram:-1001234567890",
    });
  });

  it("strips stale thread ids for direct telegram requester targets", () => {
    expect(
      resolveAnnounceOrigin(
        {
          lastChannel: "telegram",
          lastTo: "telegram:-1001234567890:topic:99",
          lastThreadId: 99,
        },
        {
          channel: "telegram",
          to: "telegram:123456789",
        },
      ),
    ).toEqual({
      channel: "telegram",
      to: "telegram:123456789",
    });
  });
});

describe("queued announce delivery execution boundary", () => {
  it("sends queued announce items from execution.agentPrompt, not display text", async () => {
    const calls: Array<{ method?: string; params?: { message?: string } }> = [];
    __testing.setDepsForTest({
      loadConfig: () => ({ agents: { subagentAnnounceTimeoutMs: 1000 } }) as never,
      callGateway: async (req) => {
        calls.push(req as { method?: string; params?: { message?: string } });
        return { ok: true } as never;
      },
    });

    try {
      await __testing.sendAnnounceForTest({
        announceId: "ann-1",
        execution: { visibility: "internal", agentPrompt: "internal trigger payload" },
        display: { visibility: "user-visible", text: "safe display payload" },
        enqueuedAt: 1,
        sessionKey: "agent:main:main",
        origin: { channel: "telegram", to: "telegram:123" },
      });

      expect(calls).toHaveLength(1);
      expect(calls[0]?.params?.message).toBe("internal trigger payload");
      expect(calls[0]?.params?.message).not.toBe("safe display payload");
    } finally {
      __testing.setDepsForTest();
    }
  });

  it("keeps triggerMessage out of queued user-visible display when no summaryLine is provided", () => {
    expect(
      __testing.buildQueuedAnnounceDisplayForTest({
        triggerMessage: "internal trigger payload",
      }),
    ).toEqual({ visibility: "summary-only" });
  });

  it("rejects non-user-visible queued announce display payloads at outbound boundary", async () => {
    __testing.setDepsForTest({
      loadConfig: () => ({ agents: { subagentAnnounceTimeoutMs: 1000 } }) as never,
      callGateway: async () => ({ ok: true }) as never,
    });

    try {
      await expect(
        __testing.sendAnnounceForTest({
          announceId: "ann-2",
          execution: { visibility: "internal", agentPrompt: "internal trigger payload" },
          display: { visibility: "summary-only" },
          enqueuedAt: 1,
          sessionKey: "agent:main:main",
          origin: { channel: "telegram", to: "telegram:123" },
        }),
      ).rejects.toThrow(/user-visible deferred display payload|summary-only payload requires summaryLine/);
    } finally {
      __testing.setDepsForTest();
    }
  });
});

describe("direct announce outbound visibility guard", () => {
  it("uses explicit summaryLine for external direct announce delivery", async () => {
    const calls: Array<{ params?: { message?: string; deliver?: boolean } }> = [];
    __testing.setDepsForTest({
      loadConfig: () => ({ agents: { subagentAnnounceTimeoutMs: 1000 } }) as never,
      callGateway: async (req) => {
        calls.push(req as { params?: { message?: string; deliver?: boolean } });
        return { ok: true } as never;
      },
    });

    try {
      const result = await deliverSubagentAnnouncement({
        requesterSessionKey: "agent:main:main",
        targetRequesterSessionKey: "agent:main:main",
        announceId: "ann-direct-1",
        triggerMessage: "internal trigger payload",
        steerMessage: "internal steer payload",
        summaryLine: "safe direct summary",
        requesterSessionOrigin: { channel: "telegram", to: "telegram:123" },
        directOrigin: { channel: "telegram", to: "telegram:123" },
        requesterIsSubagent: false,
        expectsCompletionMessage: false,
        directIdempotencyKey: "direct-1",
      });

      expect(result.delivered).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.params?.deliver).toBe(true);
      expect(calls[0]?.params?.message).toBe("safe direct summary");
    } finally {
      __testing.setDepsForTest();
    }
  });

  it("rejects external direct announce delivery when no explicit user-visible summary is provided", async () => {
    __testing.setDepsForTest({
      loadConfig: () => ({ agents: { subagentAnnounceTimeoutMs: 1000 } }) as never,
      callGateway: async () => ({ ok: true }) as never,
    });

    try {
      const result = await deliverSubagentAnnouncement({
        requesterSessionKey: "agent:main:main",
        targetRequesterSessionKey: "agent:main:main",
        announceId: "ann-direct-2",
        triggerMessage: "internal trigger payload",
        steerMessage: "internal steer payload",
        requesterSessionOrigin: { channel: "telegram", to: "telegram:123" },
        directOrigin: { channel: "telegram", to: "telegram:123" },
        requesterIsSubagent: false,
        expectsCompletionMessage: false,
        directIdempotencyKey: "direct-2",
      });

      expect(result.delivered).toBe(false);
      expect(result.path).toBe("direct");
      expect(result.error).toMatch(/user-visible deferred display payload|Missing user-visible deferred display payload/);
    } finally {
      __testing.setDepsForTest();
    }
  });
});
