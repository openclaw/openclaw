import { buildExecApprovalPendingReplyPayload } from "openclaw/plugin-sdk/approval-reply-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSignalApprovalReactionTargetsForTest,
  resolveSignalApprovalReactionTargetWithPersistence,
} from "./approval-reactions.js";

const sendMocks = vi.hoisted(() => ({
  sendMessageSignal: vi.fn(),
}));

vi.mock("./send.js", async () => {
  const actual = await vi.importActual<typeof import("./send.js")>("./send.js");
  return {
    ...actual,
    sendMessageSignal: sendMocks.sendMessageSignal,
  };
});

const { deliverReplies } = await import("./monitor.js");

const botAccount = "+15550009999";
const approver = "+15551230000";
const cfg = {
  channels: {
    signal: {
      account: botAccount,
      allowFrom: [approver],
    },
  },
  approvals: {
    exec: {
      enabled: true,
      mode: "targets",
      targets: [{ channel: "signal", to: approver }],
    },
  },
} as OpenClawConfig;

async function deliverReplyPayload(payload: ReplyPayload) {
  await deliverReplies({
    cfg,
    replies: [payload],
    target: approver,
    baseUrl: "http://127.0.0.1:8080",
    account: botAccount,
    accountId: "default",
    runtime: { log: vi.fn() } as never,
    maxBytes: 8 * 1024 * 1024,
    textLimit: 4000,
    chunkMode: "length",
  });
}

describe("Signal monitor approval reply delivery", () => {
  beforeEach(() => {
    clearSignalApprovalReactionTargetsForTest();
    sendMocks.sendMessageSignal.mockReset().mockResolvedValue({
      messageId: "1700000000200",
    });
  });

  it("adds reaction hints and registers structured approval replies delivered by the monitor", async () => {
    const payload = buildExecApprovalPendingReplyPayload({
      approvalId: "exec-monitor-structured",
      approvalSlug: "exec-mon",
      allowedDecisions: ["allow-once", "deny"],
      command: "printf monitor",
      host: "gateway",
      agentId: "main",
      sessionKey: "agent:main:signal:direct:+15551230000",
    });

    await deliverReplyPayload(payload);

    const sentText = String(sendMocks.sendMessageSignal.mock.calls[0]?.[1] ?? "");
    expect(sentText).toContain("React with:\n\n👍 Allow Once\n👎 Deny");
    await expect(
      resolveSignalApprovalReactionTargetWithPersistence({
        accountId: "default",
        conversationKey: approver,
        messageId: "1700000000200",
        reactionKey: "👍",
        targetAuthor: botAccount,
      }),
    ).resolves.toEqual({
      approvalId: "exec-monitor-structured",
      approvalKind: "exec",
      decision: "allow-once",
      route: {
        deliveryMode: "target",
        to: approver,
        accountId: "default",
        agentId: "main",
        sessionKey: "agent:main:signal:direct:+15551230000",
      },
    });
  });

  it("does not bind ordinary monitor replies that quote approval commands", async () => {
    const payload = {
      text: [
        "The docs show this example:",
        "Exec approval required",
        "ID: exec-monitor-quoted",
        "",
        "Reply with: /approve exec-monitor-quoted allow-once|deny",
      ].join("\n"),
    };

    await deliverReplyPayload(payload);

    const sentText = String(sendMocks.sendMessageSignal.mock.calls[0]?.[1] ?? "");
    expect(sentText).not.toContain("React with:");
    await expect(
      resolveSignalApprovalReactionTargetWithPersistence({
        accountId: "default",
        conversationKey: approver,
        messageId: "1700000000200",
        reactionKey: "👍",
        targetAuthor: botAccount,
      }),
    ).resolves.toBeNull();
  });
});
