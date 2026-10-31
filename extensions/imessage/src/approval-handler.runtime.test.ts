import type { ExecApprovalReplyDecision } from "openclaw/plugin-sdk/approval-reply-runtime";
import {
  buildTypedApprovalPresentation,
  buildTypedExecApprovalPendingReplyPayload,
} from "openclaw/plugin-sdk/approval-reply-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildApprovalPollOptions, mapSentPollOptionsToDecisions } from "./approval-polls.js";
import type { IMessagePayload } from "./monitor/types.js";
import { pollVote, resolvedApproval } from "./test-support/approval.js";

let native: typeof import("./approval-handler.runtime.js").imessageApprovalNativeRuntime;
let maybeResolveIMessageApprovalPollVote: typeof import("./approval-polls.js").maybeResolveIMessageApprovalPollVote;
let handleIMessageApprovalReaction: typeof import("./approval-reactions.js").handleIMessageApprovalReaction;

let iMessageApprovalPollTargets: typeof import("./approval-polls.js").iMessageApprovalPollTargets;
let listTargets: typeof import("./approval-reaction-poll-targets.js").listPendingIMessageApprovalReactionPollTargets;
let addIMessageApprovalReactionHintToStructuredPayload: typeof import("./approval-reactions.js").addIMessageApprovalReactionHintToStructuredPayload;
let buildIMessageApprovalConversationKeyForTarget: typeof import("./approval-reactions.js").buildIMessageApprovalConversationKeyForTarget;
let bindDelivered: typeof import("./approval-reactions.js").registerIMessageApprovalReactionTargetForDeliveredPayload;
let registerRaw: typeof import("./approval-reactions.js").registerIMessageApprovalReactionTarget;
let lookupTarget: typeof import("./approval-reactions.js").resolveIMessageApprovalReactionTargetWithPersistence;

beforeEach(async () => {
  vi.resetModules();
  ({ imessageApprovalNativeRuntime: native } = await import("./approval-handler.runtime.js"));
  ({ iMessageApprovalPollTargets, maybeResolveIMessageApprovalPollVote } =
    await import("./approval-polls.js"));
  ({
    handleIMessageApprovalReaction,
    addIMessageApprovalReactionHintToStructuredPayload,
    buildIMessageApprovalConversationKeyForTarget,
    registerIMessageApprovalReactionTargetForDeliveredPayload: bindDelivered,
    registerIMessageApprovalReactionTarget: registerRaw,
    resolveIMessageApprovalReactionTargetWithPersistence: lookupTarget,
  } = await import("./approval-reactions.js"));
  ({ listPendingIMessageApprovalReactionPollTargets: listTargets } =
    await import("./approval-reaction-poll-targets.js"));
  approvalGatewayMock.resolve.mockReset().mockResolvedValue({ applied: true, approval: {} });
});

const send = vi.hoisted(() => vi.fn());

const cachedStatus = vi.hoisted(() => vi.fn());

const actionsMock = vi.hoisted(() => ({ sendPoll: vi.fn(), resolveChat: vi.fn() }));

const approvalGatewayMock = vi.hoisted(() => ({ resolve: vi.fn() }));

const ACCOUNT_ID = "default";
const HANDLE = "+15551230000";
const CHAT_GUID = "iMessage;-;+15551230000";
const PROMPT_GUID = "prompt-guid";
const POLL_GUID = "poll-guid";
const POLL_CAPABLE_STATUS = {
  available: true,
  selectors: { pollPayloadMessage: true, retractMessagePart: true },
  rpcMethods: ["poll.send"],
  cliCapabilities: { pollSendSupportsNoComment: true },
};
const NO_POLL_SELECTOR_STATUS = { available: true, selectors: {}, rpcMethods: [] };
const approvalContext = {
  cfg: {} as never,
  accountId: ACCOUNT_ID,
  context: { accountId: ACCOUNT_ID },
};
const pollResult = {
  messageId: POLL_GUID,
  pollOptions: [
    { id: "id-allow", text: "👍 Allow Once" },
    { id: "id-deny", text: "👎 Deny" },
  ],
};
const promptBinding = {
  approvalId: "exec-poll",
  approvalKind: "exec",
  allowedDecisions: ["allow-once", "deny"],
};
function expectSend(text: unknown, options: Record<string, unknown> = {}, to = HANDLE) {
  expect(send).toHaveBeenCalledWith(to, text, expect.objectContaining(options));
}
function expectLastSend(text: unknown, options: Record<string, unknown>) {
  expect(send).toHaveBeenLastCalledWith(HANDLE, text, expect.objectContaining(options));
}

type PendingPayloadArgs = Parameters<typeof native.presentation.buildPendingPayload>[0];

function buildPendingPayload(
  args: Pick<PendingPayloadArgs, "request" | "approvalKind" | "view"> &
    Partial<Omit<PendingPayloadArgs, "request" | "approvalKind" | "view">>,
) {
  return native.presentation.buildPendingPayload({ ...approvalContext, nowMs: 0, ...args });
}

function execRequest(approvalId = "exec-1") {
  return {
    id: approvalId,
    request: { command: "echo hi" },
    createdAtMs: 0,
    expiresAtMs: 60_000,
  } as never;
}

function execView(
  approvalId = "exec-1",
  actions: Array<Record<string, string>> = [],
  overrides: Record<string, unknown> = {},
) {
  return {
    approvalKind: "exec",
    approvalId,
    commandText: "echo hi",
    actions,
    ...overrides,
  } as never;
}

function receipt(
  guid = PROMPT_GUID,
  params: { service?: string; chatGuid?: string; sentText?: string } = {},
) {
  return { messageId: guid, guid, ...params };
}

vi.mock("node:timers/promises", () => ({ setTimeout: vi.fn(async () => undefined) }));

// mock-isolation: keep transport effects in test-owned doubles.
vi.mock("./send.js", () => ({ sendMessageIMessage: send }));

// mock-isolation: Keep the shared bridge cache under test control.
vi.mock("./private-api-status.js", () => ({
  getCachedIMessagePrivateApiStatus: cachedStatus,
}));

// mock-isolation: keep transport effects in test-owned doubles.
vi.mock("./actions.runtime.js", () => ({
  imessageActionsRuntime: {
    sendPoll: actionsMock.sendPoll,
    resolveChatGuidForTarget: actionsMock.resolveChat,
  },
}));

// mock-isolation: exercise approval handling without a live gateway.
vi.mock("openclaw/plugin-sdk/approval-gateway-runtime", () => ({
  resolveApprovalOverGateway: approvalGatewayMock.resolve,
}));

const pollDeliverArgs = {
  cfg: { channels: { imessage: { service: "imessage", allowFrom: ["+15551230000"] } } } as never,
  accountId: "default",
  context: { accountId: "default" },
  preparedTarget: { to: "+15551230000", accountId: "default" },
  plannedTarget: {
    surface: "origin" as const,
    reason: "preferred" as const,
    target: { to: "+15551230000" },
  },
  request: execRequest("exec-poll"),
  approvalKind: "exec" as const,
  view: execView("exec-poll", [], { expiresAtMs: Date.now() + 60_000 }),
  pendingPayload: {
    text: "PROMPT WITH HINT\n\nReact with:\n\n👍 Allow Once\n👎 Deny\n\n/approve exec-poll allow-once\n/approve exec-poll deny",
    pollText: "PROMPT WITH COMMANDS\n\n/approve exec-poll allow-once\n/approve exec-poll deny",
    allowedDecisions: ["allow-once" as const, "deny" as const],
  },
};

describe("imessageApprovalNativeRuntime", () => {
  it("normalizes iMessage handle targets and carries account ids into prepared delivery", async () => {
    await expect(
      native.transport.prepareTarget({
        ...pollDeliverArgs,
        accountId: "ops",
        context: { accountId: "ops" },
        plannedTarget: { ...pollDeliverArgs.plannedTarget, target: { to: "+1 (555) 123-0000" } },
      }),
    ).resolves.toEqual({
      dedupeKey: expect.any(String),
      target: { to: "+15551230000", accountId: "ops" },
    });
  });

  it("carries the same bold headers and labels in tapback and poll mode", async () => {
    // #85954: poll mode used to deliver the unstyled legacy prompt.
    const payload = await buildPendingPayload({
      request: execRequest("exec-bold"),
      approvalKind: "exec",
      view: execView(
        "exec-bold",
        [
          { decision: "allow-once", label: "Allow Once", command: "/approve exec-bold allow-once" },
          { decision: "deny", label: "Deny", command: "/approve exec-bold deny" },
        ],
        { host: "gateway", cwd: "/tmp/work", expiresAtMs: 60_000 },
      ),
    });

    for (const text of [payload.text, payload.pollText]) {
      expect(text).toContain("**Exec approval required**");
      expect(text).toContain("**ID:** exec-bold");
      expect(text).toContain("**Host:** gateway");
      expect(text).toContain("**CWD:**");
      expect(text).toContain("**Expires in:**");
      expect(text).toContain("**Full id:**");
    }
    expect(payload.text).toContain("React with:");
    expect(payload.pollText).not.toContain("React with:");
  });

  type DeliverPendingArgs = Parameters<typeof native.transport.deliverPending>[0];
  const deliverPoll = (overrides: Partial<DeliverPendingArgs> = {}) =>
    native.transport.deliverPending({ ...pollDeliverArgs, ...overrides });
  function expectTextOnly(entry: Awaited<ReturnType<typeof deliverPoll>>) {
    expect(actionsMock.sendPoll).not.toHaveBeenCalled();
    expect(entry?.poll).toBeUndefined();
  }
  function deliveryTarget(to: string) {
    return {
      preparedTarget: { to, accountId: ACCOUNT_ID },
      plannedTarget: { ...pollDeliverArgs.plannedTarget, target: { to } },
    };
  }
  const resolvePollVote = () =>
    maybeResolveIMessageApprovalPollVote({
      cfg: pollDeliverArgs.cfg,
      accountId: ACCOUNT_ID,
      message: pollVote(
        POLL_GUID,
        [{ option_id: "id-deny", participant: HANDLE, event_type: "selected" }],
        { chat_guid: CHAT_GUID },
      ),
    });

  beforeEach(() => {
    send.mockReset().mockResolvedValue(receipt(PROMPT_GUID, { sentText: "PROMPT WITH COMMANDS" }));
    cachedStatus.mockReset().mockReturnValue(POLL_CAPABLE_STATUS);
    actionsMock.sendPoll.mockReset().mockResolvedValue(pollResult);
    actionsMock.resolveChat.mockReset().mockResolvedValue(CHAT_GUID);
  });

  it("resolves native system-agent tapbacks only for an authorized group participant", async () => {
    const approvalId = "system-agent:native-tapback";
    const groupChatGuid = "iMessage;+;system-agent-native";
    const to = `chat_guid:${groupChatGuid}`;
    const nowMs = Date.now();
    const expiresAtMs = nowMs + 60_000;
    const description = "Update the agent display name";
    const request: PendingPayloadArgs["request"] = {
      approvalKind: "system-agent",
      id: approvalId,
      request: {
        title: "OpenClaw change",
        description,
        command: "config.patch",
        proposalHash: "synthetic-proposal",
        sessionId: "synthetic-session",
        allowedDecisions: ["allow-once", "deny"],
      },
      createdAtMs: nowMs,
      expiresAtMs,
    };
    const view: Extract<PendingPayloadArgs["view"], { approvalKind: "system-agent" }> = {
      approvalKind: "system-agent",
      approvalId,
      phase: "pending",
      title: "OpenClaw change requires approval",
      metadata: [],
      commandText: description,
      operationSummary: description,
      expiresAtMs,
      actions: (["allow-once", "deny"] as const).map((decision) => ({
        decision,
        label: decision === "deny" ? "Deny" : "Allow Once",
        command: `/approve ${approvalId} ${decision}`,
        style: decision === "deny" ? "danger" : "success",
      })),
    };
    const args = { request, approvalKind: "system-agent" as const, view };
    const pendingPayload = await buildPendingPayload({ ...args, nowMs });
    cachedStatus.mockReturnValue(NO_POLL_SELECTOR_STATUS);
    approvalGatewayMock.resolve.mockResolvedValue({
      applied: true,
      approval: { status: "allowed", decision: "allow-once", reason: "user" },
    });

    await deliverPoll({
      ...args,
      pendingPayload,
      ...deliveryTarget(to),
    });

    expect(actionsMock.sendPoll).not.toHaveBeenCalled();
    const react = async (sender: string) =>
      (
        await handleIMessageApprovalReaction({
          cfg: pollDeliverArgs.cfg,
          accountId: ACCOUNT_ID,
          message: {
            sender,
            chat_guid: groupChatGuid,
            is_group: true,
            is_reaction: true,
            reaction_emoji: "👍",
            reacted_to_guid: PROMPT_GUID,
          },
          bodyText: "",
        })
      ).handled;

    await expect(react("+15559999999")).resolves.toBe(true);
    expect(approvalGatewayMock.resolve).not.toHaveBeenCalled();
    await expect(react(HANDLE)).resolves.toBe(true);
    expect(approvalGatewayMock.resolve).toHaveBeenCalledExactlyOnceWith({
      cfg: pollDeliverArgs.cfg,
      approvalId,
      approvalKind: "system-agent",
      decision: "allow-once",
      channel: "imessage",
      accountId: ACCOUNT_ID,
      senderId: HANDLE,
    });
    await expect(react(HANDLE)).resolves.toBe(false);
    expect(approvalGatewayMock.resolve).toHaveBeenCalledTimes(1);
  });

  it("keeps markdown markers out of the poll question", async () => {
    // Unlike the styled details, poll questions have no formatting channel.
    const pollText = ["**Exec approval required**", "**ID:** exec-poll"].join("\n");
    await deliverPoll({ pendingPayload: { ...pollDeliverArgs.pendingPayload, pollText } });

    expectSend(pollText, { conversationReadOrigin: "direct-operator" });
    const question = actionsMock.sendPoll.mock.calls[0]?.[0]?.question;
    expect(question).toBe("Exec approval required\nID: exec-poll");
  });

  it("does not recreate a poll target after an immediate vote resolves it", async () => {
    let immediateVote: Promise<boolean> | undefined;
    actionsMock.sendPoll.mockImplementationOnce(async () => {
      queueMicrotask(() => {
        queueMicrotask(() => {
          immediateVote = resolvePollVote();
        });
      });
      return pollResult;
    });

    await deliverPoll();
    await vi.waitFor(() => expect(immediateVote).toBeDefined());
    await expect(immediateVote).resolves.toBe(true);

    await expect(resolvePollVote()).resolves.toBe(true);
    expect(approvalGatewayMock.resolve).toHaveBeenCalledTimes(1);
  });

  it.each<[string, Partial<DeliverPendingArgs>]>([
    [
      "explicit forwarding",
      { plannedTarget: { ...pollDeliverArgs.plannedTarget, surface: "forward" } as never },
    ],
    ["SMS handle", deliveryTarget("sms:+15551230000")],
    ["SMS chat GUID", deliveryTarget("chat_guid:SMS;-;+15551230000")],
    ["no explicit approver", { cfg: { channels: { imessage: {} } } as never }],
    [
      "one decision",
      { pendingPayload: { ...pollDeliverArgs.pendingPayload, allowedDecisions: ["allow-once"] } },
    ],
  ])("keeps %s on the text approval path", async (_name, overrides) => {
    const entry = await deliverPoll(overrides);
    expectSend(pollDeliverArgs.pendingPayload.text, {}, overrides.preparedTarget?.to ?? HANDLE);
    expectTextOnly(entry);
  });

  it("resolves a chat_id before sending its native poll", async () => {
    const to = "chat_id:42";
    send.mockResolvedValueOnce(
      receipt(PROMPT_GUID, {
        service: "imessage",
        chatGuid: "iMessage;+;chat42",
        sentText: "PROMPT WITH HINT",
      }),
    );
    const entry = await deliverPoll(deliveryTarget(to));

    expect(actionsMock.resolveChat).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { kind: "chat_id", chatId: 42 },
        conversationReadOrigin: "direct-operator",
      }),
    );
    expect(actionsMock.sendPoll).toHaveBeenCalled();
    expect(entry).toMatchObject({ poll: expect.anything(), reactionFallbackVisible: true });
  });

  it.each([
    ["chat is not registered", () => actionsMock.resolveChat.mockResolvedValue(null), 0],
    ["poll send fails", () => actionsMock.sendPoll.mockRejectedValue(new Error("bridge gone")), 1],
    [
      "poll metadata is incomplete",
      () =>
        actionsMock.sendPoll.mockResolvedValue({ messageId: "orphan-poll-guid", pollOptions: [] }),
      1,
    ],
  ] as const)("restores bound text controls when %s", async (_name, arrange, pollCalls) => {
    arrange();
    send.mockResolvedValueOnce(receipt()).mockResolvedValueOnce(receipt("hint-guid"));
    const entry = await deliverPoll();
    expect(entry?.poll).toBeUndefined();
    expect(actionsMock.sendPoll).toHaveBeenCalledTimes(pollCalls);
    expect(send).toHaveBeenCalledTimes(2);
    // #99905: both the initial prompt and fallback remain host-authorized.
    expectSend(pollDeliverArgs.pendingPayload.pollText, {
      conversationReadOrigin: "direct-operator",
    });
    expectLastSend(pollDeliverArgs.pendingPayload.text, {
      approvalPrompt: promptBinding,
      conversationReadOrigin: "direct-operator",
      replyToId: PROMPT_GUID,
    });
    expect(entry).toMatchObject({ messageId: "prompt-guid", hintMessageId: "hint-guid" });
  });

  it("keeps manual controls when the approval prompt has no GUID", async () => {
    send.mockResolvedValueOnce({ messageId: "42" });

    const entry = await deliverPoll();

    expect(send).toHaveBeenCalledTimes(1);
    expectSend(pollDeliverArgs.pendingPayload.pollText, {
      conversationReadOrigin: "direct-operator",
    });
    expect(actionsMock.sendPoll).not.toHaveBeenCalled();
    expect(entry).toBeNull();
  });

  it("threads poll resolution updates to the verified approval prompt", async () => {
    const text = "Canonical result: Allowed once";
    await native.transport.updateEntry?.({
      ...approvalContext,
      entry: {
        accountId: ACCOUNT_ID,
        to: HANDLE,
        conversation: { chatIdentifier: CHAT_GUID },
        messageId: PROMPT_GUID,
        poll: { pollGuid: "bridge-reported-guid", optionDecisions: [["id-allow", "allow-once"]] },
      },
      request: execRequest("approval-1"),
      approvalKind: "exec",
      payload: { text },
      phase: "resolved",
    });
    expectSend(text, { conversationReadOrigin: "direct-operator", replyToId: PROMPT_GUID });
  });
});

const VOTE_POLL_GUID = "poll-guid-1";
const cfg = { channels: { imessage: { allowFrom: [HANDLE] } } };
const ALLOW_ONCE_OPTION = "opt-allow-once";
const DENY_OPTION = "opt-deny";
const GROUP_CHAT_GUID = "iMessage;+;chat0000";

type PollTarget = Parameters<typeof iMessageApprovalPollTargets.register>[0];
const optionDecisions: ReadonlyArray<readonly [string, ExecApprovalReplyDecision]> = [
  [ALLOW_ONCE_OPTION, "allow-once"],
  [DENY_OPTION, "deny"],
];
function bind(overrides: Partial<PollTarget> = {}): Promise<boolean> {
  return iMessageApprovalPollTargets.register({
    accountId: "default",
    conversation: { handle: HANDLE },
    pollGuid: VOTE_POLL_GUID,
    approvalId: "exec-1",
    approvalKind: "exec",
    optionDecisions,
    expiresAtMs: Date.now() + 60_000,
    ...overrides,
  });
}

function voteRecord(participant: string, option_id = ALLOW_ONCE_OPTION, event_type = "selected") {
  return { option_id, participant, event_type };
}
function buildVote(
  vote: Partial<NonNullable<Parameters<typeof pollVote>[3]>> = {},
  message: IMessagePayload = {},
  guid = VOTE_POLL_GUID,
): IMessagePayload {
  return pollVote(
    guid,
    undefined,
    { sender: HANDLE, ...message },
    { ...voteRecord(HANDLE), ...vote },
  );
}

type VoteParams = Parameters<typeof maybeResolveIMessageApprovalPollVote>[0];

function resolveVote(
  message: IMessagePayload,
  overrides: Partial<Omit<VoteParams, "message">> = {},
) {
  return maybeResolveIMessageApprovalPollVote({ cfg, accountId: "default", message, ...overrides });
}
async function expectUnresolved(
  message: IMessagePayload,
  handled = true,
  overrides: Partial<Omit<VoteParams, "message">> = {},
) {
  expect(await resolveVote(message, overrides)).toBe(handled);
  expect(approvalGatewayMock.resolve).not.toHaveBeenCalled();
}

describe("mapSentPollOptionsToDecisions", () => {
  const requested = buildApprovalPollOptions({ allowedDecisions: ["allow-once", "deny"] });

  it.each([
    ["the bridge normalizes option text", ["id-a", "Allow Once"], ["id-b", "Deny"]],
    ["option ids are duplicated", ["same-id", "👍 Allow Once"], ["same-id", "👎 Deny"]],
  ] as const)("fails closed when %s", (_reason, first, second) => {
    const sent = [first, second].map(([id, text]) => ({ id, text }));
    expect(mapSentPollOptionsToDecisions({ requested, sent })).toEqual([]);
  });
});

describe("maybeResolveIMessageApprovalPollVote", () => {
  it.each([
    [
      "selects the transport actor from a multi-participant complete vote set",
      [voteRecord("+15559999999"), voteRecord(HANDLE, DENY_OPTION)],
      "deny",
      voteRecord("+15559999999"),
    ],
    [
      "fails closed when a multi-participant set does not identify the transport actor",
      [voteRecord("+15559999998"), voteRecord("+15559999999", DENY_OPTION)],
      null,
      undefined,
    ],
    [
      "accepts a complete multi-record set for one participant alias",
      [
        voteRecord("e:active-account-alias@example.com"),
        voteRecord("e:active-account-alias@example.com", DENY_OPTION, "removed"),
      ],
      "allow-once",
      undefined,
    ],
    [
      "fails closed when the actor selected multiple approval decisions",
      [voteRecord(HANDLE), voteRecord(HANDLE, DENY_OPTION)],
      null,
      undefined,
    ],
  ] as const)("%s", async (_name, votes, decision, vote) => {
    expect(await bind()).toBe(true);
    const gatewayRuntime = { request: vi.fn() } as never;
    expect(
      await resolveVote(pollVote(VOTE_POLL_GUID, [...votes], {}, vote), { gatewayRuntime }),
    ).toBe(true);
    if (decision) {
      expect(approvalGatewayMock.resolve).toHaveBeenCalledWith(
        expect.objectContaining({
          approvalId: "exec-1",
          decision,
          senderId: HANDLE,
          gatewayRuntime,
        }),
      );
    } else {
      expect(approvalGatewayMock.resolve).not.toHaveBeenCalled();
    }
  });

  it("authenticates paired-device self votes with destination_caller_id", async () => {
    expect(await bind()).toBe(true);
    const message = buildVote({}, { sender: "", is_from_me: true, destination_caller_id: HANDLE });
    expect(await resolveVote(message)).toBe(true);
    expect(approvalGatewayMock.resolve).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "allow-once", senderId: HANDLE }),
    );
  });

  it.each([
    ["does not trust destination_caller_id on received rows", ""],
    ["rejects imsg's local-identity sender fallback on received rows", HANDLE],
  ])("%s", async (_name, sender) => {
    expect(await bind()).toBe(true);
    await expectUnresolved(
      buildVote({}, { sender, is_from_me: false, destination_caller_id: HANDLE }),
      false,
    );
  });

  it("authorizes the transport sender, not the payload participant", async () => {
    // Group lookup matches every member; only allowFrom authenticates the actor.
    await bind({
      conversation: { chatGuid: GROUP_CHAT_GUID },
      approvalId: "exec-group",
      optionDecisions: [[ALLOW_ONCE_OPTION, "allow-once"]],
    });
    await expectUnresolved({
      ...buildVote({}, { sender: "+15559999999" }),
      chat_guid: GROUP_CHAT_GUID,
      is_group: true,
    });
  });

  it.each([
    ["requires explicit approvers", {}, { cfg: { channels: { imessage: {} } } }],
    ["owns an un-vote without resolving it", { event_type: "removed" }, {}],
    ["ignores an option id that is not bound to a decision", { option_id: "opt-unknown" }, {}],
  ] as const)("%s", async (_name, vote, options) => {
    await bind();
    await expectUnresolved(buildVote(vote), true, options);
  });

  it.each([
    ["a non-vote poll", { kind: "created", options: [] }],
    ["a vote without a poll identity", { kind: "vote", vote: null }],
  ])("falls through on %s", async (_label, poll) => {
    await bind();

    await expectUnresolved({ sender: HANDLE, poll } as unknown as IMessagePayload, false);
  });

  it("fails closed on a malformed complete vote set for an owned poll", async () => {
    await bind();

    await expectUnresolved({
      sender: HANDLE,
      poll: {
        kind: "vote",
        original_guid: VOTE_POLL_GUID,
        votes: [{ option_id: 7, participant: HANDLE }],
      },
    } as unknown as IMessagePayload);
  });

  it("retains a tombstone after the live target expires", async () => {
    vi.useFakeTimers({ now: 1_000 });
    try {
      const expiringPollGuid = "poll-guid-natural-expiry";
      expect(
        await bind({
          pollGuid: expiringPollGuid,
          approvalId: "exec-expiring",
          optionDecisions: [[ALLOW_ONCE_OPTION, "allow-once"]],
          expiresAtMs: 1_001,
        }),
      ).toBe(true);
      vi.setSystemTime(1_002);

      await expectUnresolved(buildVote({}, {}, expiringPollGuid));
    } finally {
      vi.useRealTimers();
    }
  });

  it("swallows votes for a created poll that could not be bound", async () => {
    const orphanPollGuid = "poll-guid-orphaned";
    expect(
      await iMessageApprovalPollTargets.registerTombstone({
        accountId: "default",
        conversation: { handle: HANDLE },
        pollGuid: orphanPollGuid,
        approvalId: "exec-orphaned",
      }),
    ).toBe(true);

    await expectUnresolved(buildVote({}, {}, orphanPollGuid));
  });

  it("clears the binding when the approval is already gone", async () => {
    await bind();
    approvalGatewayMock.resolve.mockRejectedValue(new Error("unknown or expired approval id"));

    await resolveVote(buildVote());

    approvalGatewayMock.resolve.mockClear();
    approvalGatewayMock.resolve.mockResolvedValue({ applied: true, approval: {} });

    await resolveVote(buildVote());
    expect(approvalGatewayMock.resolve).not.toHaveBeenCalled();
  });

  it("retains the binding on a transient resolver error so a retry can land", async () => {
    await bind();
    approvalGatewayMock.resolve.mockRejectedValueOnce(new Error("gateway 503"));

    await expect(resolveVote(buildVote())).rejects.toThrow("gateway 503");

    approvalGatewayMock.resolve.mockResolvedValue({ applied: true, approval: {} });
    await resolveVote(buildVote());

    expect(approvalGatewayMock.resolve).toHaveBeenLastCalledWith(
      expect.objectContaining({ approvalId: "exec-1", decision: "allow-once" }),
    );
  });

  it("does not resolve once the binding expired", async () => {
    // The persistent store survives module reload; avoid sibling tombstones.
    const expiredPollGuid = "poll-guid-expired";
    expect(
      await bind({
        pollGuid: expiredPollGuid,
        approvalId: "exec-expired",
        optionDecisions: [[ALLOW_ONCE_OPTION, "allow-once"]],
        expiresAtMs: Date.now() - 1,
      }),
    ).toBe(false);

    await expectUnresolved(buildVote({}, {}, expiredPollGuid), false);
  });

  it("stops resolving after the target is unregistered", async () => {
    await bind();
    await iMessageApprovalPollTargets.unregister({
      accountId: "default",
      conversation: { handle: HANDLE },
      pollGuid: VOTE_POLL_GUID,
      optionDecisions,
    });

    await resolveVote(buildVote());
    expect(approvalGatewayMock.resolve).not.toHaveBeenCalled();
  });
});

const identity = { accountId: "default", conversation: { handle: "+15551230000" } };
const deliveryTarget = {
  accountId: "default",
  target: { channel: "imessage", to: "+15551230000" },
};
function execPayload(
  approvalId = "exec-strict-1",
  approvalSlug = "strict-1",
  command = "echo strict",
) {
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
function resolveTarget(messageId: string, reactionKey = "👎") {
  return lookupTarget({ ...identity, messageId, reactionKey });
}
function requirePrepared(
  payload: ReplyPayload,
  kind: "exec" | "plugin" = "exec",
): ReplyPayload & { text: string } {
  const prepared = prepare(payload, kind);
  if (!prepared?.text) {
    throw new Error("Expected typed iMessage approval payload");
  }
  return { ...prepared, text: prepared.text };
}
function delivery(messageId: string, text: string, guid?: string) {
  return {
    channel: "imessage" as const,
    messageId,
    meta: { imessageMessageGuid: guid, imessageVisibleText: text },
  };
}
function bindDeliveredPayload(
  payload: ReplyPayload,
  results: Parameters<typeof bindDelivered>[0]["results"],
) {
  return bindDelivered({ ...deliveryTarget, payload, results });
}

type IMessageTargetParams = Parameters<typeof registerRaw>[0];

function registerTarget(params: Partial<IMessageTargetParams> = {}) {
  return registerRaw({
    ...identity,
    messageId: "approval-message",
    approvalId: "exec-1",
    allowedDecisions: ["allow-once", "deny"],
    approvalKind: "exec",
    ...params,
  });
}

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
    approvalGatewayMock.resolve.mockReset().mockImplementation(resolvedApproval);
  });

  it.each(["exec", "plugin"] as const)(
    "binds delivered %s prompts from typed metadata and stable GUIDs",
    async (kind) => {
      const approvalId = `${kind}:shared-1`;
      const source =
        kind === "exec"
          ? execPayload(approvalId, "shared-1", "echo shared")
          : buildForwardedApproval(kind, approvalId, "shared-1");
      const payload = requirePrepared(source, kind);
      expect(prepare(source, kind === "exec" ? "plugin" : "exec")).toBeNull();
      expect(
        await bindDeliveredPayload(payload, [delivery("42", payload.text, "p:0/shared-guid")]),
      ).toBe(true);
      await expect(resolveTarget("p:0/shared-guid")).resolves.toEqual({
        approvalId,
        approvalKind: kind,
        decision: "deny",
      });
      await expect(resolveTarget("42")).resolves.toBeNull();
      await expect(resolveTarget("p:0/shared-guid", "♾️")).resolves.toBeNull();
      const gatewayRuntime = { request: vi.fn() } as never;
      expect(
        await resolveReaction(
          buildTapbackReactionPayload({
            is_from_me: true,
            reacted_to_guid: "p:0/shared-guid",
          }),
          { gatewayRuntime },
        ),
      ).toBe(true);
      expect(approvalGatewayMock.resolve).toHaveBeenCalledWith(
        expect.objectContaining({
          approvalId,
          approvalKind: kind,
          decision: "allow-once",
          channel: "imessage",
          accountId: "default",
          senderId: "+15551230000",
          gatewayRuntime,
        }),
      );
    },
  );

  it("fails closed when typed metadata and approval actions disagree", () => {
    const missingKind = execPayload();
    delete requireExecApprovalMetadata(missingKind).approvalKind;
    expect(prepare(missingKind)).toBeNull();

    const mismatchedAction = execPayload();
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

    const duplicateDecision = execPayload();
    requireExecApprovalMetadata(duplicateDecision).allowedDecisions = [
      "allow-once",
      "allow-once",
      "deny",
    ];
    expect(prepare(duplicateDecision)).toBeNull();
  });

  it("rejects delivered shared prompts without the exact private GUID and visible binding", async () => {
    const prepared = requirePrepared(buildForwardedApproval("exec", "exec-shared-2", "shared-2"));
    expect(
      await bindDeliveredPayload(prepared, [
        delivery("p:0/guessed-guid", prepared.text),
        delivery("42", prepared.text.replace("exec-shared-2", "exec-other"), "p:0/real-guid"),
      ]),
    ).toBe(false);
  });

  it("derives reaction conversation keys from every supported target form", () => {
    for (const [target, expected] of [
      ["+1 (555) 123-0000", { handle: "+15551230000" }],
      ["chat_id:42", { chatId: 42 }],
      ["chat_guid:iMessage;+;group-1", { chatGuid: "iMessage;+;group-1" }],
      ["chat_identifier:group@example.com", { chatIdentifier: "group@example.com" }],
    ] as const) {
      expect(buildIMessageApprovalConversationKeyForTarget(target)).toEqual(expected);
    }
  });

  it("rejects reaction targets without an explicit approval kind", async () => {
    await expect(
      registerTarget({ approvalKind: undefined as unknown as "exec" }),
    ).resolves.toBeNull();
  });

  it.each([
    ["invalid-clock", Number.NaN, undefined],
    ["invalid-ttl", 1_800_000_000_000, Number.NaN],
  ] as const)("handles %s without retaining an invalid expiry", async (id, now, ttlMs) => {
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

  it.each([
    ["removed tapback", buildTapbackReactionPayload({ is_reaction_add: false }), false, {}],
    [
      "no explicit approvers",
      buildTapbackReactionPayload({}),
      true,
      { cfg: { channels: { imessage: {} } } },
    ],
    [
      "legacy text tapback",
      { sender: "+15551230000", reacted_to_guid: "approval-message" },
      false,
      { bodyText: "liked “Exec approval required”" },
    ],
  ] as const)("does not resolve %s", async (_name, message, handled, options) => {
    await registerTarget({ allowedDecisions: handled ? ["allow-once"] : ["allow-once", "deny"] });
    expect(await resolveReaction(message, options)).toBe(handled);
    expect(approvalGatewayMock.resolve).not.toHaveBeenCalled();
  });
});
