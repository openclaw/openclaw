import type {
  ExecApprovalPendingView,
  ResolvedApprovalView,
} from "openclaw/plugin-sdk/approval-handler-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, expect, it, vi } from "vitest";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import {
  shouldSuppressGoogleChatManualExecApprovalFollowupText,
  unregisterGoogleChatManualApprovalFollowupSuppression,
} from "./approval-card-actions.js";

const sendGoogleChatMessage = vi.hoisted(() => vi.fn());
const updateGoogleChatMessage = vi.hoisted(() => vi.fn());

vi.mock("./api.js", async () => {
  const actual = await vi.importActual<typeof import("./api.js")>("./api.js");
  return {
    ...actual,
    sendGoogleChatMessage,
    updateGoogleChatMessage,
  };
});

const { googleChatApprovalNativeRuntime } = await import("./approval-handler.runtime.js");

beforeEach(() => {
  vi.clearAllMocks();
  unregisterGoogleChatManualApprovalFollowupSuppression("approval-1");
});

const account = {
  accountId: "default",
  enabled: true,
  credentialSource: "inline",
  config: {
    audienceType: "app-url",
    audience: "https://chat-app.example.test/googlechat",
    appPrincipal: "123456789012345678901",
  },
} as ResolvedGoogleChatAccount;

const cfg: OpenClawConfig = {
  channels: {
    googlechat: { ...account.config, allowFrom: ["users/123"] },
  },
};

const handlerContext = { cfg, accountId: "default", context: { account } };

function createPendingView(): ExecApprovalPendingView {
  return {
    approvalId: "approval-1",
    approvalKind: "exec",
    phase: "pending",
    title: "Exec Approval Required",
    description: "A command needs your approval.",
    metadata: [{ label: "Agent", value: "main" }],
    ask: "on-miss",
    agentId: "main",
    warningText: null,
    commandAnalysis: null,
    commandText: `<tag> & &amp; "double" 'single'`,
    commandPreview: null,
    cwd: "/tmp",
    envKeys: [],
    host: "gateway",
    nodeId: null,
    sessionKey: "agent:main:googlechat:spaces/AAA",
    actions: (
      [
        ["allow-once", "Allow Once", "success"],
        ["deny", "Deny", "danger"],
      ] as const
    ).map(([decision, label, style]) => ({
      kind: "decision",
      decision,
      label,
      style,
      command: `/approve approval-1 ${decision}`,
      action: { type: "approval", approvalId: "approval-1", approvalKind: "exec", decision },
    })),
    expiresAtMs: Date.now() + 60_000,
  };
}

type CardPayloadWithTextWidgets = {
  cardsV2: Array<{
    card: {
      sections?: Array<{
        header?: string;
        widgets?: Array<{ textParagraph?: { text: string } }>;
      }>;
    };
  }>;
};

function getTextParagraphText(payload: unknown, header: string): string {
  const text = (payload as CardPayloadWithTextWidgets).cardsV2[0]?.card.sections?.find(
    (section) => section.header === header,
  )?.widgets?.[0]?.textParagraph?.text;
  if (typeof text !== "string") {
    throw new Error(`Expected ${header} text paragraph`);
  }
  return text;
}

function followupSuppressed(text = "Please reply with:\n`/approve approval-1 allow-once`") {
  return shouldSuppressGoogleChatManualExecApprovalFollowupText(text);
}

async function preparePendingDelivery(view = createPendingView(), context = handlerContext) {
  const nowMs = Date.now();
  const request = {
    id: view.approvalId,
    request: { command: view.commandText },
    createdAtMs: nowMs,
    expiresAtMs: view.expiresAtMs,
  };
  const params = { ...context, request, approvalKind: "exec" as const, view };
  const pendingPayload = await googleChatApprovalNativeRuntime.presentation.buildPendingPayload({
    ...params,
    nowMs,
  });
  const plannedTarget = {
    surface: "origin" as const,
    target: { to: "spaces/AAA", threadId: "threads/T1" },
    reason: "preferred" as const,
  };
  const prepared = await googleChatApprovalNativeRuntime.transport.prepareTarget({
    ...params,
    plannedTarget,
    pendingPayload,
  });
  if (!prepared) {
    throw new Error("Expected prepared target");
  }
  const deliver = () =>
    googleChatApprovalNativeRuntime.transport.deliverPending({
      ...params,
      plannedTarget,
      preparedTarget: prepared.target,
      pendingPayload,
    });
  return { pendingPayload, request, view, deliver };
}

it("keeps truncated pending command card text UTF-16 well formed", async () => {
  const view = createPendingView();
  view.commandText = `${"a".repeat(1796)}😀${"b".repeat(100)}`;

  const { pendingPayload } = await preparePendingDelivery(view);
  const commandText = getTextParagraphText(pendingPayload, "Command");

  expect(commandText.length).toBeLessThanOrEqual(1800);
  expect(commandText.endsWith("...")).toBe(true);
  expect(commandText.isWellFormed()).toBe(true);
  expect(JSON.stringify(pendingPayload.cardsV2)).not.toContain("\\ud83d");
});

it("sends pending cards and updates the delivered message without buttons", async () => {
  sendGoogleChatMessage.mockResolvedValue({ messageName: "spaces/AAA/messages/msg-1" });
  updateGoogleChatMessage.mockResolvedValue({ messageName: "spaces/AAA/messages/msg-1" });

  const { pendingPayload, request, view, deliver } = await preparePendingDelivery();

  expect(JSON.stringify(pendingPayload)).toContain("cardsV2");
  const commandText = getTextParagraphText(pendingPayload, "Command");
  expect(commandText).toBe(`&lt;tag&gt; &amp; &amp;amp; "double" 'single'`);
  expect(JSON.stringify(pendingPayload.cardsV2)).toContain(
    "https://chat-app.example.test/googlechat",
  );
  expect(JSON.stringify(pendingPayload.cardsV2)).not.toContain("/approve approval-1 allow-once");

  const entry = await deliver();

  expect(sendGoogleChatMessage).toHaveBeenCalledWith({
    account,
    space: "spaces/AAA",
    cardsV2: expect.any(Array),
    thread: "threads/T1",
  });
  expect(sendGoogleChatMessage.mock.calls[0]?.[0]).not.toHaveProperty("text");
  expect(entry).toEqual({
    accountId: "default",
    spaceName: "spaces/AAA",
    messageName: "spaces/AAA/messages/msg-1",
    threadName: "threads/T1",
    actionTokens: expect.any(Array),
  });
  expect(followupSuppressed("Please reply with:\n/approve approval-1 allow-once")).toBe(true);

  const resolvedView: ResolvedApprovalView = {
    ...view,
    phase: "resolved",
    decision: "allow-once",
    resolvedBy: "users/123",
  };
  const final = await googleChatApprovalNativeRuntime.presentation.buildResolvedResult({
    ...handlerContext,
    request,
    resolved: {
      id: "approval-1",
      decision: "allow-once",
      resolvedBy: "users/123",
      ts: Date.now(),
    },
    view: resolvedView,
    entry,
  });
  expect(final.kind).toBe("update");
  if (final.kind !== "update" || !entry) {
    throw new Error("Expected update result and entry");
  }
  await googleChatApprovalNativeRuntime.transport.updateEntry?.({
    ...handlerContext,
    entry,
    request,
    approvalKind: "exec",
    payload: final.payload,
    phase: "resolved",
  });

  expect(updateGoogleChatMessage).toHaveBeenCalledWith({
    account,
    messageName: "spaces/AAA/messages/msg-1",
    cardsV2: expect.any(Array),
  });
  expect(updateGoogleChatMessage.mock.calls[0]?.[0]).not.toHaveProperty("text");
  expect(JSON.stringify(final.payload)).not.toContain("buttonList");
});

it("suppresses manual approval follow-ups while the native card send is in flight", async () => {
  const deferred = createDeferred<{ messageName: string }>();
  sendGoogleChatMessage.mockReturnValue(deferred.promise);
  const { deliver } = await preparePendingDelivery();
  const deliveryPromise = deliver();

  await vi.waitFor(() => expect(sendGoogleChatMessage).toHaveBeenCalled());
  expect(followupSuppressed()).toBe(true);

  deferred.resolve({ messageName: "spaces/AAA/messages/msg-1" });
  await expect(deliveryPromise).resolves.toEqual(
    expect.objectContaining({ messageName: "spaces/AAA/messages/msg-1" }),
  );
});

it("restores manual approval follow-ups when the native card send fails", async () => {
  sendGoogleChatMessage.mockRejectedValue(new Error("send failed"));
  const { deliver } = await preparePendingDelivery();
  await expect(deliver()).rejects.toThrow("send failed");
  expect(followupSuppressed()).toBe(false);
});

it("uses the named Chat action when app-url add-on principal binding is absent", async () => {
  const { appPrincipal: _principal, ...accountConfig } = account.config;
  const { appPrincipal: _cfgPrincipal, ...channelConfig } = cfg.channels!.googlechat!;
  const { pendingPayload } = await preparePendingDelivery(createPendingView(), {
    ...handlerContext,
    cfg: { channels: { googlechat: channelConfig } },
    context: {
      account: { ...account, config: accountConfig },
    },
  });

  expect(JSON.stringify(pendingPayload.cardsV2)).toContain("openclaw.approval");
  expect(JSON.stringify(pendingPayload.cardsV2)).not.toContain(
    "https://chat-app.example.test/googlechat",
  );
});
