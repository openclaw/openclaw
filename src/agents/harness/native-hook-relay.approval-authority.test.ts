import { afterEach, describe, expect, it, vi } from "vitest";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-fixtures.js";
import { createAgentExecutionAttribution } from "../agent-execution-attribution.js";
import { createApprovalAuthorityForAgentHarnessAttempt } from "../agent-harness-approval-authority.js";
import { bindEmbeddedAttemptExecutionAttribution } from "../embedded-agent-runner/run/attempt-execution-attribution.js";
import type { EmbeddedRunAttemptParams } from "../embedded-agent-runner/run/types.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../tools/gateway-caller-context.js";
import { callGatewayTool } from "../tools/gateway.js";
import {
  invokeNativeHookRelay,
  registerNativeHookRelay,
  resolveNativeHookRelayDeferredToolApproval,
  testing,
} from "./native-hook-relay.js";

vi.mock("../tools/gateway.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../tools/gateway.js")>()),
  callGatewayTool: vi.fn(),
}));

const mockCallGatewayTool = vi.mocked(callGatewayTool);

afterEach(() => {
  vi.restoreAllMocks();
  mockCallGatewayTool.mockReset();
  resetGlobalHookRunner();
  testing.clearNativeHookRelaysForTests();
});

function createAdmittedAttempt(label: string): EmbeddedRunAttemptParams {
  const attempt = {
    agentId: `agent-${label}`,
    sessionKey: `agent:${label}:main`,
    config: { logging: { audit: { executionIdentity: true } } },
  } as EmbeddedRunAttemptParams;
  bindEmbeddedAttemptExecutionAttribution(
    attempt,
    createAgentExecutionAttribution({
      runId: `run-${label}`,
      lifecycleGeneration: `generation-${label}`,
      agentId: attempt.agentId,
      sessionKey: attempt.sessionKey,
    }),
  );
  return attempt;
}

const ambientB = {
  agentId: "agent-b",
  sessionKey: "agent:b:main",
  executionIdentity: {
    tokenVersion: 1 as const,
    runId: "run-b",
    contextId: "context-b",
    executionId: "execution-b",
    createdAt: 1,
  },
};

function mockApprovalRoundTrip() {
  const identities: Array<ReturnType<typeof getGatewayToolCallerIdentity>> = [];
  mockCallGatewayTool.mockImplementation(async (method) => {
    identities.push(getGatewayToolCallerIdentity());
    if (method === "plugin.approval.request") {
      return { id: "approval-a" };
    }
    if (method === "plugin.approval.waitDecision") {
      return { id: "approval-a", decision: "allow-once" };
    }
    throw new Error(`Unexpected gateway method: ${method}`);
  });
  return identities;
}

describe("native hook relay approval authority", () => {
  it("restores registration A only around a later PermissionRequest requester", async () => {
    const identities = mockApprovalRoundTrip();
    const attemptA = createAdmittedAttempt("a");
    const authorityA = createApprovalAuthorityForAgentHarnessAttempt(attemptA);
    const relay = authorityA.registerNativeHookRelay({
      provider: "codex",
      sessionId: "session-a",
      sessionKey: attemptA.sessionKey,
      runId: "run-a",
      allowedEvents: ["permission_request"],
    });
    await withGatewayToolCallerIdentity(ambientB, async () =>
      invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "permission_request",
        rawPayload: {
          hook_event_name: "PermissionRequest",
          tool_name: "Bash",
          tool_input: { command: "printf a" },
        },
      }),
    );

    expect(identities).toHaveLength(2);
    expect(identities.every((identity) => identity?.agentId === "agent-a")).toBe(true);
    expect(identities.every((identity) => identity?.executionIdentity?.runId === "run-a")).toBe(
      true,
    );
    expect(getGatewayToolCallerIdentity()).toBeUndefined();
  });

  it("snapshots registration A for deferred PreToolUse resolution under B", async () => {
    const identities = mockApprovalRoundTrip();
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_tool_call",
          handler: async () => ({
            requireApproval: { title: "Approval", description: "Approve native command" },
          }),
        },
      ]),
    );
    const attemptA = createAdmittedAttempt("a");
    const relay = createApprovalAuthorityForAgentHarnessAttempt(attemptA).registerNativeHookRelay({
      provider: "codex",
      sessionId: "session-a",
      sessionKey: attemptA.sessionKey,
      runId: "run-a",
      allowedEvents: ["pre_tool_use"],
    });
    await invokeNativeHookRelay({
      provider: "codex",
      relayId: relay.relayId,
      event: "pre_tool_use",
      rawPayload: {
        hook_event_name: "PreToolUse",
        openclaw_approval_mode: "report",
        tool_name: "Bash",
        tool_use_id: "call-a",
        tool_input: { command: "printf a" },
      },
    });
    await withGatewayToolCallerIdentity(ambientB, async () =>
      resolveNativeHookRelayDeferredToolApproval({
        relayId: relay.relayId,
        toolUseId: "call-a",
      }),
    );

    expect(identities).toHaveLength(2);
    expect(identities.every((identity) => identity?.agentId === "agent-a")).toBe(true);
    expect(identities.every((identity) => identity?.executionIdentity?.runId === "run-a")).toBe(
      true,
    );
  });

  it("does not leak authority to an unscoped replacement registration", async () => {
    const identities = mockApprovalRoundTrip();
    const relayId = "replacement-relay";
    const authorityA = createApprovalAuthorityForAgentHarnessAttempt(createAdmittedAttempt("a"));
    authorityA.registerNativeHookRelay({
      provider: "codex",
      relayId,
      sessionId: "session-a",
      runId: "run-a",
      allowedEvents: ["permission_request"],
    });
    registerNativeHookRelay({
      provider: "codex",
      relayId,
      sessionId: "session-unbound",
      runId: "run-unbound",
      allowedEvents: ["permission_request"],
    });
    await invokeNativeHookRelay({
      provider: "codex",
      relayId,
      event: "permission_request",
      rawPayload: {
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { command: "printf unbound" },
      },
    });

    expect(identities).toEqual([undefined, undefined]);
  });
});
