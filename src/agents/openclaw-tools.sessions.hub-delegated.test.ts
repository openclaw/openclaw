// Hub-delegated sessions_send tool boundaries.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  HUB_OWNER_A,
  delegateSessionKey,
  hubDelegatedEntry,
} from "../../test/helpers/hub-delegated-fixtures.js";
import type { OpenClawConfig } from "../config/config.js";
import "./test-helpers/fast-openclaw-tools-sessions.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { testing as agentStepTesting } from "./tools/agent-step.js";
import { testing as sessionsResolutionTesting } from "./tools/sessions-resolution.js";
import { testing as sessionsSendA2ATesting } from "./tools/sessions-send-tool.a2a.js";
import { createSessionsSendTool } from "./tools/sessions-send-tool.js";

const callGatewayMock = vi.fn();
vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));
const loadSessionEntryByKeyMock = vi.fn();
vi.mock("./subagent-announce-delivery.js", () => ({
  loadSessionEntryByKey: (sessionKey: string) => loadSessionEntryByKeyMock(sessionKey),
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => ({
    session: { mainKey: "main", scope: "per-sender", agentToAgent: { maxPingPongTurns: 2 } },
    tools: { sessions: { visibility: "all" }, agentToAgent: { enabled: true } },
  }),
  resolveGatewayPort: () => 18789,
}));

type SessionsSendDetails = {
  status?: string;
  reply?: string;
  error?: string;
  delivery?: { status?: string };
};

function sessionsSendDetails(details: unknown): SessionsSendDetails {
  return details as SessionsSendDetails;
}

function installSendTool(requesterKey: string, agentChannel = "webchat") {
  setActivePluginRegistry(createTestRegistry([]));
  return createSessionsSendTool({
    agentSessionKey: requesterKey,
    agentChannel: agentChannel as never,
    config: {
      session: { mainKey: "main" },
      tools: { sessions: { visibility: "all" }, agentToAgent: { enabled: true } },
    } as OpenClawConfig,
    callGateway: (opts: unknown) => callGatewayMock(opts),
  });
}

function mockChildReplyFlow(targetKey: string) {
  loadSessionEntryByKeyMock.mockImplementation((sessionKey: string) =>
    sessionKey === targetKey
      ? hubDelegatedEntry({
          sessionId: "child-session",
          ownerSessionKey: HUB_OWNER_A,
          label: "refactor",
        })
      : undefined,
  );
}

describe("hub-delegated sessions tools", () => {
  beforeEach(() => {
    callGatewayMock.mockReset();
    loadSessionEntryByKeyMock.mockReset();
    loadSessionEntryByKeyMock.mockReturnValue(undefined);
    agentStepTesting.setDepsForTest({
      agentCommandFromIngress: async () => ({
        payloads: [{ text: "ANNOUNCE_SKIP", mediaUrl: null }],
        meta: { durationMs: 1 },
      }),
      callGateway: (opts: unknown) => callGatewayMock(opts),
    });
    sessionsResolutionTesting.setDepsForTest({
      callGateway: (opts: unknown) => callGatewayMock(opts),
    });
    sessionsSendA2ATesting.setDepsForTest({
      callGateway: (opts: unknown) => callGatewayMock(opts),
    });
  });

  it("sessions_send resolves hub-delegated labels through owner scope", async () => {
    const targetKey = delegateSessionKey("codex", "delegate-child");
    mockChildReplyFlow(targetKey);
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: Record<string, unknown> };
      if (request.method === "sessions.resolve") {
        expect(request.params?.hubDelegatedOwner).toBe(HUB_OWNER_A);
        expect(request.params?.spawnedBy).toBeUndefined();
        return { key: targetKey };
      }
      if (request.method === "agent") {
        return { runId: "run-child", status: "accepted", acceptedAt: 2000 };
      }
      if (request.method === "agent.wait") {
        return { runId: "run-child", status: "ok" };
      }
      if (request.method === "chat.history") {
        return {
          messages: [
            { role: "assistant", content: [{ type: "text", text: "child reply" }], timestamp: 20 },
          ],
        };
      }
      return {};
    });

    const tool = installSendTool(HUB_OWNER_A);
    const result = await tool.execute("call-label-owner-scope", {
      label: "refactor",
      message: "ping",
      timeoutSeconds: 1,
    });
    expect(sessionsSendDetails(result.details).status).toBe("ok");
  });

  it("sessions_send reports missing labels for closed hub-delegated workers", async () => {
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "sessions.resolve") {
        throw new Error("No session found with label: refactor");
      }
      throw new Error(`unexpected gateway call: ${request.method ?? "unknown"}`);
    });

    const tool = installSendTool(HUB_OWNER_A);
    const result = await tool.execute("call-closed-delegate-label", {
      label: "refactor",
      message: "ping",
      timeoutSeconds: 1,
    });
    const details = sessionsSendDetails(result.details);
    expect(details.status).toBe("error");
    expect(details.error).toContain("No session found with label");
  });

  it("sessions_send retries hub-delegated label resolve with spawnedBy after ambiguity", async () => {
    const targetKey = delegateSessionKey("codex", "delegate-child");
    mockChildReplyFlow(targetKey);
    let resolveAttempts = 0;
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: Record<string, unknown> };
      if (request.method === "sessions.resolve") {
        resolveAttempts += 1;
        if (request.params?.hubDelegatedOwner) {
          throw new Error(
            "Multiple sessions found with label: refactor (agent:codex:acp:a, agent:codex:acp:b)",
          );
        }
        if (request.params?.spawnedBy) {
          return { key: targetKey };
        }
        throw new Error("unexpected unscoped label resolve");
      }
      if (request.method === "agent") {
        return { runId: "run-child", status: "accepted", acceptedAt: 2000 };
      }
      if (request.method === "agent.wait") {
        return { runId: "run-child", status: "ok" };
      }
      if (request.method === "chat.history") {
        return {
          messages: [
            { role: "assistant", content: [{ type: "text", text: "child reply" }], timestamp: 20 },
          ],
        };
      }
      return {};
    });

    const tool = installSendTool(HUB_OWNER_A);
    const result = await tool.execute("call-label-retry", {
      label: "refactor",
      message: "ping",
      timeoutSeconds: 1,
    });
    expect(sessionsSendDetails(result.details).status).toBe("ok");
    expect(resolveAttempts).toBe(2);
  });

  it("sessions_send skips A2A ping-pong for hub-delegated delegates without sqlite acp metadata", async () => {
    const calls: Array<{ method?: string; params?: unknown }> = [];
    const targetKey = delegateSessionKey("claude", "delegate-child");
    loadSessionEntryByKeyMock.mockImplementation((sessionKey: string) =>
      sessionKey === targetKey
        ? hubDelegatedEntry({
            sessionId: "child-session",
            ownerSessionKey: HUB_OWNER_A,
            label: "delegate-child",
          })
        : undefined,
    );
    let historyCallCount = 0;
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: unknown };
      calls.push(request);
      if (request.method === "agent") {
        return { runId: "run-child", status: "accepted", acceptedAt: 2000 };
      }
      if (request.method === "agent.wait") {
        return { runId: "run-child", status: "ok" };
      }
      if (request.method === "chat.history") {
        historyCallCount += 1;
        return {
          messages:
            historyCallCount === 1
              ? []
              : [
                  {
                    role: "assistant",
                    content: [{ type: "text", text: "child reply" }],
                    timestamp: 20,
                  },
                ],
        };
      }
      return {};
    });

    const tool = installSendTool(HUB_OWNER_A, "openclaw-weixin");
    const result = await tool.execute("call-hub-delegated-acp", {
      sessionKey: targetKey,
      message: "ping",
      timeoutSeconds: 1,
    });

    const details = sessionsSendDetails(result.details);
    expect(details.status).toBe("ok");
    expect(details.reply).toBe("child reply");
    expect(details.delivery?.status).toBe("skipped");
    expect(calls.filter((call) => call.method === "agent")).toHaveLength(1);
    expect(
      calls.some(
        (call) =>
          call.method === "agent" &&
          (call.params as { message?: string })?.message === "Agent-to-agent announce step.",
      ),
    ).toBe(false);
  });
});
