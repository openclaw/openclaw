import { createInMemorySessionStore } from "@openclaw/acp-core/session";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import type { EventFrame } from "../../packages/gateway-protocol/src/index.js";
import type { GatewayClient } from "../gateway/client.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { AcpGatewayAgent } from "./translator.js";
import { promptAgent } from "./translator.prompt-harness.test-support.js";
import {
  createAcpConnection,
  createAcpGateway,
  createAcpGatewayAgent,
} from "./translator.test-helpers.js";

vi.mock("./commands.js", () => ({ getAvailableCommands: () => [] }));
const SESSION_KEY = "agent:main:main";

function approval(runId: string, approvalId = "approval-1", toolCallId?: string): EventFrame {
  return {
    type: "event",
    event: "agent",
    payload: {
      runId,
      sessionKey: SESSION_KEY,
      stream: "approval",
      data: {
        phase: "requested",
        kind: "exec",
        status: "pending",
        title: "Command approval requested",
        approvalId,
        toolCallId,
        command: "echo event",
        host: "gateway",
      },
    },
  };
}

function rawApproval(id: string, toolCallId?: string): EventFrame {
  return {
    type: "event",
    event: "exec.approval.requested",
    payload: {
      id,
      createdAtMs: 1,
      expiresAtMs: 2,
      request: { command: "echo raw", host: "gateway", sessionKey: SESSION_KEY, toolCallId },
    },
  };
}

function tool(runId: string, toolCallId: string, name = "exec", command?: string): EventFrame {
  return {
    type: "event",
    event: "agent",
    payload: {
      runId,
      sessionKey: SESSION_KEY,
      stream: "tool",
      data: { phase: "start", name, toolCallId, args: command ? { command } : {} },
    },
  };
}

async function createHarness(
  params: {
    sessions?: string[];
    allowedDecisions?: string[];
    requestPermission?: ReturnType<typeof vi.fn>;
    resolveApproval?: (params?: Record<string, unknown>) => unknown;
  } = {},
) {
  const runIds: string[] = [];
  const request = vi.fn(async (method: string, requestParams?: Record<string, unknown>) => {
    if (method === "chat.send") {
      const runId = expectDefined(
        requestParams?.idempotencyKey as string | undefined,
        "Gateway run id",
      );
      runIds.push(runId);
      return { status: "started", runId };
    }
    if (method === "exec.approval.get") {
      return {
        id: requestParams?.id,
        commandText: "echo hydrated",
        allowedDecisions: params.allowedDecisions ?? ["allow-once", "allow-always", "deny"],
        host: "gateway",
      };
    }
    if (method === "exec.approval.resolve" && params.resolveApproval) {
      return params.resolveApproval(requestParams);
    }
    return {};
  });
  const requestPermission =
    params.requestPermission ??
    vi.fn(async () => ({
      outcome: { outcome: "selected", optionId: "allow-once" },
    }));
  const sessionStore = createInMemorySessionStore();
  const sessions = params.sessions ?? ["session-1"];
  for (const sessionId of sessions) {
    sessionStore.createSession({ sessionId, sessionKey: SESSION_KEY, cwd: "/tmp" });
  }
  const agent = createAcpGatewayAgent(
    createAcpConnection({ requestPermission }),
    createAcpGateway(request as GatewayClient["request"]),
    { sessionStore },
  );
  const prompts = sessions.map((sessionId) => promptAgent(agent, sessionId));
  await vi.waitFor(() => expect(runIds).toHaveLength(sessions.length));
  return {
    agent,
    request,
    requestPermission,
    runIds,
    runId: expectDefined(runIds[0], "first Gateway run id"),
    async cleanup() {
      for (const sessionId of sessions) {
        await agent.cancel({ sessionId });
      }
      await Promise.all(prompts);
    },
  };
}

function resolveCalls(request: Awaited<ReturnType<typeof createHarness>>["request"]) {
  return request.mock.calls.filter(([method]) => method === "exec.approval.resolve");
}

function pendingDecision(agent: AcpGatewayAgent, approvalId: string): unknown {
  const relays = (
    agent as unknown as {
      approvalRelays: Map<string, { pendingDecision?: unknown }>;
    }
  ).approvalRelays;
  return relays.get(approvalId)?.pendingDecision;
}

function captureRetry(agent: AcpGatewayAgent, approvalId: string): () => Promise<void> {
  const internal = agent as unknown as {
    approvalRelays: Map<string, unknown>;
    promptStream: {
      agentEvents: { retryApprovalRelayDecision: (relay: unknown) => Promise<void> };
    };
  };
  const relay = expectDefined(internal.approvalRelays.get(approvalId), "active approval relay");
  return () => internal.promptStream.agentEvents.retryApprovalRelayDecision(relay);
}

describe("ACP translator permission relay", () => {
  it.each([
    {
      name: "explicit deny",
      outcome: { outcome: "selected", optionId: "deny" },
      decision: "deny",
    },
    { name: "cancelled", outcome: { outcome: "cancelled" }, decision: "deny" },
    {
      name: "unknown option",
      outcome: { outcome: "selected", optionId: "not-a-real-option" },
      decision: "deny",
    },
  ])(
    "relays the $name outcome as $decision to Gateway approval resolution",
    async ({ outcome, decision }) => {
      const harness = await createHarness({
        requestPermission: vi.fn(async () => ({ outcome })),
      });
      try {
        await harness.agent.handleGatewayEvent(approval(harness.runId));
        await vi.waitFor(() => {
          expect(resolveCalls(harness.request)).toEqual([
            ["exec.approval.resolve", { id: "approval-1", decision }],
          ]);
        });
      } finally {
        await harness.cleanup();
      }
    },
  );

  it("relays raw approval requests once before the later agent approval event", async () => {
    const harness = await createHarness();
    await harness.agent.handleGatewayEvent(rawApproval("approval-raw"));
    await harness.agent.handleGatewayEvent(approval(harness.runId, "approval-raw", "tool-late"));
    await vi.waitFor(() => {
      expect(harness.requestPermission).toHaveBeenCalledTimes(1);
      expect(resolveCalls(harness.request)).toHaveLength(1);
    });
    expect(harness.requestPermission).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        toolCall: expect.objectContaining({
          toolCallId: "exec:approval-raw",
          kind: "execute",
          rawInput: expect.objectContaining({
            name: "exec",
            approvalId: "approval-raw",
            command: "echo hydrated",
          }),
        }),
      }),
    );
    expect(harness.request).toHaveBeenCalledWith("exec.approval.get", { id: "approval-raw" });
    expect(harness.request).toHaveBeenCalledWith("exec.approval.resolve", {
      id: "approval-raw",
      decision: "allow-once",
    });
    await harness.cleanup();
  });

  it("correlates concurrent approvals by a unique execute tool call and fails closed otherwise", async () => {
    const harness = await createHarness({
      sessions: ["session-1", "session-2"],
      allowedDecisions: ["allow-once", "deny"],
    });
    const secondRun = expectDefined(harness.runIds[1], "second Gateway run id");
    await harness.agent.handleGatewayEvent(approval("other-run"));
    await harness.agent.handleGatewayEvent(rawApproval("approval-without-tool-id"));
    expect(harness.requestPermission).not.toHaveBeenCalled();
    expect(resolveCalls(harness.request)).toHaveLength(0);
    await harness.agent.handleGatewayEvent(tool(secondRun, "tool-second", "exec", "echo second"));
    expect(harness.requestPermission).not.toHaveBeenCalled();
    await harness.agent.handleGatewayEvent(rawApproval("approval-shared", "tool-second"));
    await vi.waitFor(() => {
      expect(harness.requestPermission).toHaveBeenCalledTimes(1);
      expect(resolveCalls(harness.request)).toHaveLength(1);
    });
    expect(harness.requestPermission).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-2",
        toolCall: expect.objectContaining({
          toolCallId: "tool-second",
          title: expect.stringContaining("echo second"),
        }),
      }),
    );
    expect(harness.request).toHaveBeenCalledWith("exec.approval.resolve", {
      id: "approval-shared",
      decision: "allow-once",
    });
    await harness.agent.handleGatewayEvent(rawApproval("approval-mismatch", "tool-missing"));
    for (const runId of harness.runIds) {
      await harness.agent.handleGatewayEvent(tool(runId, "tool-duplicate"));
    }
    await harness.agent.handleGatewayEvent(rawApproval("approval-duplicate", "tool-duplicate"));
    await harness.agent.handleGatewayEvent(tool(harness.runId, "tool-read", "read"));
    await harness.agent.handleGatewayEvent(rawApproval("approval-read", "tool-read"));
    expect(harness.requestPermission).toHaveBeenCalledTimes(1);
    expect(resolveCalls(harness.request)).toHaveLength(1);
    await harness.cleanup();
  });

  it("retries the recorded decision on duplicate approval events instead of re-asking", async () => {
    const resolveApproval = vi
      .fn()
      .mockRejectedValueOnce(new Error("gateway not connected"))
      .mockResolvedValueOnce({});
    const harness = await createHarness({ resolveApproval });
    const event = approval(harness.runId, "approval-retry");
    await harness.agent.handleGatewayEvent(event);
    await vi.waitFor(() =>
      expect(pendingDecision(harness.agent, "approval-retry")).toBe("allow-once"),
    );
    expect(resolveApproval).toHaveBeenCalledTimes(1);
    await harness.agent.handleGatewayEvent(event);
    await vi.waitFor(() => expect(resolveApproval).toHaveBeenCalledTimes(2));
    expect(harness.requestPermission).toHaveBeenCalledTimes(1);
    expect(harness.request).toHaveBeenLastCalledWith("exec.approval.resolve", {
      id: "approval-retry",
      decision: "allow-once",
    });
    await harness.cleanup();
  });

  it("replays the user's approval decision on gateway reconnect", async () => {
    const permission = createDeferredCore<unknown>();
    const resolveApproval = vi
      .fn()
      .mockRejectedValueOnce(new Error("gateway not connected"))
      .mockResolvedValueOnce({});
    const harness = await createHarness({
      resolveApproval,
      requestPermission: vi.fn(() => permission.promise),
    });
    await harness.agent.handleGatewayEvent(approval(harness.runId, "approval-replay"));
    await vi.waitFor(() => expect(harness.requestPermission).toHaveBeenCalledTimes(1));
    harness.agent.handleGatewayDisconnect("1006: connection lost");
    permission.resolve({ outcome: { outcome: "selected", optionId: "allow-once" } });
    await vi.waitFor(() => expect(resolveApproval).toHaveBeenCalledTimes(1));
    harness.agent.handleGatewayReconnect();
    await vi.waitFor(() => expect(resolveApproval).toHaveBeenCalledTimes(2));
    expect(harness.request).toHaveBeenCalledWith("exec.approval.resolve", {
      id: "approval-replay",
      decision: "allow-once",
    });
    expect(harness.requestPermission).toHaveBeenCalledTimes(1);
    await harness.cleanup();
  });

  it("does not retry a stored decision after prompt cleanup revokes its relay", async () => {
    const resolveApproval = vi
      .fn()
      .mockRejectedValueOnce(new Error("gateway not connected"))
      .mockResolvedValue({});
    const harness = await createHarness({ resolveApproval });
    const approvalId = "approval-revoked";
    await harness.agent.handleGatewayEvent(approval(harness.runId, approvalId));
    await vi.waitFor(() => expect(pendingDecision(harness.agent, approvalId)).toBe("allow-once"));
    const retry = captureRetry(harness.agent, approvalId);
    await harness.cleanup();
    await retry();
    expect(resolveApproval.mock.calls).toEqual([
      [{ id: approvalId, decision: "allow-once" }],
      [{ id: approvalId, decision: "deny" }],
    ]);
  });

  it("denies when the ACP client permission request throws", async () => {
    const harness = await createHarness({
      requestPermission: vi.fn(async () => {
        throw new Error("client closed");
      }),
    });
    await harness.agent.handleGatewayEvent(approval(harness.runId));
    await vi.waitFor(() => {
      expect(harness.requestPermission).toHaveBeenCalledTimes(1);
      expect(harness.request).toHaveBeenCalledWith("exec.approval.resolve", {
        id: "approval-1",
        decision: "deny",
      });
    });
    await harness.cleanup();
  });

  it("does not allow execution when the prompt is cancelled during client permission UI", async () => {
    const permission = createDeferredCore<unknown>();
    const harness = await createHarness({ requestPermission: vi.fn(() => permission.promise) });
    await harness.agent.handleGatewayEvent(approval(harness.runId));
    await vi.waitFor(() => expect(harness.requestPermission).toHaveBeenCalledTimes(1));
    await harness.cleanup();
    permission.resolve({ outcome: { outcome: "selected", optionId: "allow-once" } });
    await vi.waitFor(() => {
      const decisions = resolveCalls(harness.request).map(([, params]) => params?.decision);
      expect(decisions).toContain("deny");
      expect(decisions).not.toContain("allow-once");
    });
  });
});
