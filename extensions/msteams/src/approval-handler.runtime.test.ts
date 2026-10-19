import type {
  ExecApprovalPendingView,
  PendingApprovalView,
  PluginApprovalPendingView,
} from "openclaw/plugin-sdk/approval-handler-runtime";
import type {
  ExecApprovalRequest,
  PluginApprovalRequest,
} from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { msTeamsApprovalControls } from "./approval-card-actions.js";
import { maybeHandleMSTeamsApprovalCardSubmit } from "./approval-card-submit.js";
import { createMSTeamsMessageHandlerDeps } from "./monitor-handler.test-helpers.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";

const resolveApprovalOverGateway = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/approval-gateway-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/approval-gateway-runtime")>()),
  resolveApprovalOverGateway,
}));

const sendAdaptiveCardMSTeams = vi.hoisted(() => vi.fn());
const editAdaptiveCardMSTeams = vi.hoisted(() => vi.fn());
const sendMessageMSTeams = vi.hoisted(() => vi.fn());

vi.mock("./send.js", async () => ({
  ...(await vi.importActual<typeof import("./send.js")>("./send.js")),
  sendAdaptiveCardMSTeams,
  editAdaptiveCardMSTeams,
  sendMessageMSTeams,
}));

const { msTeamsApprovalNativeRuntime } = await import("./approval-handler.runtime.js");

const cfg: OpenClawConfig = {
  channels: {
    msteams: {
      enabled: true,
      appId: "teams-app",
      appPassword: "test-password",
      tenantId: "teams-tenant",
      allowFrom: ["00000000-0000-4000-8000-000000000001"],
    },
  },
};

const approveAction = {
  decision: "allow-once",
  label: "Approve once",
  style: "success",
  command: "",
} as const;

function createExecPendingView(): ExecApprovalPendingView {
  return {
    approvalId: "exec-approval-1",
    approvalKind: "exec",
    phase: "pending",
    title: "Exec Approval Required",
    metadata: [],
    commandText: "deploy --production",
    actions: [approveAction, { decision: "deny", label: "Deny", style: "danger", command: "" }],
    expiresAtMs: Date.now() + 60_000,
  };
}

function createPluginPendingView(): PluginApprovalPendingView {
  return {
    phase: "pending",
    expiresAtMs: Date.now() + 60_000,
    approvalId: "plugin-approval-1",
    approvalKind: "plugin",
    title: "Deploy production service",
    description: "The deployment plugin requests access.",
    metadata: [],
    severity: "critical",
    actions: [approveAction],
  };
}

function createRequest(view: PendingApprovalView): ExecApprovalRequest | PluginApprovalRequest {
  const common = {
    id: view.approvalId,
    createdAtMs: Date.now(),
    expiresAtMs: view.expiresAtMs,
  };
  if (view.approvalKind === "plugin") {
    return {
      ...common,
      request: {
        title: view.title,
        description: view.description ?? "",
        severity: view.severity,
      },
    };
  }
  return { ...common, request: { command: view.commandText } };
}

async function createPendingScenario(view: PendingApprovalView = createExecPendingView()) {
  const request = createRequest(view);
  const common = { cfg, accountId: "default", request, approvalKind: view.approvalKind, view };
  const pendingPayload = await msTeamsApprovalNativeRuntime.presentation.buildPendingPayload({
    ...common,
    nowMs: Date.now(),
  });
  const plannedTarget = {
    surface: "origin" as const,
    target: { to: "msteams:conversation:19:channel@thread.tacv2", threadId: "thread-root" },
    reason: "preferred" as const,
  };
  const prepared = await msTeamsApprovalNativeRuntime.transport.prepareTarget({
    ...common,
    plannedTarget,
    pendingPayload,
  });
  if (!prepared) {
    throw new Error("Expected prepared Microsoft Teams approval target");
  }
  return { ...common, pendingPayload, plannedTarget, preparedTarget: prepared.target };
}

async function deliverScenario(
  view: PendingApprovalView = createExecPendingView(),
  accountId = "default",
) {
  const scenario = { ...(await createPendingScenario(view)), accountId };
  const entry = await msTeamsApprovalNativeRuntime.transport.deliverPending(scenario);
  if (!entry) {
    throw new Error("Expected delivered Microsoft Teams approval card");
  }
  return { ...scenario, entry };
}

async function bindScenario(scenario: Awaited<ReturnType<typeof deliverScenario>>) {
  const binding = await msTeamsApprovalNativeRuntime.interactions?.bindPending?.(scenario);
  if (!binding) {
    throw new Error("Expected native approval action bindings");
  }
  return binding;
}

describe("msTeamsApprovalNativeRuntime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendAdaptiveCardMSTeams.mockResolvedValue({
      messageId: "approval-activity-1",
      conversationId: "19:channel@thread.tacv2",
    });
    editAdaptiveCardMSTeams.mockResolvedValue({ conversationId: "19:channel@thread.tacv2" });
  });

  it("settles an issued card only through its issuing account, not an authorized sibling", async () => {
    const scenario = await deliverScenario(createExecPendingView(), "support");
    const { request, entry } = scenario;
    await bindScenario(scenario);
    const token = entry.actionTokens[0]?.token;
    if (!token) {
      throw new Error("Expected bound approval token");
    }
    const context: MSTeamsTurnContext = {
      activity: {
        type: "message",
        from: { aadObjectId: "00000000-0000-4000-8000-000000000001" },
        conversation: { id: entry.conversationId },
        replyToId: entry.activityId,
        value: { openclawAction: "approval", token },
      },
      sendActivity: vi.fn(async () => undefined),
      sendActivities: vi.fn(async () => []),
      updateActivity: vi.fn(async () => undefined),
      deleteActivity: vi.fn(async () => undefined),
    };
    const deps = createMSTeamsMessageHandlerDeps({
      cfg: {
        channels: {
          msteams: {
            accounts: {
              support: { allowFrom: ["00000000-0000-4000-8000-000000000001"] },
              sales: { allowFrom: ["00000000-0000-4000-8000-000000000001"] },
            },
          },
        },
      },
    });
    try {
      deps.accountId = "sales";
      await maybeHandleMSTeamsApprovalCardSubmit({ context, deps });
      expect(resolveApprovalOverGateway).not.toHaveBeenCalled();
      expect(msTeamsApprovalControls.get(token)).not.toBeNull();
      resolveApprovalOverGateway.mockResolvedValue({
        applied: true,
        approval: {
          id: request.id,
          status: "allowed",
          decision: "allow-once",
          reason: "user",
          createdAtMs: request.createdAtMs,
          expiresAtMs: request.expiresAtMs,
          resolvedAtMs: Date.now(),
          urlPath: "/approve/" + request.id,
          presentation: {
            kind: "exec",
            commandText: "deploy --production",
            allowedDecisions: ["allow-once", "deny"],
          },
        },
      });
      deps.accountId = "support";
      await maybeHandleMSTeamsApprovalCardSubmit({ context, deps });
      expect(resolveApprovalOverGateway).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: "support", approvalId: request.id }),
      );
      expect(context.updateActivity).toHaveBeenCalledWith(
        expect.objectContaining({ id: entry.activityId }),
      );
      expect(msTeamsApprovalControls.get(token)).toBeNull();
    } finally {
      msTeamsApprovalControls.unregister(entry.actionTokens.map((action) => action.token));
    }
  });

  it("normalizes destinations and preserves thread roots only for channel conversations", async () => {
    const scenario = await createPendingScenario();
    for (const testCase of [
      {
        to: "msteams:conversation:19:channel@thread.tacv2",
        expected: "conversation:19:channel@thread.tacv2;messageid=thread-root",
      },
      {
        to: "conversation:19:channel@thread.tacv2;messageid=existing-root",
        expected: "conversation:19:channel@thread.tacv2;messageid=existing-root",
      },
      { to: "conversation:19:group@thread.v2", expected: "conversation:19:group@thread.v2" },
      {
        to: "user:00000000-0000-4000-8000-000000000001",
        expected: "user:00000000-0000-4000-8000-000000000001",
      },
    ]) {
      const prepared = await msTeamsApprovalNativeRuntime.transport.prepareTarget({
        ...scenario,
        plannedTarget: {
          surface: "origin",
          target: { to: testCase.to, threadId: "thread-root" },
          reason: "preferred",
        },
      });
      expect(prepared?.target.to).toBe(testCase.expected);
    }
  });

  it("delivers and binds pending cards, then replaces resolved cards without actions", async () => {
    const scenario = await deliverScenario();
    const { view, request, pendingPayload } = scenario;
    expect(sendAdaptiveCardMSTeams).toHaveBeenCalledWith({
      cfg,
      accountId: "default",
      to: "conversation:19:channel@thread.tacv2;messageid=thread-root",
      card: pendingPayload.card,
    });

    const binding = await bindScenario(scenario);
    expect(binding).toHaveLength(2);
    for (const [index, token] of binding.entries()) {
      expect(msTeamsApprovalControls.get(token)).toEqual({
        token,
        accountId: "default",
        approvalId: "exec-approval-1",
        approvalKind: "exec",
        decision: pendingPayload.actionTokens[index]?.decision,
        allowedDecisions: ["allow-once", "deny"],
        conversationId: "19:channel@thread.tacv2",
        activityId: "approval-activity-1",
        expiresAtMs: view.expiresAtMs,
      });
    }

    const final = await msTeamsApprovalNativeRuntime.presentation.buildResolvedResult({
      ...scenario,
      resolved: {
        id: request.id,
        decision: "allow-once",
        resolvedBy: "00000000-0000-4000-8000-000000000001",
        ts: Date.now(),
      },
      view: {
        ...view,
        phase: "resolved",
        decision: "allow-once",
        resolvedBy: "00000000-0000-4000-8000-000000000001",
      },
    });
    if (final.kind !== "update") {
      throw new Error("Expected resolved Microsoft Teams approval card update");
    }
    await msTeamsApprovalNativeRuntime.transport.updateEntry?.({
      ...scenario,
      payload: final.payload,
      phase: "resolved",
    });
    expect(editAdaptiveCardMSTeams).toHaveBeenCalledWith({
      cfg,
      accountId: "default",
      to: "19:channel@thread.tacv2",
      activityId: "approval-activity-1",
      card: final.payload,
    });
    expect(JSON.stringify(final.payload)).toContain("Allowed once");
    expect(final.payload).not.toHaveProperty("actions");

    await msTeamsApprovalNativeRuntime.interactions?.unbindPending?.({
      ...scenario,
      binding,
    });
    for (const token of binding) {
      expect(msTeamsApprovalControls.get(token)).toBeNull();
    }
  });

  it("preserves a named account through delivery, update, and fallback", async () => {
    sendMessageMSTeams.mockResolvedValue({
      messageId: "fallback-1",
      conversationId: "19:channel@thread.tacv2",
    });
    const scenario = await deliverScenario(createExecPendingView(), "support");
    const { entry } = scenario;
    expect(entry.accountId).toBe("support");
    expect(sendAdaptiveCardMSTeams).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "support" }),
    );
    await msTeamsApprovalNativeRuntime.transport.updateEntry?.({
      ...scenario,
      payload: { type: "AdaptiveCard" },
      phase: "resolved",
    });
    expect(editAdaptiveCardMSTeams).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "support" }),
    );

    msTeamsApprovalNativeRuntime.observe?.onDeliveryError?.({
      ...scenario,
      error: new Error("card send failed"),
    });
    await vi.waitFor(() => expect(sendMessageMSTeams).toHaveBeenCalledTimes(1));
    expect(sendMessageMSTeams).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "support",
        to: "msteams:conversation:19:channel@thread.tacv2",
        text: expect.stringContaining("/approve exec-approval-1 <allow-once|deny>"),
      }),
    );
  });

  it.each(["unknown"])("rejects an unaddressable approval activity id: %s", async (messageId) => {
    sendAdaptiveCardMSTeams.mockResolvedValue({
      messageId,
      conversationId: "19:channel@thread.tacv2",
    });
    const scenario = await createPendingScenario();

    await expect(
      msTeamsApprovalNativeRuntime.transport.deliverPending(scenario),
    ).resolves.toBeNull();
    for (const { token } of scenario.pendingPayload.actionTokens) {
      expect(msTeamsApprovalControls.get(token)).toBeNull();
    }
  });

  it("replaces expired approvals without actions and releases canceled deliveries", async () => {
    const scenario = await deliverScenario(createPluginPendingView());
    const binding = await bindScenario(scenario);

    const final = await msTeamsApprovalNativeRuntime.presentation.buildExpiredResult({
      ...scenario,
      view: { ...scenario.view, phase: "expired" },
    });
    if (final.kind !== "update") {
      throw new Error("Expected expired Microsoft Teams approval card update");
    }
    await msTeamsApprovalNativeRuntime.transport.updateEntry?.({
      ...scenario,
      payload: final.payload,
      phase: "expired",
    });
    expect(editAdaptiveCardMSTeams).toHaveBeenCalledWith(
      expect.objectContaining({
        activityId: "approval-activity-1",
        card: final.payload,
      }),
    );
    expect(JSON.stringify(final.payload)).toContain("Plugin Approval Expired");
    expect(final.payload).not.toHaveProperty("actions");

    await msTeamsApprovalNativeRuntime.interactions?.cancelDelivered?.(scenario);
    for (const token of binding) {
      expect(msTeamsApprovalControls.get(token)).toBeNull();
    }
    msTeamsApprovalControls.unregister(binding);
  });
});
