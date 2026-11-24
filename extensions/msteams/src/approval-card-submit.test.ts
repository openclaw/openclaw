import type { ApprovalResolveResult } from "openclaw/plugin-sdk/approval-gateway-runtime";
import type { ChannelApprovalKind } from "openclaw/plugin-sdk/approval-handler-runtime";
import type { ExecApprovalDecision } from "openclaw/plugin-sdk/approval-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { msTeamsApprovalControls } from "./approval-card-actions.js";
import { maybeHandleMSTeamsApprovalCardSubmit } from "./approval-card-submit.js";
import { createMSTeamsMessageHandlerDeps } from "./monitor-handler.test-helpers.js";
import type { MSTeamsMessageHandlerDeps } from "./monitor-handler.types.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";

const resolveApprovalOverGateway = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/approval-gateway-runtime", () => ({
  resolveApprovalOverGateway,
}));

const APPROVER_ID = "11111111-2222-4333-8444-555555555555";
const UNAUTHORIZED_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const CONVERSATION_ID = "19:approval-chat";
const ACTIVITY_ID = "card-activity";
const testTokens = new Set<string>();
let deps: MSTeamsMessageHandlerDeps;

function createResolution(params: {
  approvalId: string;
  approvalKind?: ChannelApprovalKind;
  decision?: ExecApprovalDecision;
  applied?: boolean;
}): ApprovalResolveResult {
  const decision = params.decision ?? "allow-once";
  const common = {
    id: params.approvalId,
    urlPath: `/approve/${params.approvalId}`,
    createdAtMs: 1,
    expiresAtMs: 10_000,
    resolvedAtMs: 2,
    reason: "user" as const,
    presentation:
      params.approvalKind === "plugin"
        ? {
            kind: "plugin" as const,
            title: "Plugin request",
            description: "Allow the plugin action.",
            severity: "info" as const,
            allowedDecisions: ["allow-once" as const, "deny" as const],
          }
        : {
            kind: "exec" as const,
            commandText: "echo approved",
            allowedDecisions: ["allow-once" as const, "deny" as const],
          },
  };
  return {
    applied: params.applied ?? true,
    approval:
      decision === "deny"
        ? { ...common, status: "denied", decision: "deny" }
        : { ...common, status: "allowed", decision },
  };
}

function submit(context: MSTeamsTurnContext) {
  return maybeHandleMSTeamsApprovalCardSubmit({ context, deps });
}

function createContext(params: {
  token?: string;
  senderId?: string;
  conversationId?: string;
  replyToId?: string;
  nested?: boolean;
  value?: unknown;
}): MSTeamsTurnContext {
  const value = { openclawAction: "approval", token: params.token };
  return {
    activity: {
      type: "message",
      from: { aadObjectId: params.senderId ?? APPROVER_ID },
      conversation: { id: params.conversationId ?? CONVERSATION_ID },
      ...(params.replyToId ? { replyToId: params.replyToId } : {}),
      value:
        params.value ??
        (params.nested ? { action: { type: "Action.Submit", data: value } } : value),
    },
    sendActivity: vi.fn(async () => undefined),
    updateActivity: vi.fn(async () => ({ id: ACTIVITY_ID })),
  };
}

function registerBinding(
  token: string,
  overrides: Partial<
    Pick<Parameters<typeof msTeamsApprovalControls.register>[0], "approvalKind" | "decision">
  > = {},
) {
  testTokens.add(token);
  msTeamsApprovalControls.register({
    token,
    accountId: "default",
    approvalId: `approval-${token}`,
    approvalKind: "exec",
    decision: "allow-once",
    allowedDecisions: ["allow-once", "deny"],
    conversationId: CONVERSATION_ID,
    activityId: ACTIVITY_ID,
    expiresAtMs: Date.now() + 60_000,
    ...overrides,
  });
  return { token, context: createContext({ token }) };
}

beforeEach(() => {
  deps = createMSTeamsMessageHandlerDeps({
    cfg: { channels: { msteams: { allowFrom: [APPROVER_ID] } } },
  });
  resolveApprovalOverGateway
    .mockReset()
    .mockImplementation(async (params: Parameters<typeof createResolution>[0]) =>
      createResolution(params),
    );
});

afterEach(() => {
  msTeamsApprovalControls.unregister(Array.from(testTokens));
  testTokens.clear();
});

it.each([
  [{ intent: "deploy", environment: "prod" }, false],
  [{ openclawAction: "approval" }, true],
] as const)("dispatches tokenless submit %j (handled=%s)", async (value, handled) => {
  await expect(submit(createContext({ value }))).resolves.toBe(handled);
  expect(resolveApprovalOverGateway).not.toHaveBeenCalled();
});

it.each([
  ["conversation", { conversationId: "19:another-conversation" }, {}],
  ["activity", { replyToId: "another-activity" }, {}],
  ["decision", {}, { decision: "allow-always" }],
] as const)("%s mismatch preserves the token", async (label, context, binding) => {
  const { token } = registerBinding(`mismatch-${label}`, binding);

  await expect(submit(createContext({ token, ...context }))).resolves.toBe(true);

  expect(resolveApprovalOverGateway).not.toHaveBeenCalled();
  expect(msTeamsApprovalControls.get(token)).not.toBeNull();
});

it("requires an allowlisted AAD identity and preserves tokens for the authorized approver", async () => {
  const { token } = registerBinding("authorization", {
    approvalKind: "plugin",
    decision: "deny",
  });
  await expect(submit(createContext({ token, senderId: UNAUTHORIZED_ID }))).resolves.toBe(true);
  expect(resolveApprovalOverGateway).not.toHaveBeenCalled();

  const authorizedContext = createContext({ token, nested: true });
  await expect(submit(authorizedContext)).resolves.toBe(true);

  expect(resolveApprovalOverGateway).toHaveBeenCalledWith({
    cfg: deps.cfg,
    approvalId: `approval-${token}`,
    approvalKind: "plugin",
    decision: "deny",
    channel: "msteams",
    accountId: "default",
    senderId: APPROVER_ID,
  });
  expect(authorizedContext.updateActivity).toHaveBeenCalledWith({
    type: "message",
    id: ACTIVITY_ID,
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: expect.objectContaining({ type: "AdaptiveCard" }),
      },
    ],
  });
  expect(JSON.stringify(vi.mocked(authorizedContext.updateActivity).mock.calls[0])).toContain(
    "Denied",
  );
  expect(msTeamsApprovalControls.get(token)).toBeNull();
});

it("allows only one gateway resolution while simultaneous clicks are in flight", async () => {
  const { token } = registerBinding("in-flight");
  const deferred = createDeferred<ApprovalResolveResult>();
  resolveApprovalOverGateway.mockReturnValueOnce(deferred.promise);
  const first = submit(createContext({ token }));

  await expect(submit(createContext({ token }))).resolves.toBe(true);
  expect(resolveApprovalOverGateway).toHaveBeenCalledTimes(1);

  deferred.resolve(createResolution({ approvalId: `approval-${token}` }));
  await expect(first).resolves.toBe(true);
});

it.each(["gateway", "update"] as const)("retries a failed %s settlement", async (stage) => {
  const { token, context: first } = registerBinding(`${stage}-retry`);
  const error = new Error(`${stage} failed`);
  if (stage === "gateway") {
    resolveApprovalOverGateway.mockRejectedValueOnce(error);
  } else {
    resolveApprovalOverGateway.mockResolvedValue(
      createResolution({ approvalId: `approval-${token}`, decision: "deny", applied: false }),
    );
    vi.mocked(first.updateActivity).mockRejectedValueOnce(error);
  }
  await expect(submit(first)).rejects.toThrow(error.message);
  const retried = createContext({ token });
  await expect(submit(retried)).resolves.toBe(true);

  expect(resolveApprovalOverGateway).toHaveBeenCalledTimes(2);
  if (stage === "update") {
    const cardJson = JSON.stringify(vi.mocked(retried.updateActivity).mock.calls[0]?.[0]);
    expect(cardJson).toContain("Exec Approval: Denied");
    expect(cardJson).toContain("Already resolved");
    expect(cardJson).not.toContain("Exec Approval: Allowed once");
  }
  expect(msTeamsApprovalControls.get(token)).toBeNull();
});

it("retires permanently missing approvals and ignores subsequent clicks", async () => {
  const { token, context } = registerBinding("not-found");
  resolveApprovalOverGateway.mockRejectedValueOnce(
    Object.assign(new Error("approval no longer exists"), {
      gatewayCode: "APPROVAL_NOT_FOUND",
    }),
  );

  await expect(submit(context)).resolves.toBe(true);
  expect(msTeamsApprovalControls.get(token)).toBeNull();
  expect(context.updateActivity).not.toHaveBeenCalled();

  await expect(submit(context)).resolves.toBe(true);
  expect(resolveApprovalOverGateway).toHaveBeenCalledTimes(1);
});
