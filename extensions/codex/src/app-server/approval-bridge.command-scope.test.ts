import type {
  EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
  ExecApprovalDecision,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { AuthStorage, ModelRegistry } from "openclaw/plugin-sdk/agent-sessions";
import { describe, expect, it, vi } from "vitest";
import { handleCodexAppServerApprovalRequest } from "./approval-bridge.js";
import { codexTestTurnIds } from "./codex-app-server.test-fixtures.js";
import { createCodexTestHostCapabilities } from "./host-capability.test-support.js";
import type { JsonValue } from "./protocol.js";
import { CodexServerRequestResolvedError } from "./server-requests.js";
import { createCodexTestModel } from "./test-support.js";

type HostCapabilities = EmbeddedRunAttemptParams["hostCapabilities"];
const authStorage = AuthStorage.inMemory();
const model = createCodexTestModel("openai");
const modelRegistry = ModelRegistry.inMemory(authStorage);

function createParams(overrides: Partial<HostCapabilities> = {}): EmbeddedRunAttemptParams {
  return {
    prompt: "Review this native command approval.",
    sessionId: "approval-scope",
    sessionKey: "agent:main:approval-scope",
    sessionFile: "/tmp/openclaw-approval-scope/session.jsonl",
    workspaceDir: "/tmp/openclaw-approval-scope",
    runId: "approval-scope-run",
    agentId: "main",
    provider: "openai",
    modelId: model.id,
    model,
    thinkLevel: "medium",
    disableTools: false,
    timeoutMs: 5_000,
    authStorage,
    authProfileStore: { version: 1, profiles: {} },
    modelRegistry,
    onAgentEvent: vi.fn<NonNullable<EmbeddedRunAttemptParams["onAgentEvent"]>>(),
    hostCapabilities: createCodexTestHostCapabilities({
      prepareMutableFileApproval: async () => ({
        ok: true,
        requiresOneShot: false,
        revalidate: async () => ({ ok: true }),
      }),
      ...overrides,
    }),
  };
}

async function requestCommandApproval(options: {
  availableDecisions: JsonValue[];
  decision?: ExecApprovalDecision;
  autoApprove?: boolean;
  network?: boolean;
}) {
  const requestApproval = vi.fn<HostCapabilities["requestApproval"]>(async () => ({
    id: "plugin:approval-scope",
  }));
  const params = createParams({
    requestApproval,
    waitForApproval: async () => ({
      decision: options.decision ?? "allow-once",
      terminalReason: undefined,
    }),
  });
  const result = await handleCodexAppServerApprovalRequest({
    method: "item/commandExecution/requestApproval",
    requestParams: {
      ...codexTestTurnIds(),
      itemId: "command-scope",
      command: "node --version",
      ...(options.network
        ? { networkApprovalContext: { host: "registry.npmjs.org", protocol: "https" } }
        : {}),
      availableDecisions: options.availableDecisions,
    },
    paramsForRun: params,
    ...codexTestTurnIds(),
    autoApprove: options.autoApprove,
  });
  return {
    result,
    requestApproval,
    request: requestApproval.mock.calls[0]?.[0],
    resolved: vi
      .mocked(params.onAgentEvent!)
      .mock.calls.map(([event]) => event)
      .find((event) => event.stream === "approval" && event.data.phase === "resolved")?.data,
  };
}

describe("Codex native command approval scopes", () => {
  it("prefers offered session approval over a persistent native amendment", async () => {
    const { result, request, resolved } = await requestCommandApproval({
      availableDecisions: [
        "accept",
        "acceptForSession",
        { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["node", "--version"] } },
        "decline",
        "cancel",
      ],
      decision: "allow-always",
    });
    expect(result).toEqual({ decision: "acceptForSession" });
    expect(request?.allowedDecisions).toEqual(["allow-once", "allow-always", "deny"]);
    expect(resolved?.message).toContain("for the session");
  });

  it.each([
    { once: true, expected: "accept", status: "approved" },
    { once: false, expected: "decline", status: "denied" },
  ])(
    "never automatically grants persistent policy when one-shot is $once",
    async ({ once, expected, status }) => {
      const { result, requestApproval, resolved } = await requestCommandApproval({
        availableDecisions: [
          ...(once ? ["accept"] : []),
          { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["node", "--version"] } },
          "cancel",
        ],
        autoApprove: true,
      });
      expect(result).toEqual({ decision: expected });
      expect(requestApproval).not.toHaveBeenCalled();
      expect(resolved?.status).toBe(status);
    },
  );

  it.each(["exec", "network"] as const)(
    "describes operator-selected %s amendments as persistent native policy",
    async (kind) => {
      const decision: JsonValue =
        kind === "exec"
          ? { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["node", "--version"] } }
          : {
              applyNetworkPolicyAmendment: {
                network_policy_amendment: { host: "registry.npmjs.org", action: "allow" },
              },
            };
      const { result, request, resolved } = await requestCommandApproval({
        availableDecisions: [
          {
            applyNetworkPolicyAmendment: {
              network_policy_amendment: { host: "registry.npmjs.org", action: "deny" },
            },
          },
          decision,
          "cancel",
        ],
        decision: "allow-always",
        network: kind === "network",
      });
      expect(result).toEqual({ decision });
      expect(request?.allowedDecisions).toEqual(["allow-always", "deny"]);
      expect(request?.description).toContain("future sessions");
      expect(request?.description).toContain(
        kind === "exec" ? '["node","--version"]' : "registry.npmjs.org",
      );
      expect(resolved?.status).toBe("approved");
      expect(resolved?.message).toContain("future sessions");
      expect(resolved?.message).not.toContain("saved");
      expect(resolved?.message).not.toContain("granted for the session");
    },
  );

  it.each([
    { label: "truncated", prefix: ["node", "a".repeat(512)] },
    { label: "visually altered", prefix: ["node", "\u202eexample.js"] },
  ])("keeps a $label persistent target on one-shot approval", async ({ prefix }) => {
    const { result, request, resolved } = await requestCommandApproval({
      availableDecisions: [
        "accept",
        { acceptWithExecpolicyAmendment: { execpolicy_amendment: prefix } },
        "cancel",
      ],
      decision: "allow-always",
    });
    expect(request?.allowedDecisions).toEqual(["allow-once", "deny"]);
    expect(result).toEqual({ decision: "accept" });
    expect(resolved?.message).toContain("for this turn");
  });
});

describe("Codex approval request lifetime", () => {
  it.each(["before dispatch", "policy", "registration", "decision"] as const)(
    "does not report native failure when another client resolves approval during %s",
    async (phase) => {
      const controller = new AbortController();
      const resolved = new CodexServerRequestResolvedError();
      const onNativeToolFailureDisposition = vi.fn();
      const resolveDuring = (stage: typeof phase) => {
        if (phase === stage) {
          controller.abort(resolved);
        }
      };
      const waitForApproval = vi.fn<HostCapabilities["waitForApproval"]>(async () => {
        resolveDuring("decision");
        return undefined;
      });
      const params = createParams({
        runBeforeToolCall: async ({ params: toolParams }) => {
          resolveDuring("policy");
          return { blocked: false, params: toolParams };
        },
        requestApproval: async ({ signal }) => {
          expect(signal).toBe(controller.signal);
          resolveDuring("registration");
          return { id: "plugin:approval-resolved" };
        },
        waitForApproval,
      });
      resolveDuring("before dispatch");
      const result = await handleCodexAppServerApprovalRequest({
        method: "item/fileChange/requestApproval",
        requestParams: { ...codexTestTurnIds(), itemId: "patch-resolved" },
        paramsForRun: params,
        ...codexTestTurnIds(),
        signal: controller.signal,
        onNativeToolFailureDisposition,
      });
      expect(result).toBeUndefined();
      expect(onNativeToolFailureDisposition).not.toHaveBeenCalled();
      expect(params.onAgentEvent).not.toHaveBeenCalledWith({
        stream: "approval",
        data: expect.objectContaining({ phase: "resolved" }),
      });
      expect(waitForApproval).toHaveBeenCalledTimes(phase === "decision" ? 1 : 0);
    },
  );

  it("retains approval correlation and transport failure when the client closes during registration", async () => {
    const controller = new AbortController();
    const onNativeToolFailureDisposition = vi.fn();
    const params = createParams({
      requestApproval: async () => {
        controller.abort("client_closed");
        return { id: "plugin:approval-cancelled" };
      },
    });
    const response = await handleCodexAppServerApprovalRequest({
      method: "item/fileChange/requestApproval",
      requestParams: { ...codexTestTurnIds(), itemId: "patch-cancelled" },
      paramsForRun: params,
      ...codexTestTurnIds(),
      signal: controller.signal,
      onNativeToolFailureDisposition,
    });
    expect(response).toEqual({ decision: "cancel" });
    expect(onNativeToolFailureDisposition).toHaveBeenCalledWith("patch-cancelled", "failed");
    expect(params.onAgentEvent).toHaveBeenCalledWith({
      stream: "approval",
      data: expect.objectContaining({
        phase: "resolved",
        status: "failed",
        approvalId: "plugin:approval-cancelled",
        approvalSlug: "plugin:approval-cancelled",
      }),
    });
  });
});
