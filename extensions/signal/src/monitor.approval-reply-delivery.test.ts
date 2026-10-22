import { buildExecApprovalPendingReplyPayload } from "openclaw/plugin-sdk/approval-reply-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSignalApprovalReactionTargetWithPersistence } from "./approval-reactions.js";

const reactionStores = vi.hoisted(() => new Set<{ clearForTest(): void }>());

vi.mock("openclaw/plugin-sdk/approval-reaction-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/approval-reaction-runtime")>();
  return {
    ...actual,
    createApprovalReactionTargetStore: <TTarget>(
      params: Parameters<typeof actual.createApprovalReactionTargetStore<TTarget>>[0],
    ) => {
      const store = actual.createApprovalReactionTargetStore<TTarget>(params);
      if (params.namespace === "signal.approval-reactions.v2") {
        reactionStores.add(store);
      }
      return store;
    },
  };
});

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
  channels: { signal: { account: botAccount, allowFrom: [approver] } },
  approvals: {
    exec: {
      enabled: true,
      mode: "targets",
      targets: [{ channel: "signal", to: approver }],
    },
  },
} as OpenClawConfig;

async function deliverReplyPayload(
  payload: ReplyPayload,
  options: {
    config?: OpenClawConfig;
    account?: string;
    accountUuid?: string;
  } = {},
) {
  await deliverReplies({
    cfg: options.config ?? cfg,
    replies: [payload],
    target: approver,
    baseUrl: "http://127.0.0.1:8080",
    account: Object.hasOwn(options, "account") ? options.account : botAccount,
    accountUuid: options.accountUuid,
    accountId: "default",
    runtime: { log: vi.fn() } as never,
    maxBytes: 8 * 1024 * 1024,
    textLimit: 4000,
    chunkMode: "length",
  });
}

function resolveReaction(author: { targetAuthor?: string; targetAuthorUuid?: string }) {
  return resolveSignalApprovalReactionTargetWithPersistence({
    accountId: "default",
    conversationKey: approver,
    messageId: "1700000000200",
    reactionKey: "👍",
    ...author,
  });
}

const sentText = () => String(sendMocks.sendMessageSignal.mock.calls[0]?.[1] ?? "");

describe("Signal monitor reply delivery", () => {
  beforeEach(() => {
    reactionStores.forEach((store) => store.clearForTest());
    sendMocks.sendMessageSignal.mockReset().mockResolvedValue({
      messageId: "1700000000200",
    });
  });

  it("preserves ordinary control-only presentation fallback text", async () => {
    await deliverReplyPayload({
      presentation: {
        blocks: [
          {
            type: "buttons",
            buttons: [{ label: "Retry", action: { type: "command", command: "/retry" } }],
          },
          {
            type: "select",
            placeholder: "Choose",
            options: [{ label: "Later", action: { type: "callback", value: "later" } }],
          },
        ],
      },
    });

    expect(sendMocks.sendMessageSignal).toHaveBeenCalledTimes(1);
    expect(sentText()).toBe("- Retry: `/retry`\n\nChoose:\n- Later");
  });

  it("materializes mixed approvals and binds their reactions for UUID-only accounts", async () => {
    const payload = buildExecApprovalPendingReplyPayload({
      approvalId: "exec-monitor-mixed",
      approvalSlug: "exec-monitor-mixed",
      allowedDecisions: ["allow-once", "deny"],
      command: "printf mixed",
      host: "gateway",
      agentId: "main",
      sessionKey: "agent:main:signal:direct:+15551230000",
    });
    payload.presentation = {
      ...payload.presentation!,
      blocks: [
        { type: "context", text: "Deployment audit context" },
        {
          type: "table",
          caption: "Targets",
          headers: ["Host", "State"],
          rows: [
            ["alpha", "ready"],
            ["omega", "waiting"],
          ],
        },
        ...payload.presentation!.blocks,
      ],
    };

    const accountUuid = "123e4567-e89b-12d3-a456-426614174000";
    await deliverReplyPayload(payload, {
      config: {
        channels: { signal: { accounts: { default: { accountUuid, allowFrom: [approver] } } } },
        approvals: cfg.approvals,
      },
      account: undefined,
      accountUuid,
    });

    const text = sentText();
    expect(text).toContain("Deployment audit context");
    expect(text).toContain("- Host: alpha; State: ready");
    expect(text).toContain("- Host: omega; State: waiting");
    expect(text.match(/React with:/g)).toHaveLength(1);
    expect(text.match(/\/approve exec-monitor-mixed allow-once/g)).toHaveLength(1);
    expect(text.match(/\/approve exec-monitor-mixed deny/g)).toHaveLength(1);
    expect(text).not.toMatch(/- Allow Once:|- Deny:/);
    expect(text).toContain("React with:\n\n👍 Allow Once\n👎 Deny");
    await expect(resolveReaction({ targetAuthorUuid: accountUuid })).resolves.toEqual({
      approvalId: "exec-monitor-mixed",
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
    await deliverReplyPayload({
      text: "The docs show this example:\nExec approval required\nID: exec-monitor-quoted\n\nReply with: /approve exec-monitor-quoted allow-once|deny",
    });
    expect(sentText()).not.toContain("React with:");
    await expect(resolveReaction({ targetAuthor: botAccount })).resolves.toBeNull();
  });
});
