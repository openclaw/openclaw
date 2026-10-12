// Imessage tests cover approval reactions plugin behavior.
import { buildTypedExecApprovalPendingReplyPayload } from "openclaw/plugin-sdk/approval-reply-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listPendingIMessageApprovalReactionPollTargets } from "./approval-reaction-poll-targets.js";
import {
  addIMessageApprovalReactionHintToStructuredPayload,
  buildIMessageApprovalConversationKeyForTarget,
  clearIMessageApprovalReactionTargetsForTest,
  maybeResolveIMessageApprovalReaction,
  registerIMessageApprovalReactionTargetForDeliveredPayload,
  registerIMessageApprovalReactionTarget as registerIMessageApprovalReactionTargetRaw,
  resolveIMessageApprovalReactionTargetWithPersistence,
} from "./approval-reactions.js";
import type { IMessagePayload } from "./monitor/types.js";

const resolverMocks = vi.hoisted(() => ({
  resolveApprovalOverGateway: vi.fn(),
  isApprovalNotFoundError: vi.fn(() => false),
}));

type IMessageTargetParams = Parameters<typeof registerIMessageApprovalReactionTargetRaw>[0];

function registerIMessageApprovalReactionTarget(
  params: Pick<IMessageTargetParams, "approvalId"> & Partial<IMessageTargetParams>,
) {
  return registerIMessageApprovalReactionTargetRaw({
    ...params,
    accountId: params.accountId ?? "default",
    conversation: params.conversation ?? { handle: "+15551230000" },
    messageId: params.messageId ?? "approval-message",
    allowedDecisions: params.allowedDecisions ?? ["allow-once", "deny"],
    approvalKind: params.approvalKind ?? "exec",
  });
}

vi.mock("openclaw/plugin-sdk/approval-gateway-runtime", () => ({
  resolveApprovalOverGateway: resolverMocks.resolveApprovalOverGateway,
}));
vi.mock("openclaw/plugin-sdk/error-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/error-runtime")>(
    "openclaw/plugin-sdk/error-runtime",
  );
  return {
    ...actual,
    isApprovalNotFoundError: resolverMocks.isApprovalNotFoundError,
  };
});

function buildForwardedApproval(
  approvalKind: "exec" | "plugin",
  approvalId: string,
  approvalSlug: string,
): ReplyPayload {
  const allowedDecisions = ["allow-once", "deny"] as const;
  return {
    text: [
      approvalKind === "exec" ? "🔒 Exec approval required" : "🛡️ Plugin approval required",
      `ID: ${approvalId}`,
      `Reply with: /approve ${approvalId} allow-once|deny`,
    ].join("\n"),
    presentation: {
      blocks: [
        {
          type: "buttons",
          buttons: allowedDecisions.map((decision) => ({
            label: decision === "allow-once" ? "Allow Once" : "Deny",
            action: { type: "approval" as const, approvalId, approvalKind, decision },
          })),
        },
      ],
    },
    channelData: { execApproval: { approvalId, approvalSlug, approvalKind, allowedDecisions } },
  };
}

function requireExecApprovalMetadata(payload: ReplyPayload): Record<string, unknown> {
  const value = payload.channelData?.execApproval;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected exec approval metadata");
  }
  return value as Record<string, unknown>;
}

function buildTapbackReactionPayload(overrides: Partial<IMessagePayload>): IMessagePayload {
  return {
    sender: "+15551230000",
    is_reaction: true,
    reaction_emoji: "👍",
    reacted_to_guid: "msg-1",
    ...overrides,
  } as IMessagePayload;
}

type ReactionParams = Parameters<typeof maybeResolveIMessageApprovalReaction>[0];

function resolveReaction(
  message: IMessagePayload,
  overrides: Partial<Omit<ReactionParams, "message">> = {},
) {
  return maybeResolveIMessageApprovalReaction({
    cfg: { channels: { imessage: { allowFrom: ["+15551230000"] } } },
    accountId: "default",
    bodyText: "",
    message,
    ...overrides,
  });
}

describe("iMessage approval reactions", () => {
  beforeEach(() => {
    clearIMessageApprovalReactionTargetsForTest();
    resolverMocks.resolveApprovalOverGateway.mockReset();
    resolverMocks.resolveApprovalOverGateway.mockImplementation(
      async ({ decision }: { decision: "allow-once" | "allow-always" | "deny" }) => ({
        applied: true,
        approval:
          decision === "deny"
            ? { status: "denied", decision, reason: "user" }
            : { status: "allowed", decision, reason: "user" },
      }),
    );
    resolverMocks.isApprovalNotFoundError.mockReset();
    resolverMocks.isApprovalNotFoundError.mockReturnValue(false);
  });

  it("uses typed metadata to prepare shared forwarded prompts", () => {
    const payload: ReplyPayload = buildForwardedApproval("plugin", "plugin:shared-1", "shared-1");

    const prepared = addIMessageApprovalReactionHintToStructuredPayload({
      payload,
      approvalKind: "plugin",
    });
    expect(prepared?.text).toBe(
      [
        "🛡️ Plugin approval required",
        "ID: plugin:shared-1",
        "",
        "React with:",
        "",
        "👍 Allow Once",
        "👎 Deny",
        "",
        "Reply with: /approve plugin:shared-1 allow-once|deny",
      ].join("\n"),
    );
    expect(prepared?.channelData?.imessageApprovalReactionBindingV1).toEqual({
      version: 1,
      approvalId: "plugin:shared-1",
      approvalSlug: "shared-1",
      approvalKind: "plugin",
      allowedDecisions: ["allow-once", "deny"],
    });
    expect(
      addIMessageApprovalReactionHintToStructuredPayload({
        payload,
        approvalKind: "exec",
      }),
    ).toBeNull();
  });

  it("binds delivered shared prompts from typed metadata and stable GUIDs", async () => {
    const payload = addIMessageApprovalReactionHintToStructuredPayload({
      approvalKind: "exec",
      payload: buildTypedExecApprovalPendingReplyPayload({
        approvalId: "exec-shared-1",
        approvalSlug: "shared-1",
        command: "echo shared",
        host: "gateway",
        allowedDecisions: ["allow-once", "deny"],
      }),
    });
    if (!payload) {
      throw new Error("Expected typed iMessage approval payload");
    }

    expect(
      await registerIMessageApprovalReactionTargetForDeliveredPayload({
        accountId: "default",
        target: { channel: "imessage", to: "+15551230000" },
        payload,
        results: [
          {
            channel: "imessage",
            messageId: "42",
            meta: {
              imessageMessageGuid: "p:0/shared-guid",
              imessageVisibleText: payload.text,
            },
            receipt: {
              primaryPlatformMessageId: "42",
              platformMessageIds: ["42"],
              parts: [{ platformMessageId: "42", kind: "text", index: 0 }],
              sentAt: 1_000,
            },
          },
        ],
      }),
    ).toBe(true);

    await expect(
      resolveIMessageApprovalReactionTargetWithPersistence({
        accountId: "default",
        conversation: { handle: "+15551230000" },
        messageId: "p:0/shared-guid",
        reactionKey: "👎",
      }),
    ).resolves.toEqual({
      approvalId: "exec-shared-1",
      approvalKind: "exec",
      decision: "deny",
    });
    await expect(
      resolveIMessageApprovalReactionTargetWithPersistence({
        accountId: "default",
        conversation: { handle: "+15551230000" },
        messageId: "42",
        reactionKey: "👎",
      }),
    ).resolves.toBeNull();
  });

  it("fails closed when typed metadata and approval actions disagree", () => {
    const buildPayload = () =>
      buildTypedExecApprovalPendingReplyPayload({
        approvalId: "exec-strict-1",
        approvalSlug: "strict-1",
        command: "echo strict",
        host: "gateway",
        allowedDecisions: ["allow-once", "deny"],
      });
    const missingKind = buildPayload();
    delete requireExecApprovalMetadata(missingKind).approvalKind;
    expect(
      addIMessageApprovalReactionHintToStructuredPayload({
        payload: missingKind,
        approvalKind: "exec",
      }),
    ).toBeNull();

    const mismatchedAction = buildPayload();
    const buttons = mismatchedAction.presentation?.blocks.find((block) => block.type === "buttons");
    if (!buttons || buttons.type !== "buttons" || !buttons.buttons[0]?.action) {
      throw new Error("Expected typed approval buttons");
    }
    buttons.buttons[0].action = {
      type: "approval",
      approvalId: "exec-other",
      approvalKind: "exec",
      decision: "allow-once",
    };
    expect(
      addIMessageApprovalReactionHintToStructuredPayload({
        payload: mismatchedAction,
        approvalKind: "exec",
      }),
    ).toBeNull();

    const duplicateDecision = buildPayload();
    requireExecApprovalMetadata(duplicateDecision).allowedDecisions = [
      "allow-once",
      "allow-once",
      "deny",
    ];
    expect(
      addIMessageApprovalReactionHintToStructuredPayload({
        payload: duplicateDecision,
        approvalKind: "exec",
      }),
    ).toBeNull();
  });

  it("rejects delivered shared prompts without the exact private GUID and visible binding", async () => {
    const payload: ReplyPayload = buildForwardedApproval("exec", "exec-shared-2", "shared-2");
    const prepared = addIMessageApprovalReactionHintToStructuredPayload({
      payload,
      approvalKind: "exec",
    });
    if (!prepared?.text) {
      throw new Error("Expected typed iMessage approval payload");
    }

    expect(
      await registerIMessageApprovalReactionTargetForDeliveredPayload({
        accountId: "default",
        target: { channel: "imessage", to: "+15551230000" },
        payload: prepared,
        results: [
          {
            channel: "imessage",
            messageId: "p:0/guessed-guid",
            meta: { imessageVisibleText: prepared.text },
          },
          {
            channel: "imessage",
            messageId: "42",
            meta: {
              imessageMessageGuid: "p:0/real-guid",
              imessageVisibleText: prepared.text.replace("exec-shared-2", "exec-other"),
            },
          },
        ],
      }),
    ).toBe(false);
  });

  it("derives reaction conversation keys from every supported target form", () => {
    expect(buildIMessageApprovalConversationKeyForTarget("+1 (555) 123-0000")).toEqual({
      handle: "+15551230000",
    });
    expect(buildIMessageApprovalConversationKeyForTarget("chat_id:42")).toEqual({ chatId: 42 });
    expect(buildIMessageApprovalConversationKeyForTarget("chat_guid:iMessage;+;group-1")).toEqual({
      chatGuid: "iMessage;+;group-1",
    });
    expect(
      buildIMessageApprovalConversationKeyForTarget("chat_identifier:group@example.com"),
    ).toEqual({ chatIdentifier: "group@example.com" });
  });

  it("rejects reaction targets without an explicit approval kind", async () => {
    expect(
      await registerIMessageApprovalReactionTargetRaw({
        accountId: "default",
        conversation: { handle: "+15551230000" },
        messageId: "msg-missing-kind",
        approvalId: "exec-missing-kind",
        approvalKind: undefined as unknown as "exec",
        allowedDecisions: ["allow-once"],
      }),
    ).toBeNull();
  });

  it("does not keep pending poll targets when the process clock is invalid", async () => {
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(Number.NaN);
    try {
      expect(
        await registerIMessageApprovalReactionTarget({
          messageId: "msg-invalid-clock",
          approvalId: "exec-invalid-clock",
        }),
      ).toBeNull();
    } finally {
      dateNow.mockRestore();
    }

    expect(await listPendingIMessageApprovalReactionPollTargets({ accountId: "default" })).toEqual(
      [],
    );
  });

  it("falls back to the default pending poll target ttl for invalid explicit ttl values", async () => {
    const nowMs = 1_800_000_000_000;
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(nowMs);
    try {
      await registerIMessageApprovalReactionTarget({
        messageId: "msg-invalid-ttl",
        approvalId: "exec-invalid-ttl",
        ttlMs: Number.NaN,
      });
    } finally {
      dateNow.mockRestore();
    }

    expect(await listPendingIMessageApprovalReactionPollTargets({ accountId: "default" })).toEqual([
      expect.objectContaining({
        approvalId: "exec-invalid-ttl",
        expiresAtMs: nowMs + 24 * 60 * 60 * 1000,
      }),
    ]);
  });

  it("resolves is_from_me tapbacks when the actor is an explicit approver", async () => {
    await registerIMessageApprovalReactionTarget({ approvalId: "exec-self" });

    const gatewayRuntime = { request: vi.fn() } as never;
    const handled = await resolveReaction(
      buildTapbackReactionPayload({
        sender: "+15551230000",
        is_from_me: true,
        reaction_emoji: "👍",
        reacted_to_guid: "approval-message",
      }),
      { gatewayRuntime },
    );

    expect(handled).toBe(true);
    expect(resolverMocks.resolveApprovalOverGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "exec-self",
        decision: "allow-once",
        channel: "imessage",
        accountId: "default",
        senderId: "+15551230000",
        gatewayRuntime,
      }),
    );
  });

  it("ignores removed tapbacks for approval reactions", async () => {
    await registerIMessageApprovalReactionTarget({ approvalId: "exec-1" });

    const handled = await resolveReaction(
      buildTapbackReactionPayload({
        sender: "+15551230000",
        is_reaction: true,
        is_reaction_add: false,
        reaction_emoji: "👍",
        reacted_to_guid: "approval-message",
      }),
    );

    expect(handled).toBe(false);
    expect(resolverMocks.resolveApprovalOverGateway).not.toHaveBeenCalled();
  });

  it("requires explicit approvers for direct approval reactions", async () => {
    await registerIMessageApprovalReactionTarget({
      approvalId: "exec-1",
      allowedDecisions: ["allow-once"],
    });

    const handled = await resolveReaction(
      buildTapbackReactionPayload({
        sender: "+15551230000",
        reaction_emoji: "👍",
        reacted_to_guid: "approval-message",
      }),
      { cfg: { channels: { imessage: {} } } },
    );

    expect(handled).toBe(true);
    expect(resolverMocks.resolveApprovalOverGateway).not.toHaveBeenCalled();
  });

  it("resolves approvals when the legacy tapback text path is used", async () => {
    await registerIMessageApprovalReactionTarget({ approvalId: "exec-legacy" });

    const handled = await resolveReaction(
      {
        sender: "+15551230000",
        reacted_to_guid: "approval-message",
      } as IMessagePayload,
      { bodyText: "liked “Exec approval required”" },
    );

    // Legacy text tapbacks lack a targetGuid in the reaction context, so they
    // should fall through to the dispatch pipeline rather than resolving an
    // approval here.
    expect(handled).toBe(false);
    expect(resolverMocks.resolveApprovalOverGateway).not.toHaveBeenCalled();
  });
});
