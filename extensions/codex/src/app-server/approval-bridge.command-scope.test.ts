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
import { createCodexTestModel } from "./test-support.js";

type HostCapabilities = EmbeddedRunAttemptParams["hostCapabilities"];

async function requestCommandApproval(options: {
  availableDecisions: JsonValue[];
  decision?: ExecApprovalDecision;
  autoApprove?: boolean;
  network?: boolean;
}) {
  const requestApproval = vi.fn<HostCapabilities["requestApproval"]>(async () => ({
    id: "plugin:approval-scope",
  }));
  const waitForApproval = vi.fn<HostCapabilities["waitForApproval"]>(async () => ({
    decision: options.decision ?? "allow-once",
    terminalReason: undefined,
  }));
  const onAgentEvent = vi.fn<NonNullable<EmbeddedRunAttemptParams["onAgentEvent"]>>();
  const authStorage = AuthStorage.inMemory();
  const model = createCodexTestModel("openai");
  const params: EmbeddedRunAttemptParams = {
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
    modelRegistry: ModelRegistry.inMemory(authStorage),
    onAgentEvent,
    hostCapabilities: {
      ...createCodexTestHostCapabilities(),
      prepareMutableFileApproval: async () => ({
        ok: true,
        requiresOneShot: false,
        revalidate: async () => ({ ok: true }),
      }),
      requestApproval,
      waitForApproval,
    },
  };

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
    waitForApproval,
    request: requestApproval.mock.calls[0]?.[0],
    resolved: onAgentEvent.mock.calls
      .map(([event]) => event)
      .find((event) => event.stream === "approval" && event.data.phase === "resolved")?.data,
  };
}

describe("Codex native command approval scopes", () => {
  it("only offers operator decisions that the native command request can enforce", async () => {
    const { result, request } = await requestCommandApproval({
      availableDecisions: ["accept", "cancel"],
    });

    expect(result).toEqual({ decision: "accept" });
    expect(request?.allowedDecisions).toEqual(["allow-once", "deny"]);
  });

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

  it.each(["session", "persistent"] as const)(
    "keeps automatic command approval one-shot when native offers %s approval",
    async (scope) => {
      const futureDecision =
        scope === "session"
          ? "acceptForSession"
          : { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["node", "--version"] } };
      const { result, requestApproval } = await requestCommandApproval({
        availableDecisions: ["accept", futureDecision, "cancel"],
        autoApprove: true,
      });

      expect(result).toEqual({ decision: "accept" });
      expect(requestApproval).not.toHaveBeenCalled();
    },
  );

  it("does not automatically approve a native request offering only a persistent grant", async () => {
    const { result, resolved } = await requestCommandApproval({
      availableDecisions: [
        { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["node", "--version"] } },
        "cancel",
      ],
      autoApprove: true,
    });

    expect(result).toEqual({ decision: "decline" });
    expect(resolved?.status).toBe("denied");
  });

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
      const { result, request, resolved, requestApproval, waitForApproval } =
        await requestCommandApproval({
          availableDecisions: [decision, "cancel"],
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
      expect(requestApproval).toHaveBeenCalledOnce();
      expect(waitForApproval).toHaveBeenCalledWith(
        expect.objectContaining({ approvalId: "plugin:approval-scope" }),
      );
    },
  );

  it("never maps operator Allow Always to a native network deny amendment", async () => {
    const allowDecision = {
      applyNetworkPolicyAmendment: {
        network_policy_amendment: { host: "registry.npmjs.org", action: "allow" },
      },
    };
    const { result } = await requestCommandApproval({
      availableDecisions: [
        "accept",
        {
          applyNetworkPolicyAmendment: {
            network_policy_amendment: { host: "registry.npmjs.org", action: "deny" },
          },
        },
        allowDecision,
        "cancel",
      ],
      decision: "allow-always",
      network: true,
    });

    expect(result).toEqual({ decision: allowDecision });
  });

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
