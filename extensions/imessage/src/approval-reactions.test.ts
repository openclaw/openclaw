import {
  buildTypedApprovalPresentation,
  buildTypedExecApprovalPendingReplyPayload,
} from "openclaw/plugin-sdk/approval-reply-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IMessagePayload } from "./monitor/types.js";
import { resolvedApproval } from "./test-support/approval.js";

let listTargets: typeof import("./approval-reaction-poll-targets.js").listPendingIMessageApprovalReactionPollTargets;
let addIMessageApprovalReactionHintToStructuredPayload: typeof import("./approval-reactions.js").addIMessageApprovalReactionHintToStructuredPayload;
let buildIMessageApprovalConversationKeyForTarget: typeof import("./approval-reactions.js").buildIMessageApprovalConversationKeyForTarget;
let handleIMessageApprovalReaction: typeof import("./approval-reactions.js").handleIMessageApprovalReaction;
let bindDelivered: typeof import("./approval-reactions.js").registerIMessageApprovalReactionTargetForDeliveredPayload;
let registerRaw: typeof import("./approval-reactions.js").registerIMessageApprovalReactionTarget;
let lookupTarget: typeof import("./approval-reactions.js").resolveIMessageApprovalReactionTargetWithPersistence;

beforeEach(async () => {
  vi.resetModules();
  ({ listPendingIMessageApprovalReactionPollTargets: listTargets } =
    await import("./approval-reaction-poll-targets.js"));
  ({
    addIMessageApprovalReactionHintToStructuredPayload,
    buildIMessageApprovalConversationKeyForTarget,
    handleIMessageApprovalReaction,
    registerIMessageApprovalReactionTargetForDeliveredPayload: bindDelivered,
    registerIMessageApprovalReactionTarget: registerRaw,
    resolveIMessageApprovalReactionTargetWithPersistence: lookupTarget,
  } = await import("./approval-reactions.js"));
});

const resolverMocks = vi.hoisted(() => ({ resolve: vi.fn() }));
const identity = { accountId: "default", conversation: { handle: "+15551230000" } };
const deliveryTarget = {
  accountId: "default",
  target: { channel: "imessage", to: "+15551230000" },
};
function execPayload(approvalId: string, approvalSlug: string, command: string) {
  return buildTypedExecApprovalPendingReplyPayload({
    approvalId,
    approvalSlug,
    command,
    host: "gateway",
    allowedDecisions: ["allow-once", "deny"],
  });
}
function prepare(payload: ReplyPayload, approvalKind: "exec" | "plugin" = "exec") {
  return addIMessageApprovalReactionHintToStructuredPayload({ payload, approvalKind });
}
function resolveTarget(messageId: string) {
  return lookupTarget({ ...identity, messageId, reactionKey: "👎" });
}

type IMessageTargetParams = Parameters<typeof registerRaw>[0];

function registerTarget(
  params: Pick<IMessageTargetParams, "approvalId"> & Partial<IMessageTargetParams>,
) {
  return registerRaw({
    ...params,
    accountId: params.accountId ?? identity.accountId,
    conversation: params.conversation ?? identity.conversation,
    messageId: params.messageId ?? "approval-message",
    allowedDecisions: params.allowedDecisions ?? ["allow-once", "deny"],
    approvalKind: params.approvalKind ?? "exec",
  });
}

// mock-isolation: exercise approval handling without a live gateway.
vi.mock("openclaw/plugin-sdk/approval-gateway-runtime", () => ({
  resolveApprovalOverGateway: resolverMocks.resolve,
}));

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
    presentation: buildTypedApprovalPresentation({ approvalId, approvalKind, allowedDecisions }),
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
    reacted_to_guid: "approval-message",
    ...overrides,
  } as IMessagePayload;
}

type ReactionParams = Parameters<typeof handleIMessageApprovalReaction>[0];

async function resolveReaction(
  message: IMessagePayload,
  overrides: Partial<Omit<ReactionParams, "message">> = {},
) {
  return (
    await handleIMessageApprovalReaction({
      cfg: { channels: { imessage: { allowFrom: ["+15551230000"] } } },
      accountId: "default",
      bodyText: "",
      message,
      ...overrides,
    })
  ).handled;
}

describe("iMessage approval reactions", () => {
  beforeEach(() => {
    resolverMocks.resolve.mockReset().mockImplementation(resolvedApproval);
  });

  it("uses typed metadata to prepare shared forwarded prompts", () => {
    const payload: ReplyPayload = buildForwardedApproval("plugin", "plugin:shared-1", "shared-1");

    const prepared = prepare(payload, "plugin");
    expect(prepared?.text).toBe(
      "🛡️ Plugin approval required\nID: plugin:shared-1\n\nReact with:\n\n👍 Allow Once\n👎 Deny\n\nReply with: /approve plugin:shared-1 allow-once|deny",
    );
    expect(prepared?.channelData?.imessageApprovalReactionBindingV1).toEqual({
      version: 1,
      approvalId: "plugin:shared-1",
      approvalSlug: "shared-1",
      approvalKind: "plugin",
      allowedDecisions: ["allow-once", "deny"],
    });
    expect(prepare(payload)).toBeNull();
  });

  it("binds delivered shared prompts from typed metadata and stable GUIDs", async () => {
    const payload = prepare(execPayload("exec-shared-1", "shared-1", "echo shared"));
    if (!payload) {
      throw new Error("Expected typed iMessage approval payload");
    }

    expect(
      await bindDelivered({
        ...deliveryTarget,
        payload,
        results: [
          {
            channel: "imessage",
            messageId: "42",
            meta: { imessageMessageGuid: "p:0/shared-guid", imessageVisibleText: payload.text },
          },
        ],
      }),
    ).toBe(true);

    await expect(resolveTarget("p:0/shared-guid")).resolves.toEqual({
      approvalId: "exec-shared-1",
      approvalKind: "exec",
      decision: "deny",
    });
    await expect(resolveTarget("42")).resolves.toBeNull();
  });

  it("fails closed when typed metadata and approval actions disagree", () => {
    const buildPayload = () => execPayload("exec-strict-1", "strict-1", "echo strict");
    const missingKind = buildPayload();
    delete requireExecApprovalMetadata(missingKind).approvalKind;
    expect(prepare(missingKind)).toBeNull();

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
    expect(prepare(mismatchedAction)).toBeNull();

    const duplicateDecision = buildPayload();
    requireExecApprovalMetadata(duplicateDecision).allowedDecisions = [
      "allow-once",
      "allow-once",
      "deny",
    ];
    expect(prepare(duplicateDecision)).toBeNull();
  });

  it("rejects delivered shared prompts without the exact private GUID and visible binding", async () => {
    const payload: ReplyPayload = buildForwardedApproval("exec", "exec-shared-2", "shared-2");
    const prepared = prepare(payload);
    if (!prepared?.text) {
      throw new Error("Expected typed iMessage approval payload");
    }

    expect(
      await bindDelivered({
        ...deliveryTarget,
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
      await registerRaw({
        ...identity,
        messageId: "msg-missing-kind",
        approvalId: "exec-missing-kind",
        approvalKind: undefined as unknown as "exec",
        allowedDecisions: ["allow-once"],
      }),
    ).toBeNull();
  });

  it.each([
    {
      name: "does not keep pending poll targets when the process clock is invalid",
      now: Number.NaN,
      id: "invalid-clock",
      ttlMs: undefined,
    },
    {
      name: "falls back to the default pending poll target ttl for invalid explicit ttl values",
      now: 1_800_000_000_000,
      id: "invalid-ttl",
      ttlMs: Number.NaN,
    },
  ])("$name", async ({ now, id, ttlMs }) => {
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(now);
    const approvalId = `exec-${id}`;
    try {
      const result = await registerTarget({ messageId: `msg-${id}`, approvalId, ttlMs });
      if (!Number.isFinite(now)) {
        expect(result).toBeNull();
      }
    } finally {
      dateNow.mockRestore();
    }
    expect(await listTargets({ accountId: "default" })).toEqual(
      Number.isFinite(now)
        ? [expect.objectContaining({ approvalId, expiresAtMs: now + 24 * 60 * 60 * 1000 })]
        : [],
    );
  });

  it("resolves is_from_me tapbacks when the actor is an explicit approver", async () => {
    await registerTarget({ approvalId: "exec-self" });

    const gatewayRuntime = { request: vi.fn() } as never;
    const handled = await resolveReaction(buildTapbackReactionPayload({ is_from_me: true }), {
      gatewayRuntime,
    });

    expect(handled).toBe(true);
    expect(resolverMocks.resolve).toHaveBeenCalledWith(
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

  it.each([
    {
      name: "ignores removed tapbacks",
      message: buildTapbackReactionPayload({ is_reaction_add: false }),
      handled: false,
    },
    {
      name: "requires explicit approvers",
      message: buildTapbackReactionPayload({}),
      handled: true,
      limited: true,
      options: { cfg: { channels: { imessage: {} } } },
    },
    {
      name: "falls through for legacy text tapbacks",
      message: { sender: "+15551230000", reacted_to_guid: "approval-message" },
      handled: false,
      options: { bodyText: "liked “Exec approval required”" },
    },
  ])("$name", async ({ message, handled, options, limited }) => {
    await registerTarget({
      approvalId: "exec-1",
      allowedDecisions: limited ? ["allow-once"] : ["allow-once", "deny"],
    });
    expect(await resolveReaction(message, options)).toBe(handled);
    expect(resolverMocks.resolve).not.toHaveBeenCalled();
  });
});
