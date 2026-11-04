import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, onTestFinished, vi } from "vitest";
import type { EventFrame } from "../../packages/gateway-protocol/src/index.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { AcpGatewayAgent } from "./translator.js";
import { createPromptScenario, expectSingleCall } from "./translator.scenario.test-support.js";

const SESSION_KEY = "agent:main:main";

function agentEvent(runId: string, stream: string, data: Record<string, unknown>): EventFrame {
  return {
    type: "event",
    event: "agent",
    payload: { runId, sessionKey: SESSION_KEY, stream, data },
  };
}

function approval(runId: string, approvalId = "approval-1", toolCallId?: string): EventFrame {
  return agentEvent(runId, "approval", {
    phase: "requested",
    kind: "exec",
    status: "pending",
    title: "Command approval requested",
    approvalId,
    toolCallId,
    command: "echo event",
    host: "gateway",
  });
}

function rawApproval(id: string, toolCallId?: string): EventFrame {
  const request = { command: "echo raw", host: "gateway", sessionKey: SESSION_KEY, toolCallId };
  return { type: "event", event: "exec.approval.requested", payload: { id, request } };
}

function tool(runId: string, toolCallId: string, name = "exec", command?: string): EventFrame {
  return agentEvent(runId, "tool", {
    phase: "start",
    name,
    toolCallId,
    args: command ? { command } : {},
  });
}

async function createHarness(
  params: {
    sessions?: string[];
    allowedDecisions?: string[];
    requestPermission?: ReturnType<typeof vi.fn>;
    resolveApproval?: (params?: Record<string, unknown>) => unknown;
  } = {},
) {
  const requestPermission =
    params.requestPermission ??
    vi.fn(async () => ({ outcome: { outcome: "selected", optionId: "allow-once" } }));
  const sessions = params.sessions ?? ["session-1"];
  const h = createPromptScenario({
    sessions,
    requestPermission,
    send: (sendParams) => ({ status: "started", runId: sendParams?.idempotencyKey }),
    request: (method, requestParams) => {
      if (method === "exec.approval.get") {
        return {
          commandText: "echo hydrated",
          allowedDecisions: params.allowedDecisions ?? ["allow-once", "allow-always", "deny"],
          host: "gateway",
        };
      }
      return method === "exec.approval.resolve" && params.resolveApproval
        ? params.resolveApproval(requestParams)
        : {};
    },
  });
  const prompts = sessions.map((sessionId) => h.prompt(sessionId));
  await vi.waitFor(() => expect(h.runIds).toHaveLength(sessions.length));
  const cleanup = async () => {
    for (const sessionId of sessions) {
      await h.agent.cancel({ sessionId });
    }
    await Promise.all(prompts);
  };
  onTestFinished(cleanup);
  const resolutions = () =>
    h.request.mock.calls.filter(([method]) => method === "exec.approval.resolve");
  return {
    ...h,
    requestPermission,
    resolutions,
    send: h.agent.handleGatewayEvent.bind(h.agent),
    async expectResolution(id: string, decision = "allow-once", attempts = 1) {
      await vi.waitFor(() => {
        expect(requestPermission).toHaveBeenCalledTimes(1);
        expect(resolutions()).toEqual(
          Array.from({ length: attempts }, () => ["exec.approval.resolve", { id, decision }]),
        );
      });
    },
    runId: expectDefined(h.runIds[0], "first Gateway run id"),
    cleanup,
  };
}

function disconnectedResolution(repeat = false) {
  const resolve = vi.fn().mockRejectedValueOnce(new Error("gateway not connected"));
  return repeat ? resolve.mockResolvedValue({}) : resolve.mockResolvedValueOnce({});
}

function approvalRelay(agent: AcpGatewayAgent, approvalId: string) {
  const internal = agent as unknown as {
    approvalRelays: Map<string, { pendingDecision?: unknown }>;
    promptStream: {
      agentEvents: { retryApprovalRelayDecision: (relay: unknown) => Promise<void> };
    };
  };
  const relay = internal.approvalRelays.get(approvalId);
  return {
    decision: relay?.pendingDecision,
    retry: () =>
      internal.promptStream.agentEvents.retryApprovalRelayDecision(
        expectDefined(relay, "active approval relay"),
      ),
  };
}

it.each([
  ["explicit deny", { outcome: "selected", optionId: "deny" }],
  ["cancelled", { outcome: "cancelled" }],
  ["unknown option", { outcome: "selected", optionId: "not-a-real-option" }],
  ["client throws", new Error("client closed")],
] as const)("relays %s as deny to Gateway approval resolution", async (_name, outcome) => {
  const requestPermission =
    outcome instanceof Error
      ? vi.fn().mockRejectedValue(outcome)
      : vi.fn().mockResolvedValue({ outcome });
  const h = await createHarness({ requestPermission });
  await h.send(approval(h.runId));
  await h.expectResolution("approval-1", "deny");
});

it("relays raw approval requests once before the later agent approval event", async () => {
  const h = await createHarness();
  await h.send(rawApproval("approval-raw"));
  await h.send(approval(h.runId, "approval-raw", "tool-late"));
  await h.expectResolution("approval-raw");
  expectSingleCall(h.requestPermission, {
    sessionId: "session-1",
    toolCall: {
      toolCallId: "exec:approval-raw",
      rawInput: { command: "echo hydrated" },
    },
  });
});

it("correlates concurrent approvals by a unique execute tool call and fails closed otherwise", async () => {
  const h = await createHarness({
    sessions: ["session-1", "session-2"],
    allowedDecisions: ["allow-once", "deny"],
  });
  const secondRun = expectDefined(h.runIds[1], "second Gateway run id");
  await h.send(approval("other-run"));
  await h.send(rawApproval("approval-without-tool-id"));
  expect(h.requestPermission).not.toHaveBeenCalled();
  expect(h.resolutions()).toHaveLength(0);
  await h.send(tool(secondRun, "tool-second", "exec", "echo second"));
  expect(h.requestPermission).not.toHaveBeenCalled();
  await h.send(rawApproval("approval-shared", "tool-second"));
  await h.expectResolution("approval-shared");
  expectSingleCall(h.requestPermission, {
    sessionId: "session-2",
    toolCall: { toolCallId: "tool-second", title: expect.stringContaining("echo second") },
  });
  await h.send(rawApproval("approval-mismatch", "tool-missing"));
  for (const runId of h.runIds) {
    await h.send(tool(runId, "tool-duplicate"));
  }
  await h.send(rawApproval("approval-duplicate", "tool-duplicate"));
  await h.send(tool(h.runId, "tool-read", "read"));
  await h.send(rawApproval("approval-read", "tool-read"));
  expect(h.requestPermission).toHaveBeenCalledTimes(1);
  expect(h.resolutions()).toHaveLength(1);
});

it.each(["duplicate event", "gateway reconnect"])(
  "retries the recorded decision on %s without re-asking",
  async (trigger) => {
    const permission = createDeferredCore<unknown>();
    const resolveApproval = disconnectedResolution();
    const h = await createHarness({
      resolveApproval,
      requestPermission: vi.fn(() => permission.promise),
    });
    const event = approval(h.runId, "approval-retry");
    await h.send(event);
    await vi.waitFor(() => expect(h.requestPermission).toHaveBeenCalledTimes(1));
    if (trigger === "gateway reconnect") {
      h.agent.handleGatewayDisconnect("1006: connection lost");
    }
    permission.resolve({ outcome: { outcome: "selected", optionId: "allow-once" } });
    await vi.waitFor(() =>
      expect(approvalRelay(h.agent, "approval-retry").decision).toBe("allow-once"),
    );
    expect(resolveApproval).toHaveBeenCalledTimes(1);
    if (trigger === "gateway reconnect") {
      h.agent.handleGatewayReconnect();
    } else {
      await h.send(event);
    }
    await h.expectResolution("approval-retry", "allow-once", 2);
  },
);

it("does not retry a stored decision after prompt cleanup revokes its relay", async () => {
  const resolveApproval = disconnectedResolution(true);
  const h = await createHarness({ resolveApproval });
  const approvalId = "approval-revoked";
  await h.send(approval(h.runId, approvalId));
  await vi.waitFor(() => expect(approvalRelay(h.agent, approvalId).decision).toBe("allow-once"));
  const { retry } = approvalRelay(h.agent, approvalId);
  await h.cleanup();
  await retry();
  expect(resolveApproval.mock.calls).toEqual([
    [{ id: approvalId, decision: "allow-once" }],
    [{ id: approvalId, decision: "deny" }],
  ]);
});

it("does not allow execution when the prompt is cancelled during client permission UI", async () => {
  const permission = createDeferredCore<unknown>();
  const h = await createHarness({ requestPermission: vi.fn(() => permission.promise) });
  await h.send(approval(h.runId));
  await vi.waitFor(() => expect(h.requestPermission).toHaveBeenCalledTimes(1));
  await h.cleanup();
  permission.resolve({ outcome: { outcome: "selected", optionId: "allow-once" } });
  await vi.waitFor(() => {
    const decisions = h.resolutions().map(([, params]) => params?.decision);
    expect(decisions).toContain("deny");
    expect(decisions).not.toContain("allow-once");
  });
});
