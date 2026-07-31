import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  deliverSubagentAnnouncement,
  loadRequesterSessionEntry,
  testing,
} from "./subagent-announce-delivery.test-support.js";

afterEach(() => {
  testing.setDepsForTest();
});

describe("subagent requester session ownership", () => {
  it("loads an unscoped requester key through its supplied owner", () => {
    const loadSessionEntry = vi.fn(() => ({
      sessionId: "requester-session",
      updatedAt: 1,
    }));
    const cfg = {
      agents: {
        ownership: "explicit",
        entries: { main: {}, work: {} },
      },
      session: { store: "/tmp/shared-sessions.json" },
    } satisfies OpenClawConfig;
    testing.setDepsForTest({
      getRuntimeConfig: () => cfg,
      loadSessionEntry: loadSessionEntry as never,
    });

    expect(loadRequesterSessionEntry("global", "work")).toMatchObject({
      canonicalKey: "global",
      entry: { sessionId: "requester-session" },
    });
    expect(loadSessionEntry).toHaveBeenCalledWith({
      storePath: "/tmp/shared-sessions.json",
      sessionKey: "global",
      agentId: "work",
      clone: false,
    });
  });

  it("loads a scoped requester key without requiring a separate owner", () => {
    const loadSessionEntry = vi.fn(() => ({
      sessionId: "requester-session",
      updatedAt: 1,
    }));
    const cfg = {
      agents: {
        ownership: "explicit",
        entries: { ops: {}, research: {} },
      },
      session: { store: "/tmp/shared-sessions.json" },
    } satisfies OpenClawConfig;
    testing.setDepsForTest({
      getRuntimeConfig: () => cfg,
      loadSessionEntry: loadSessionEntry as never,
    });

    expect(loadRequesterSessionEntry("agent:ops:main")).toMatchObject({
      canonicalKey: "agent:ops:main",
      entry: { sessionId: "requester-session" },
    });
    expect(loadSessionEntry).toHaveBeenCalledWith({
      storePath: "/tmp/shared-sessions.json",
      sessionKey: "agent:ops:main",
      agentId: "ops",
      clone: false,
    });
  });

  it("delivers to a scoped requester key without a separate owner", async () => {
    const queueEmbeddedAgentMessageWithOutcome = vi.fn(async () => ({
      queued: true as const,
      sessionId: "requester-session",
      target: "embedded_run" as const,
      gatewayHealth: "live" as const,
      enqueuedAtMs: 1,
      deliveredAtMs: 2,
    }));
    const cfg = {
      agents: {
        ownership: "explicit",
        entries: { ops: {}, research: {} },
      },
      session: { store: "/tmp/shared-sessions.json" },
    } satisfies OpenClawConfig;
    testing.setDepsForTest({
      getRuntimeConfig: () => cfg,
      getRequesterSessionActivity: () => ({
        sessionId: "requester-session",
        isActive: true,
      }),
      loadSessionEntry: (() => ({ sessionId: "requester-session", updatedAt: 1 })) as never,
      queueEmbeddedAgentMessageWithOutcome,
    });

    await expect(
      deliverSubagentAnnouncement({
        requesterSessionKey: "agent:ops:main",
        targetRequesterSessionKey: "agent:ops:main",
        triggerMessage: "child done",
        steerMessage: "child done",
        requesterIsSubagent: true,
        expectsCompletionMessage: false,
        directIdempotencyKey: "announce-scoped-requester",
      }),
    ).resolves.toMatchObject({ delivered: true, path: "steered" });
    expect(queueEmbeddedAgentMessageWithOutcome).toHaveBeenCalledWith(
      "requester-session",
      "child done",
      expect.objectContaining({ steeringMode: "all" }),
    );
  });
});
