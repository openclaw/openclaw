import type {
  PendingApprovalView,
  ResolvedApprovalView,
} from "openclaw/plugin-sdk/approval-handler-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";
import type { ResolvedGoogleChatAccount } from "./accounts.js";

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

const account = {
  accountId: "default",
  enabled: true,
  credentialSource: "inline",
  config: {
    audienceType: "app-url",
    audience: "https://chat-app.example.test/googlechat",
  },
} as ResolvedGoogleChatAccount;

const cfg: OpenClawConfig = {
  channels: {
    googlechat: {
      serviceAccount: {
        type: "service_account",
        client_email: "bot@example.com",
        private_key: "test-key",
        token_uri: "https://oauth2.googleapis.com/token",
      },
      audienceType: "app-url",
      audience: "https://chat-app.example.test/googlechat",
      dm: { allowFrom: ["users/123"] },
    },
  },
};

function createPendingView(): PendingApprovalView {
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
    commandText: "echo hi",
    commandPreview: null,
    cwd: "/tmp",
    envKeys: [],
    host: "gateway",
    nodeId: null,
    sessionKey: "agent:main:googlechat:spaces/AAA",
    actions: [
      {
        kind: "decision",
        decision: "allow-once",
        label: "Allow Once",
        style: "success",
        command: "/approve approval-1 allow-once",
      },
      {
        kind: "decision",
        decision: "deny",
        label: "Deny",
        style: "danger",
        command: "/approve approval-1 deny",
      },
    ],
    expiresAtMs: Date.now() + 60_000,
  };
}

describe("googleChatApprovalNativeRuntime", () => {
  it("sends pending cards and updates the delivered message without buttons", async () => {
    sendGoogleChatMessage.mockResolvedValue({ messageName: "spaces/AAA/messages/msg-1" });
    updateGoogleChatMessage.mockResolvedValue({ messageName: "spaces/AAA/messages/msg-1" });

    const view = createPendingView();
    const pendingPayload = await googleChatApprovalNativeRuntime.presentation.buildPendingPayload({
      cfg,
      accountId: "default",
      context: { account },
      request: {
        id: "approval-1",
        request: { command: "echo hi" },
        createdAtMs: Date.now(),
        expiresAtMs: view.expiresAtMs,
      },
      approvalKind: "exec",
      nowMs: Date.now(),
      view,
    });

    expect(JSON.stringify(pendingPayload)).toContain("cardsV2");
    expect(JSON.stringify(pendingPayload.cardsV2)).toContain(
      "https://chat-app.example.test/googlechat",
    );
    expect(JSON.stringify(pendingPayload.cardsV2)).not.toContain("/approve approval-1 allow-once");

    const prepared = await googleChatApprovalNativeRuntime.transport.prepareTarget({
      cfg,
      accountId: "default",
      context: { account },
      plannedTarget: {
        surface: "origin",
        target: { to: "spaces/AAA", threadId: "threads/T1" },
        reason: "preferred",
      },
      request: {
        id: "approval-1",
        request: { command: "echo hi" },
        createdAtMs: Date.now(),
        expiresAtMs: view.expiresAtMs,
      },
      approvalKind: "exec",
      view,
      pendingPayload,
    });
    if (!prepared) {
      throw new Error("Expected prepared target");
    }
    const entry = await googleChatApprovalNativeRuntime.transport.deliverPending({
      cfg,
      accountId: "default",
      context: { account },
      plannedTarget: {
        surface: "origin",
        target: { to: "spaces/AAA", threadId: "threads/T1" },
        reason: "preferred",
      },
      preparedTarget: prepared.target,
      request: {
        id: "approval-1",
        request: { command: "echo hi" },
        createdAtMs: Date.now(),
        expiresAtMs: view.expiresAtMs,
      },
      approvalKind: "exec",
      view,
      pendingPayload,
    });

    expect(sendGoogleChatMessage).toHaveBeenCalledWith({
      account,
      space: "spaces/AAA",
      text: expect.stringContaining("Reply with: /approve approval-1 allow-once|deny"),
      cardsV2: expect.any(Array),
      thread: "threads/T1",
    });
    expect(entry).toEqual({
      accountId: "default",
      spaceName: "spaces/AAA",
      messageName: "spaces/AAA/messages/msg-1",
      threadName: "threads/T1",
      actionTokens: expect.any(Array),
    });

    const resolvedView: ResolvedApprovalView = {
      ...view,
      phase: "resolved",
      decision: "allow-once",
      resolvedBy: "users/123",
    };
    const final = await googleChatApprovalNativeRuntime.presentation.buildResolvedResult({
      cfg,
      accountId: "default",
      context: { account },
      request: {
        id: "approval-1",
        request: { command: "echo hi" },
        createdAtMs: Date.now(),
        expiresAtMs: view.expiresAtMs,
      },
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
      cfg,
      accountId: "default",
      context: { account },
      entry,
      payload: final.payload,
      phase: "resolved",
    });

    expect(updateGoogleChatMessage).toHaveBeenCalledWith({
      account,
      messageName: "spaces/AAA/messages/msg-1",
      text: expect.stringContaining("approval allowed once"),
      cardsV2: expect.any(Array),
    });
    expect(JSON.stringify(final.payload)).not.toContain("buttonList");
  });
});
