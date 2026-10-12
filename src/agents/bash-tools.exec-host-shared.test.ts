import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import * as logger from "../logger.js";
import {
  claimExecApprovalFollowupRuntimeHandoff,
  finalizeExecApprovalFollowupRuntimeHandoff,
  registerExecApprovalFollowupRuntimeHandoff,
} from "./bash-tools.exec-approval-followup-state.js";
import type { sendExecApprovalFollowup as sendFollowup } from "./bash-tools.exec-approval-followup.js";
import {
  buildExecApprovalPendingToolResult,
  buildHeadlessExecApprovalDeniedMessage,
  createExecApprovalRequestRoute,
  resolveExecApprovalWaitOutcome,
  resolveExecHostApprovalContext,
  sendExecApprovalFollowupResult,
} from "./bash-tools.exec-host-shared.js";

const mocks = vi.hoisted(() => {
  function approvals(security = "allowlist", ask = "off", askFallback = "deny") {
    const policy = { security, ask, askFallback, autoAllowSkills: false };
    return {
      defaults: policy,
      agent: { ...policy },
      allowlist: [],
      file: { version: 1, agents: {} },
      hash: "approvals-hash",
    };
  }
  return {
    approvals,
    followupImports: 0,
    sendExecApprovalFollowup: vi.fn<typeof sendFollowup>(),
    resolveExecApprovals: vi.fn(async () => approvals()),
    approvalRunAbortedError: new Error("approval owning run aborted"),
    resolveRegisteredExecApprovalDecision: vi.fn(async (): Promise<string | null> => "allow-once"),
  };
});

vi.mock("./bash-tools.exec-approval-followup.js", () => {
  mocks.followupImports += 1;
  return { sendExecApprovalFollowup: mocks.sendExecApprovalFollowup };
});
vi.mock("../infra/exec-approvals.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/exec-approvals.js")>()),
  resolveExecApprovalsLocked: mocks.resolveExecApprovals,
}));
vi.mock("./bash-tools.exec-approval-request.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bash-tools.exec-approval-request.js")>()),
  isExecApprovalRunAbortedError: (error: unknown) => error === mocks.approvalRunAbortedError,
  resolveRegisteredExecApprovalDecision: mocks.resolveRegisteredExecApprovalDecision,
}));

describe("sendExecApprovalFollowupResult", () => {
  const sendExecApprovalFollowup = mocks.sendExecApprovalFollowup;
  const logWarn = vi.fn();
  const sessionKey = "agent:main:telegram:direct:123";
  const bashElevated = { enabled: true, allowed: true, defaultLevel: "on" as const };

  beforeEach(() => {
    sendExecApprovalFollowup.mockReset().mockResolvedValue(true);
    logWarn.mockReset();
    vi.spyOn(logger, "logWarn").mockImplementation(logWarn);
    vi.doMock("./bash-tools.exec-approval-followup.js", () => ({ sendExecApprovalFollowup }));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("./bash-tools.exec-approval-followup.js");
  });

  it("lazily loads delivery and deduplicates import failures", async () => {
    expect(mocks.followupImports).toBe(0);
    const loadDelivery = vi.fn(() => {
      throw new Error("synthetic delivery import failure");
    });
    vi.doMock("./bash-tools.exec-approval-followup.js", loadDelivery);
    try {
      const target = { approvalId: "approval-import-failure" };
      await sendExecApprovalFollowupResult(target, "Exec finished");
      await sendExecApprovalFollowupResult(target, "Exec finished");
      expect(loadDelivery).toHaveBeenCalled();
      expect(logWarn).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining(
          "exec approval followup dispatch failed (id=approval-import-failure):",
        ),
      );
    } finally {
      vi.doUnmock("./bash-tools.exec-approval-followup.js");
    }
  });

  it("suppresses approval-not-found followup dispatch failures", async () => {
    sendExecApprovalFollowup.mockRejectedValue(
      Object.assign(new Error("approval not found"), { gatewayCode: "APPROVAL_NOT_FOUND" }),
    );
    await sendExecApprovalFollowupResult(
      { approvalId: "approval-expired", sessionKey },
      "Exec finished",
    );
    expect(logWarn).not.toHaveBeenCalled();
  });

  it.each([false])(
    "authenticates an elevated=%s result handoff to one session and claimant",
    async (elevated) => {
      const approvalId = `approval-authenticated-${elevated}`;
      await sendExecApprovalFollowupResult(
        {
          approvalId,
          agentId: "research",
          sessionKey,
          expectedSessionId: "session-original",
          turnSourceChannel: "telegram",
          ...(elevated ? { bashElevated } : {}),
        },
        "Exec finished",
      );
      const call = sendExecApprovalFollowup.mock.calls[0]?.[0];
      assert.isDefined(call);
      expect(call).toMatchObject({
        agentId: "research",
        sessionKey,
        expectedSessionId: "session-original",
      });
      expect(call.internalRuntimeHandoffId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(call.idempotencyKey).toMatch(
        new RegExp(`^exec-approval-followup:${approvalId}:nonce:`),
      );
      expect(call.idempotencyKey).not.toContain(call.internalRuntimeHandoffId ?? "");
      expect(call).not.toHaveProperty("bashElevated");
      expect(call).not.toHaveProperty("execApprovalFollowupToken");
      const claim = {
        handoffId: call.internalRuntimeHandoffId,
        approvalId,
        idempotencyKey: call.idempotencyKey,
        sessionKey,
        claimId: "owner-run",
      };
      expect(
        claimExecApprovalFollowupRuntimeHandoff({ ...claim, sessionKey: "wrong-session" }),
      ).toBeUndefined();
      expect(claimExecApprovalFollowupRuntimeHandoff(claim)).toEqual({
        kind: "exec-approval-followup",
        approvalId,
        sessionKey,
        idempotencyKey: call.idempotencyKey,
        ...(elevated ? { bashElevated } : {}),
        resultText: "Exec finished",
      });
      expect(
        claimExecApprovalFollowupRuntimeHandoff({ ...claim, claimId: "competing-run" }),
      ).toBeUndefined();
      expect(finalizeExecApprovalFollowupRuntimeHandoff(claim)).toBe(true);
    },
  );

  it("does not register elevated runtime handoffs when the process clock is invalid", () => {
    expect(
      registerExecApprovalFollowupRuntimeHandoff({
        approvalId: "approval-elevated-invalid-clock",
        sessionKey,
        bashElevated,
        nowMs: Number.NaN,
      }),
    ).toBeUndefined();
  });

  it("does not register elevated runtime handoffs for denied followups", async () => {
    sendExecApprovalFollowup.mockResolvedValue(false);
    await sendExecApprovalFollowupResult(
      { approvalId: "approval-denied", sessionKey, turnSourceChannel: "telegram", bashElevated },
      "Exec denied (gateway id=approval-denied, user-denied): uname -a",
    );
    const call = sendExecApprovalFollowup.mock.calls[0]?.[0];
    assert.isDefined(call);
    expect(call).not.toHaveProperty("internalRuntimeHandoffId");
    expect(call).not.toHaveProperty("idempotencyKey");
    expect(call).not.toHaveProperty("bashElevated");
  });
});

describe("resolveExecHostApprovalContext", () => {
  it("clamps host security, ask mode, and fallback to the stricter caller policy", async () => {
    mocks.resolveExecApprovals.mockResolvedValue(mocks.approvals("full", "off", "full"));
    await expect(
      resolveExecHostApprovalContext({
        agentId: "agent-main",
        security: "allowlist",
        ask: "always",
        host: "gateway",
      }),
    ).resolves.toMatchObject({
      hostSecurity: "allowlist",
      hostAsk: "always",
      askFallback: "allowlist",
    });
  });
});

describe("resolveExecApprovalWaitOutcome", () => {
  const wait = (overrides: Partial<Parameters<typeof resolveExecApprovalWaitOutcome>[0]> = {}) =>
    resolveExecApprovalWaitOutcome({
      approvalId: "approval-wait",
      preResolvedDecision: undefined,
      askFallback: "deny",
      requiresExplicitApproval: false,
      ...overrides,
    });

  beforeEach(() => {
    mocks.resolveRegisteredExecApprovalDecision.mockReset().mockResolvedValue("allow-once");
  });

  it.each([
    ["allow-always", true, null],
    ["deny", false, "user-denied"],
  ] as const)("returns a resolved %s decision", async (decision, approvedByAsk, deniedReason) => {
    mocks.resolveRegisteredExecApprovalDecision.mockResolvedValue(decision);
    await expect(wait()).resolves.toMatchObject({
      kind: "resolved",
      decision,
      state: { approvedByAsk, deniedReason },
    });
  });

  it("applies timeout policy before returning a resolved outcome", async () => {
    mocks.resolveRegisteredExecApprovalDecision.mockResolvedValue(null);
    await expect(
      wait({
        askFallback: "full",
        resolveTimedOut: async () => ({ approvedByAsk: false, deniedReason: "policy-revoked" }),
      }),
    ).resolves.toMatchObject({
      kind: "resolved",
      decision: null,
      state: { approvedByAsk: false, deniedReason: "policy-revoked" },
    });
  });

  it.each([
    [new Error("store unavailable"), "request-failed"],
    [mocks.approvalRunAbortedError, "run-aborted"],
  ])("classifies approval waiter failure %s as %s", async (error, kind) => {
    mocks.resolveRegisteredExecApprovalDecision.mockRejectedValue(error);
    await expect(wait()).resolves.toEqual({ kind });
  });

  it("does not consume a decision after the owning signal aborts", async () => {
    const controller = new AbortController();
    mocks.resolveRegisteredExecApprovalDecision.mockImplementation(async () => {
      controller.abort(new Error("run stopped"));
      return "allow-once";
    });
    await expect(wait({ signal: controller.signal })).resolves.toEqual({ kind: "run-aborted" });
  });
});

describe("createExecApprovalRequestRoute", () => {
  const createRoute = (turnSourceChannel?: string, finalDecision?: null) =>
    createExecApprovalRequestRoute({
      warnings: [],
      approvalRunningNoticeMs: 1_000,
      createApprovalSlug: (approvalId) => approvalId,
      turnSourceChannel,
      register: async (approvalId) => ({ id: approvalId, expiresAtMs: 60_000, finalDecision }),
      askFallback: "full",
      requiresExplicitApproval: true,
    });

  it("denies terminal no-route approvals inline without claiming DM delivery", async () => {
    await expect(createRoute("telegram", null)).resolves.toMatchObject({
      kind: "inline",
      preResolvedDecision: null,
      sentApproverDms: false,
      unavailableReason: "no-approval-route",
      state: { approvedByAsk: false, deniedReason: "approval-timeout" },
    });
  });

  it.each(["webchat"])("keeps waiting without a terminal decision on %s", async (channel) => {
    await expect(createRoute(channel)).resolves.toMatchObject({ kind: "wait" });
  });
});

describe("buildExecApprovalPendingToolResult", () => {
  const buildResult = (
    overrides: Partial<Parameters<typeof buildExecApprovalPendingToolResult>[0]> = {},
  ) =>
    buildExecApprovalPendingToolResult({
      host: "gateway",
      command: "uname -a",
      cwd: "/tmp",
      warningText: "",
      approvalId: "approval-id",
      approvalSlug: "approval-slug",
      expiresAtMs: 60_000,
      initiatingSurface: {
        kind: "disabled",
        channel: "discord",
        channelLabel: "Discord",
        accountId: "default",
      },
      sentApproverDms: false,
      unavailableReason: null,
      ...overrides,
    });

  it("keeps a local /approve prompt when the initiating Discord surface is disabled", () => {
    const result = buildResult({ allowedDecisions: ["allow-once", "deny"] });
    expect(result.details.status).toBe("approval-pending");
    const text = result.content.find((part) => part.type === "text")?.text ?? "";
    expect(text).toContain("/approve approval-slug allow-once");
    expect(text).not.toContain("native chat exec approvals are not configured on Discord");
  });

  it("preserves node metadata in unavailable recovery guidance", () => {
    const result = buildResult({
      host: "node",
      nodeId: "node-mac-1",
      initiatingSurface: { kind: "enabled", channel: undefined, channelLabel: "Web UI" },
      unavailableReason: "no-approval-route",
    });
    expect(result.details).toMatchObject({
      status: "approval-unavailable",
      host: "node",
      nodeId: "node-mac-1",
    });
    const text = result.content.find((part) => part.type === "text")?.text ?? "";
    expect(text).toContain(
      "Print the Control UI URL with `openclaw dashboard --no-open`, open it in a browser, then use the approval inbox.",
    );
    expect(text).toContain(
      "Inspect the node's effective exec policy with `openclaw approvals get --node node-mac-1`.",
    );
  });
});

describe("buildHeadlessExecApprovalDeniedMessage", () => {
  it.each([
    {
      trigger: "cron",
      host: "gateway",
      target: "--gateway",
      label: "Automation",
      surface: "Control UI or a macOS/iOS/Android app",
      standingGrant: true,
    },
    {
      trigger: undefined,
      host: "node",
      target: "--node <id|name|ip>",
      label: "Headless",
      surface: "Control UI or a chat channel with exec approvals",
      standingGrant: false,
    },
  ] as const)(
    "names usable approval surfaces and policy inspection for $label runs",
    ({ trigger, host, target, label, surface, standingGrant }) => {
      const text = buildHeadlessExecApprovalDeniedMessage({
        trigger,
        host,
        security: "allowlist",
        ask: "on-miss",
        askFallback: "deny",
      });
      expect(text).toContain(`${label} runs cannot wait for interactive exec approval`);
      expect(text).toContain('tools.exec.mode="full"');
      expect(text).toContain('host approvals to security="full" and ask="off"');
      expect(text).toContain(`openclaw approvals get ${target}`);
      expect(text).toContain(surface);
      expect(text).not.toContain("both files");
      expect(text).not.toContain("openclaw.sqlite");
      expect(text).not.toContain("TUI");
      expect(text).not.toContain("terminal UI");
      if (standingGrant) {
        expect(text).toContain("standing grant");
      } else {
        expect(text).toContain("rerun interactively");
        expect(text).not.toContain("standing grant");
        expect(text).not.toContain("--gateway");
      }
    },
  );
});
