import { beforeEach, describe, expect, it, vi } from "vitest";
import { imessageApprovalNativeRuntime as native } from "./approval-handler.runtime.js";
import {
  iMessageApprovalPollTargets,
  maybeResolveIMessageApprovalPollVote,
} from "./approval-polls.js";
import {
  clearIMessageApprovalReactionTargetsForTest,
  maybeResolveIMessageApprovalReaction,
} from "./approval-reactions.js";
import { pollVote } from "./test-support/approval.js";

const send = vi.hoisted(() => vi.fn());

const probeMock = vi.hoisted(() => ({ cachedStatus: vi.fn(), probeIMessagePrivateApi: vi.fn() }));

const actionsMock = vi.hoisted(() => ({ sendPoll: vi.fn(), resolveChat: vi.fn() }));

const timersMock = vi.hoisted(() => ({
  delay: vi.fn(async () => undefined),
}));

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

function sendResult(
  messageId: string,
  params: {
    guid?: string;
    service?: string;
    chatGuid?: string;
    sentText?: string;
  } = {},
) {
  return { messageId, ...params };
}

vi.mock("node:timers/promises", () => ({ setTimeout: timersMock.delay }));

// mock-isolation: keep transport effects in test-owned doubles.
vi.mock("./send.js", () => ({ sendMessageIMessage: send }));

// mock-isolation: keep transport effects in test-owned doubles.
vi.mock("./probe.js", () => ({
  getCachedIMessagePrivateApiStatus: probeMock.cachedStatus,
  probeIMessagePrivateApi: probeMock.probeIMessagePrivateApi,
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
    iMessageApprovalPollTargets.clearForTest();
    clearIMessageApprovalReactionTargetsForTest();
    approvalGatewayMock.resolve.mockReset().mockResolvedValue({ applied: true, approval: {} });
    send
      .mockReset()
      .mockResolvedValue(
        sendResult(PROMPT_GUID, { guid: PROMPT_GUID, sentText: "PROMPT WITH COMMANDS" }),
      );
    probeMock.cachedStatus.mockReset().mockReturnValue(POLL_CAPABLE_STATUS);
    probeMock.probeIMessagePrivateApi.mockReset();
    actionsMock.sendPoll.mockReset().mockResolvedValue(pollResult);
    actionsMock.resolveChat.mockReset().mockResolvedValue(CHAT_GUID);
    timersMock.delay.mockClear();
  });

  it("resolves native system-agent tapbacks only for an authorized group participant", async () => {
    const approvalId = "system-agent:native-tapback";
    const groupChatGuid = "iMessage;+;system-agent-native";
    const to = `chat_guid:${groupChatGuid}`;
    const nowMs = Date.now();
    const expiresAtMs = nowMs + 60_000;
    const request: PendingPayloadArgs["request"] = {
      approvalKind: "system-agent",
      id: approvalId,
      request: {
        title: "OpenClaw change",
        description: "Update the agent display name",
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
      commandText: request.request.description,
      operationSummary: request.request.description,
      expiresAtMs,
      actions: (["allow-once", "deny"] as const).map((decision) => ({
        decision,
        label: decision === "deny" ? "Deny" : "Allow Once",
        command: `/approve ${approvalId} ${decision}`,
        style: decision === "deny" ? "danger" : "success",
      })),
    };
    const pendingPayload = await buildPendingPayload({
      request,
      approvalKind: "system-agent",
      view,
      nowMs,
    });
    probeMock.cachedStatus.mockReturnValue(NO_POLL_SELECTOR_STATUS);
    approvalGatewayMock.resolve.mockResolvedValue({
      applied: true,
      approval: { status: "allowed", decision: "allow-once", reason: "user" },
    });

    const entry = await deliverPoll({
      request,
      approvalKind: "system-agent",
      view,
      pendingPayload,
      ...deliveryTarget(to),
    });

    expect(entry).toMatchObject({
      messageId: PROMPT_GUID,
      conversation: { chatGuid: groupChatGuid },
    });
    expect(pendingPayload.text).toContain("React with:");
    expectSend(
      pendingPayload.text,
      {
        approvalPrompt: {
          approvalId,
          approvalKind: "system-agent",
          allowedDecisions: ["allow-once", "deny"],
        },
      },
      to,
    );
    expect(actionsMock.sendPoll).not.toHaveBeenCalled();
    const react = (sender: string) =>
      maybeResolveIMessageApprovalReaction({
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
      });

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
      gatewayUrl: undefined,
    });
    await expect(react(HANDLE)).resolves.toBe(false);
    expect(approvalGatewayMock.resolve).toHaveBeenCalledTimes(1);
  });

  it("attests text fallback sends as host-originated, not delegated", async () => {
    // #99905: host-owned approval targets must not default to delegated authority.
    actionsMock.sendPoll.mockRejectedValue(new Error("bridge gone"));

    await deliverPoll();
    for (const call of send.mock.calls) {
      expect(call[2]).toEqual(
        expect.objectContaining({ conversationReadOrigin: "direct-operator" }),
      );
    }
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

  it.each<{ name: string; overrides: Partial<DeliverPendingArgs> }>([
    {
      name: "keeps explicit forwarding targets on the text approval path",
      overrides: {
        plannedTarget: { ...pollDeliverArgs.plannedTarget, surface: "forward" } as never,
      },
    },
    {
      name: "keeps non-iMessage target sms:+15551230000 on the text approval path",
      overrides: deliveryTarget("sms:+15551230000"),
    },
    {
      name: "keeps non-iMessage target chat_guid:SMS;-;+15551230000 on the text approval path",
      overrides: deliveryTarget("chat_guid:SMS;-;+15551230000"),
    },
    {
      name: "keeps text controls when no explicit approver can authorize a poll vote",
      overrides: { cfg: { channels: { imessage: {} } } as never },
    },
    {
      name: "keeps the tapback hint when fewer than two decisions are allowed",
      overrides: {
        pendingPayload: { ...pollDeliverArgs.pendingPayload, allowedDecisions: ["allow-once"] },
      },
    },
  ])("$name", async ({ overrides }) => {
    const entry = await deliverPoll(overrides);
    expectSend(pollDeliverArgs.pendingPayload.text, {}, overrides.preparedTarget?.to ?? HANDLE);
    expectTextOnly(entry);
  });

  it("resolves a chat_id before sending its native poll", async () => {
    const to = "chat_id:42";
    send.mockResolvedValueOnce(
      sendResult(PROMPT_GUID, {
        guid: PROMPT_GUID,
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

  it("adds a threaded tapback hint when the chat is not registered with Messages", async () => {
    actionsMock.resolveChat.mockResolvedValue(null);
    send
      .mockResolvedValueOnce(sendResult(PROMPT_GUID, { guid: PROMPT_GUID }))
      .mockResolvedValueOnce(sendResult("hint-guid", { guid: "hint-guid" }));

    const entry = await deliverPoll();

    expectTextOnly(entry);
    expect(send).toHaveBeenCalledTimes(2);
    expectLastSend(expect.stringContaining("👍 Allow Once"), {
      conversationReadOrigin: "direct-operator",
      replyToId: PROMPT_GUID,
    });
    expect(entry).toMatchObject({ messageId: "prompt-guid", hintMessageId: "hint-guid" });
  });

  it("keeps manual controls when the approval prompt has no GUID", async () => {
    send.mockResolvedValueOnce(sendResult("42"));

    const entry = await deliverPoll();

    expect(send).toHaveBeenCalledTimes(1);
    expectSend(pollDeliverArgs.pendingPayload.pollText, {
      conversationReadOrigin: "direct-operator",
    });
    expect(actionsMock.sendPoll).not.toHaveBeenCalled();
    expect(entry).toBeNull();
  });

  it("restores text controls when poll option metadata is incomplete", async () => {
    actionsMock.sendPoll.mockResolvedValue({ messageId: "orphan-poll-guid", pollOptions: [] });

    const entry = await deliverPoll();

    expect(entry?.poll).toBeUndefined();
    expect(send).toHaveBeenCalledTimes(2);
    expectLastSend(pollDeliverArgs.pendingPayload.text, {
      approvalPrompt: promptBinding,
      replyToId: PROMPT_GUID,
    });
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
