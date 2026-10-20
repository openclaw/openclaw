import type { ApprovalResolveResult } from "openclaw/plugin-sdk/approval-gateway-runtime";
import type { ChannelApprovalKind } from "openclaw/plugin-sdk/approval-handler-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  buildGoogleChatApprovalActionParameters,
  googleChatApprovalControls,
  registerGoogleChatApprovalCardBinding,
  shouldSuppressGoogleChatManualExecApprovalFollowupText,
} from "./approval-card-actions.js";
import { maybeHandleGoogleChatApprovalCardClick } from "./approval-card-click.js";
import { buildGoogleChatCanonicalApprovalTerminalCards } from "./approval-terminal-card.js";
import type { WebhookTarget } from "./monitor-types.js";
import type { GoogleChatEvent } from "./types.js";

const resolveApprovalOverGateway = vi.hoisted(() => vi.fn());
const updateGoogleChatMessage = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/approval-gateway-runtime", () => ({
  resolveApprovalOverGateway,
}));
vi.mock("./api.js", () => ({ updateGoogleChatMessage }));

type ApprovalDecision = "allow-once" | "allow-always" | "deny";
type Resolution = {
  applied: boolean;
  approvalId: string;
  approvalKind?: ChannelApprovalKind;
  decision?: ApprovalDecision;
};

function resolveResult(params: Resolution): ApprovalResolveResult {
  const presentation =
    (params.approvalKind ?? "exec") === "exec"
      ? {
          kind: "exec" as const,
          commandText: `<tag> & &amp; "double" 'single'`,
          commandPreview: null,
          allowedDecisions: ["allow-once" as const, "deny" as const],
        }
      : {
          kind: "plugin" as const,
          title: "Plugin request",
          description: "Allow this plugin action.",
          severity: "info" as const,
          allowedDecisions: ["allow-once" as const, "deny" as const],
        };
  const common = {
    id: params.approvalId,
    urlPath: `/approve/${encodeURIComponent(params.approvalId)}`,
    createdAtMs: 1,
    expiresAtMs: 10_000,
    resolvedAtMs: 2,
    reason: "user" as const,
    presentation,
  };
  return params.decision === "deny"
    ? {
        applied: params.applied,
        approval: { ...common, status: "denied", decision: "deny" },
      }
    : {
        applied: params.applied,
        approval: { ...common, status: "allowed", decision: params.decision ?? "allow-once" },
      };
}

function createTarget(): WebhookTarget {
  const channel = { allowFrom: ["users/123"] };
  return {
    account: {
      accountId: "default",
      enabled: true,
      credentialSource: "inline",
      config: channel,
    },
    config: { channels: { googlechat: channel } },
    runtime: { log: vi.fn(), error: vi.fn() },
    core: {} as never,
    path: "/googlechat",
    mediaMaxMb: 20,
    ingress: { receive: vi.fn(async () => ({ kind: "ignored" as const })) },
  };
}

function createCardClickEvent(token: string, userName = "users/123"): GoogleChatEvent {
  return {
    type: "CARD_CLICKED",
    space: { name: "spaces/AAA" },
    message: { name: "spaces/AAA/messages/msg-1" },
    user: { name: userName },
    action: {
      actionMethodName: "openclaw.approval",
      parameters: buildGoogleChatApprovalActionParameters(token),
    },
  };
}

const tokens: string[] = [];
function registerCardBinding(
  token: string,
  approvalId: string,
  overrides: Partial<Parameters<typeof registerGoogleChatApprovalCardBinding>[0]> = {},
): void {
  tokens.push(token);
  registerGoogleChatApprovalCardBinding({
    token,
    accountId: "default",
    approvalId,
    approvalKind: "exec",
    decision: "allow-once",
    allowedDecisions: ["allow-once", "deny"],
    spaceName: "spaces/AAA",
    messageName: "spaces/AAA/messages/msg-1",
    expiresAtMs: Date.now() + 60_000,
    ...overrides,
  });
}

it.each([
  {
    outcome: { status: "allowed", decision: "allow-once", reason: "user" },
    title: "Exec Approval: Allowed once",
  },
  {
    outcome: { status: "allowed", decision: "allow-always", reason: "user" },
    title: "Exec Approval: Allowed always",
  },
  {
    outcome: { status: "denied", decision: "deny", reason: "user" },
    title: "Exec Approval: Denied",
  },
  {
    outcome: { status: "expired", reason: "timeout" },
    title: "Exec Approval: Expired",
  },
  {
    outcome: { status: "cancelled", reason: "run-aborted" },
    title: "Exec Approval: Cancelled",
  },
] as const)("renders $title from the canonical result", ({ outcome, title }) => {
  const cards = buildGoogleChatCanonicalApprovalTerminalCards({
    applied: false,
    approval: {
      id: "approval-terminal",
      urlPath: "/approve/approval-terminal",
      createdAtMs: 1,
      expiresAtMs: 10_000,
      resolvedAtMs: 2,
      presentation: {
        kind: "exec",
        commandText: "echo approved",
        allowedDecisions: ["allow-once", "allow-always", "deny"],
      },
      ...outcome,
    },
  });

  expect(cards[0]?.card.header?.title).toBe(title);
});

function click(event: GoogleChatEvent | string, target = createTarget()) {
  return maybeHandleGoogleChatApprovalCardClick({
    event: typeof event === "string" ? createCardClickEvent(event) : event,
    target,
  });
}

function commonEvent(
  token: string,
  field: "common" | "commonEventObject",
  invokedFunction = "openclaw.approval",
): GoogleChatEvent {
  return {
    ...createCardClickEvent(token),
    action: undefined,
    [field]: { invokedFunction, parameters: { openclaw_action: "approval", token } },
  };
}

function expectResolved(
  approvalId: string,
  decision: ApprovalDecision,
  approvalKind?: ChannelApprovalKind,
) {
  expect(resolveApprovalOverGateway).toHaveBeenCalledWith(
    expect.objectContaining({
      approvalId,
      decision,
      ...(approvalKind ? { approvalKind } : {}),
    }),
  );
}

function followupSuppressed() {
  return shouldSuppressGoogleChatManualExecApprovalFollowupText(
    "/approve approval-in-flight allow-once",
  );
}

beforeEach(() => {
  resolveApprovalOverGateway
    .mockReset()
    .mockImplementation((params: Omit<Resolution, "applied">) =>
      Promise.resolve(resolveResult({ applied: true, ...params })),
    );
  updateGoogleChatMessage.mockReset().mockResolvedValue({
    messageName: "spaces/AAA/messages/msg-1",
  });
});

afterEach(() => googleChatApprovalControls.unregister(tokens.splice(0)));

it.each([
  ["common", "openclaw.approval", "plugin", "deny"],
  ["commonEventObject", "https://chat-app.example.test/googlechat", "exec", "allow-once"],
] as const)("accepts %s card actions", async (field, action, approvalKind, decision) => {
  registerCardBinding("token-common", "approval-common", { approvalKind, decision });
  await expect(click(commonEvent("token-common", field, action))).resolves.toBe(true);
  expectResolved("approval-common", decision, approvalKind);
});

it("does not consume the token when an unauthorized user clicks", async () => {
  registerCardBinding("token-2", "plugin:approval-2", {
    approvalKind: "plugin",
    decision: "deny",
  });

  await expect(click(createCardClickEvent("token-2", "users/999"))).resolves.toBe(true);

  expect(resolveApprovalOverGateway).not.toHaveBeenCalled();

  await expect(click("token-2")).resolves.toBe(true);

  expectResolved("plugin:approval-2", "deny", "plugin");
});

it("consumes stale card tokens for approval-not-found gateway detail and ignores later clicks", async () => {
  const token = "token-stale-nested";
  const error = Object.assign(new Error("invalid approval request"), {
    gatewayCode: "INVALID_REQUEST",
    details: { reason: "APPROVAL_NOT_FOUND" },
  });
  registerCardBinding(token, "approval-stale");
  resolveApprovalOverGateway.mockRejectedValueOnce(error);
  const target = createTarget();
  const event = createCardClickEvent(token);

  await expect(click(event, target)).resolves.toBe(true);

  expect(googleChatApprovalControls.get(token)).toBeNull();
  expect(target.runtime.log).toHaveBeenCalledWith(
    expect.stringContaining("approval expired or no longer exists"),
  );

  await expect(click(event, target)).resolves.toBe(true);

  expect(resolveApprovalOverGateway).toHaveBeenCalledTimes(1);
  expect(updateGoogleChatMessage).not.toHaveBeenCalled();
  expect(target.runtime.log).toHaveBeenCalledWith(
    expect.stringContaining("unknown or expired card token"),
  );
});

it("keeps concurrent clicks blocked until the terminal card update completes", async () => {
  const token = "token-in-flight";
  registerCardBinding(token, "approval-in-flight");
  const updateStarted = createDeferred<void>();
  const finishUpdate = createDeferred<void>();
  updateGoogleChatMessage.mockImplementationOnce(async () => {
    updateStarted.resolve();
    await finishUpdate.promise;
    return { messageName: "spaces/AAA/messages/msg-1" };
  });
  const target = createTarget();
  const event = createCardClickEvent(token);
  const first = click(event, target);

  try {
    await updateStarted.promise;
    expect(googleChatApprovalControls.get(token)).not.toBeNull();
    expect(followupSuppressed()).toBe(true);
    await expect(click(event, target)).resolves.toBe(true);
    expect(resolveApprovalOverGateway).toHaveBeenCalledTimes(1);
    expect(updateGoogleChatMessage).toHaveBeenCalledTimes(1);
  } finally {
    finishUpdate.resolve();
    await expect(first).resolves.toBe(true);
  }
  expect(googleChatApprovalControls.get(token)).toBeNull();
  expect(followupSuppressed()).toBe(false);
  const card = updateGoogleChatMessage.mock.calls[0]?.[0].cardsV2[0].card;
  expect(card.sections[0].widgets[0].textParagraph.text).toBe(
    `&lt;tag&gt; &amp; &amp;amp; "double" 'single'`,
  );
  expect(JSON.stringify(card)).not.toContain("buttonList");
});

it("keeps the token retryable when the canonical card update fails", async () => {
  registerCardBinding("token-update-retry", "approval-update-retry");
  const approvalId = "approval-update-retry";
  resolveApprovalOverGateway
    .mockResolvedValueOnce(resolveResult({ applied: true, approvalId }))
    .mockResolvedValueOnce(resolveResult({ applied: false, approvalId }));
  updateGoogleChatMessage.mockRejectedValueOnce(new Error("card update failed"));

  await expect(click("token-update-retry")).rejects.toThrow("card update failed");
  await expect(click("token-update-retry")).resolves.toBe(true);

  expect(resolveApprovalOverGateway).toHaveBeenCalledTimes(2);
  expect(updateGoogleChatMessage).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(updateGoogleChatMessage.mock.calls[1]?.[0])).toContain("Already resolved");
});
