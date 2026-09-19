// Covers ask_user delivery as ClickClack question cards and the answer and outcome paths.
import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ClickClackAccountLifetime,
  ClickClackMessage,
  ClickClackMessageQuestion,
  CoreConfig,
  ResolvedClickClackAccount,
} from "./types.js";

const hoisted = vi.hoisted(() => ({
  getQuestion: vi.fn(),
  resolveAnswers: vi.fn(),
  cancelQuestion: vi.fn(),
  registerChannelDelivery: vi.fn(),
  sendQuestionMessage: vi.fn(),
  access: vi.fn(),
  client: {
    message: vi.fn(),
    resolveQuestion: vi.fn(),
    unresolvedQuestions: vi.fn(),
  },
}));

vi.mock("openclaw/plugin-sdk/question-gateway-runtime", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("openclaw/plugin-sdk/question-gateway-runtime")>();
  return {
    ...original,
    questionGatewayRuntime: {
      ...original.questionGatewayRuntime,
      getQuestion: hoisted.getQuestion,
      resolveAnswers: hoisted.resolveAnswers,
      cancelQuestion: hoisted.cancelQuestion,
      registerChannelDelivery: hoisted.registerChannelDelivery,
    },
  };
});
vi.mock("./outbound.js", () => ({ sendClickClackQuestionMessage: hoisted.sendQuestionMessage }));
vi.mock("./access.js", () => ({ resolveClickClackInboundAccess: hoisted.access }));
vi.mock("./http-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./http-client.js")>()),
  createClickClackClient: () => hoisted.client,
}));

import { ClickClackHttpError } from "./http-client.js";
import {
  buildClickClackQuestionSpec,
  deliverClickClackQuestionPrompt,
  forwardClickClackQuestionAnswer,
  reconcileClickClackQuestions,
} from "./questions.js";

const cfg = {} as CoreConfig;
const questionId = "ask_0123456789abcdef0123456789abcdef";
const account = {
  accountId: "default",
  apiEndpoint: "http://127.0.0.1:8484",
  token: "test-token-placeholder",
  workspace: "wsp_1",
  botUserId: "usr_bot",
} as ResolvedClickClackAccount;
const now = Date.parse("2026-09-13T12:00:00Z");
let accountStart: AbortController;
let lifetime: ClickClackAccountLifetime;
// Stands in for the async context a turn or an account start carries.
const callerContext = new AsyncLocalStorage<string>();

function startAccount() {
  const abort = new AbortController();
  const runInAccountContext = callerContext.run("account start", () =>
    AsyncLocalStorage.snapshot(),
  );
  return { abort, lifetime: { cfg, account, abortSignal: abort.signal, runInAccountContext } };
}

function listed(
  messageId: string,
  status: "open" | "submitted",
  version: number,
  externalId = questionId,
) {
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  return { message_id: messageId, external_id: externalId, status, version, expires_at: expiresAt };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function pendingRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: questionId,
    status: "pending",
    createdAtMs: now,
    expiresAtMs: now + 15 * 60_000,
    questions: [
      {
        questionId: "ship_date",
        header: "Date",
        question: "Which day do we ship?",
        options: [{ label: "Mon 15", description: "AA 2231" }, { label: "Tue 16" }],
        isOther: true,
      },
      {
        questionId: "extras",
        header: "Extras",
        question: "Anything else?",
        options: [{ label: "Sleeves" }, { label: "UPC labels" }],
        multiSelect: true,
      },
    ],
    ...overrides,
  };
}

function cardMessage(question: Partial<ClickClackMessageQuestion>): ClickClackMessage {
  return {
    id: "msg_card",
    workspace_id: "wsp_1",
    channel_id: "chn_1",
    author_id: "usr_bot",
    thread_root_id: "msg_card",
    body: "Agent needs input",
    body_format: "markdown",
    created_at: "2026-09-13T12:00:00Z",
    question: {
      status: "open",
      external_id: questionId,
      expires_at: "2026-09-13T12:15:00Z",
      allow_skip: true,
      items: [],
      version: 1,
      ...question,
    },
  };
}

function submitted(response: NonNullable<ClickClackMessageQuestion["response"]>) {
  return cardMessage({ status: "submitted", version: 2, response });
}

const answerFromDana: NonNullable<ClickClackMessageQuestion["response"]> = {
  source: "clickclack",
  answers: { ship_date: ["Wed 17"], extras: ["Sleeves"] },
  responder: {
    id: "usr_dana",
    kind: "human",
    display_name: "Dana",
    handle: "dana",
    avatar_url: "",
    created_at: "2026-09-13T12:00:00Z",
  },
};

beforeEach(() => {
  vi.useRealTimers();
  for (const mock of [
    hoisted.getQuestion,
    hoisted.resolveAnswers,
    hoisted.cancelQuestion,
    hoisted.registerChannelDelivery,
    hoisted.sendQuestionMessage,
    hoisted.access,
    ...Object.values(hoisted.client),
  ]) {
    mock.mockReset();
  }
  hoisted.access.mockResolvedValue({
    preparedRoute: { revoked: false },
    channelIngress: { senderAccess: { allowed: true } },
  });
  hoisted.client.resolveQuestion.mockResolvedValue(cardMessage({}));
  ({ abort: accountStart, lifetime } = startAccount());
});

afterEach(() => {
  // Stopping the account also ends any card watch a test started.
  accountStart.abort();
});

describe("buildClickClackQuestionSpec", () => {
  it("maps every question of a pending record onto one card", () => {
    expect(buildClickClackQuestionSpec(pendingRecord() as never, now)).toEqual({
      external_id: questionId,
      expires_at: "2026-09-13T12:15:00.000Z",
      allow_skip: true,
      items: [
        {
          id: "ship_date",
          header: "Date",
          prompt: "Which day do we ship?",
          options: [{ label: "Mon 15", description: "AA 2231" }, { label: "Tue 16" }],
          allow_other: true,
        },
        {
          id: "extras",
          header: "Extras",
          prompt: "Anything else?",
          options: [{ label: "Sleeves" }, { label: "UPC labels" }],
          multi_select: true,
        },
      ],
    });
  });

  it.each([
    ["secret questions", { questions: [{ ...pendingRecord().questions[0], isSecret: true }] }],
    ["records about to expire", { expiresAtMs: now + 5_000 }],
    ["finished records", { status: "answered" }],
    [
      "ids the card cannot carry",
      { questions: [{ ...pendingRecord().questions[0], questionId: "Ship-Date" }] },
    ],
    [
      "labels that differ only by case",
      {
        questions: [
          { ...pendingRecord().questions[0], options: [{ label: "Yes" }, { label: "yes" }] },
        ],
      },
    ],
  ])("keeps the text prompt for %s", (_name, overrides) => {
    expect(buildClickClackQuestionSpec(pendingRecord(overrides) as never, now)).toBeNull();
  });
});

describe("deliverClickClackQuestionPrompt", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  const payload = { text: "Agent needs input", channelData: { askUser: { questionId } } };
  const deliver = () =>
    deliverClickClackQuestionPrompt({
      lifetime,
      payload,
      to: "channel:chn_1",
      text: payload.text,
      replyToId: "msg_turn",
    });

  it("sends a card and settles it from the Gateway outcome", async () => {
    hoisted.getQuestion.mockResolvedValueOnce({
      ...pendingRecord(),
      expiresAtMs: Date.now() + 15 * 60_000,
    });
    hoisted.sendQuestionMessage.mockResolvedValueOnce(cardMessage({}));

    await expect(deliver()).resolves.toBe(true);
    expect(hoisted.sendQuestionMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "default",
        to: "channel:chn_1",
        text: "Agent needs input",
        replyToId: "msg_turn",
        question: expect.objectContaining({ external_id: questionId }),
      }),
    );
    const registration = hoisted.registerChannelDelivery.mock.calls[0]?.[0];
    expect(registration).toMatchObject({ questionId, deliveryId: "clickclack:default:msg_card" });

    // The question expired while the card was still open.
    hoisted.getQuestion.mockResolvedValueOnce({ ...pendingRecord(), status: "expired" });
    hoisted.client.message.mockResolvedValueOnce(cardMessage({ version: 1 }));
    await registration.finalize("Expired");
    expect(hoisted.client.resolveQuestion).toHaveBeenCalledWith("msg_card", {
      status: "expired",
      expected_version: 1,
    });
  });

  it("leaves a submitted card to the answer path", async () => {
    hoisted.getQuestion.mockResolvedValueOnce({
      ...pendingRecord(),
      expiresAtMs: Date.now() + 15 * 60_000,
    });
    hoisted.sendQuestionMessage.mockResolvedValueOnce(cardMessage({}));
    await deliver();
    const registration = hoisted.registerChannelDelivery.mock.calls[0]?.[0];

    hoisted.getQuestion.mockResolvedValueOnce({ ...pendingRecord(), status: "answered" });
    hoisted.client.message.mockResolvedValueOnce(submitted(answerFromDana));
    await registration.finalize("Answered");
    expect(hoisted.client.resolveQuestion).not.toHaveBeenCalled();
  });

  it("keeps the text prompt when there is no card to send", async () => {
    await expect(
      deliverClickClackQuestionPrompt({
        lifetime,
        payload: { text: "hi" },
        to: "channel:chn_1",
        text: "hi",
      }),
    ).resolves.toBe(false);
    expect(hoisted.getQuestion).not.toHaveBeenCalled();

    hoisted.getQuestion.mockResolvedValueOnce(null);
    await expect(deliver()).resolves.toBe(false);

    hoisted.getQuestion.mockRejectedValueOnce(new Error("gateway unavailable"));
    await expect(deliver()).resolves.toBe(false);

    hoisted.getQuestion.mockResolvedValueOnce({
      ...pendingRecord(),
      expiresAtMs: Date.now() + 15 * 60_000,
    });
    hoisted.sendQuestionMessage.mockRejectedValueOnce(
      new ClickClackHttpError(400, "invalid question", new Headers()),
    );
    await expect(deliver()).resolves.toBe(false);
    expect(hoisted.registerChannelDelivery).not.toHaveBeenCalled();
  });

  it("does not register a card on servers without questions", async () => {
    hoisted.getQuestion.mockResolvedValueOnce({
      ...pendingRecord(),
      expiresAtMs: Date.now() + 15 * 60_000,
    });
    hoisted.sendQuestionMessage.mockResolvedValueOnce({ ...cardMessage({}), question: undefined });

    await expect(deliver()).resolves.toBe(true);
    expect(hoisted.registerChannelDelivery).not.toHaveBeenCalled();
  });

  it("keeps checking a card when its answer event does not arrive", async () => {
    hoisted.getQuestion.mockResolvedValueOnce({
      ...pendingRecord(),
      expiresAtMs: Date.now() + 15 * 60_000,
    });
    hoisted.sendQuestionMessage.mockResolvedValueOnce({
      ...cardMessage({}),
      id: "msg_watched",
    });
    await deliver();

    // The first check finds the card still open for a live question.
    hoisted.client.message.mockResolvedValueOnce(cardMessage({}));
    hoisted.getQuestion.mockResolvedValueOnce(pendingRecord());
    await vi.advanceTimersByTimeAsync(5_000);
    expect(hoisted.client.resolveQuestion).not.toHaveBeenCalled();

    // Someone answers while the socket is down; the next check forwards it.
    hoisted.client.message
      .mockResolvedValueOnce({ ...submitted(answerFromDana), id: "msg_watched" })
      .mockResolvedValueOnce({ ...submitted(answerFromDana), id: "msg_watched" });
    hoisted.resolveAnswers.mockResolvedValueOnce({ status: "answered" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(hoisted.resolveAnswers).toHaveBeenCalledOnce();
    expect(hoisted.client.resolveQuestion).toHaveBeenCalledExactlyOnceWith("msg_watched", {
      status: "answered",
      expected_version: 2,
    });

    // A settled card ends the watch.
    hoisted.client.message.mockResolvedValue(cardMessage({ status: "answered", version: 3 }));
    await vi.advanceTimersByTimeAsync(5_000);
    const reads = hoisted.client.message.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(hoisted.client.message.mock.calls.length).toBe(reads);
  });

  it("stops watching and finalizing a card once its account stops", async () => {
    hoisted.getQuestion.mockResolvedValueOnce({
      ...pendingRecord(),
      expiresAtMs: Date.now() + 15 * 60_000,
    });
    hoisted.sendQuestionMessage.mockResolvedValueOnce({ ...cardMessage({}), id: "msg_retired" });
    await deliver();
    const registration = hoisted.registerChannelDelivery.mock.calls[0]?.[0];

    accountStart.abort();
    await vi.advanceTimersByTimeAsync(20_000);
    await registration.finalize("Expired");
    expect(hoisted.client.message).not.toHaveBeenCalled();
    expect(hoisted.getQuestion).toHaveBeenCalledOnce();
    expect(hoisted.client.resolveQuestion).not.toHaveBeenCalled();
  });

  it("keeps the text prompt once its account stopped", async () => {
    accountStart.abort();
    await expect(deliver()).resolves.toBe(false);
    expect(hoisted.getQuestion).not.toHaveBeenCalled();
    expect(hoisted.sendQuestionMessage).not.toHaveBeenCalled();
  });

  it("checks and finalizes a card outside the turn that asked", async () => {
    const contexts: Array<string | undefined> = [];
    hoisted.getQuestion.mockImplementation(async () => {
      contexts.push(callerContext.getStore());
      return { ...pendingRecord(), expiresAtMs: Date.now() + 15 * 60_000 };
    });
    hoisted.sendQuestionMessage.mockResolvedValueOnce({ ...cardMessage({}), id: "msg_context" });
    await callerContext.run("asking turn", () => deliver());
    const registration = hoisted.registerChannelDelivery.mock.calls[0]?.[0];

    hoisted.client.message.mockResolvedValue({ ...cardMessage({ version: 1 }), id: "msg_context" });
    await vi.advanceTimersByTimeAsync(5_000);
    await callerContext.run("turn that ended", () => registration.finalize("Cancelled"));
    // Only the delivery itself runs as the turn; the Gateway rejects that identity once it ends.
    expect(contexts).toEqual(["asking turn", "account start", "account start"]);
  });

  it("closes an open card from its watch when the finalizer did not", async () => {
    hoisted.getQuestion.mockResolvedValueOnce({
      ...pendingRecord(),
      expiresAtMs: Date.now() + 15 * 60_000,
    });
    hoisted.sendQuestionMessage.mockResolvedValueOnce({ ...cardMessage({}), id: "msg_orphan" });
    await deliver();

    hoisted.client.message.mockResolvedValueOnce({
      ...cardMessage({ version: 1 }),
      id: "msg_orphan",
    });
    hoisted.getQuestion.mockResolvedValueOnce({ ...pendingRecord(), status: "cancelled" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(hoisted.client.resolveQuestion).toHaveBeenCalledExactlyOnceWith("msg_orphan", {
      status: "cancelled",
      expected_version: 1,
    });
  });
});

describe("forwardClickClackQuestionAnswer", () => {
  const forward = () => forwardClickClackQuestionAnswer({ lifetime, messageId: "msg_card" });

  it("resolves the Gateway question with the card answer and records it", async () => {
    hoisted.client.message.mockResolvedValue(submitted(answerFromDana));
    hoisted.resolveAnswers.mockResolvedValueOnce({ status: "answered" });

    await Promise.all([forward(), forward()]);

    expect(hoisted.resolveAnswers).toHaveBeenCalledOnce();
    expect(hoisted.resolveAnswers).toHaveBeenCalledWith(
      expect.objectContaining({
        questionId,
        answers: answerFromDana.answers,
        senderId: "clickclack:usr_dana",
        authorize: expect.any(Function),
      }),
    );
    expect(hoisted.access).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({
          author_id: "usr_dana",
          author: answerFromDana.responder,
          body: "",
          kind: "message",
        }),
      }),
    );
    expect(hoisted.client.resolveQuestion).toHaveBeenCalledExactlyOnceWith("msg_card", {
      status: "answered",
      expected_version: 2,
    });
  });

  it.each([
    [
      { status: "invalid", message: "Question ship_date requires one answer." },
      { status: "open", note: "Question ship_date requires one answer." },
    ],
    [
      { status: "already-terminal", reason: "not-found" },
      { status: "failed", note: "No longer waiting for this answer." },
    ],
    [
      { status: "denied" },
      { status: "open", note: "This agent does not accept answers from that person." },
    ],
  ])("records %o as %o", async (result, outcome) => {
    hoisted.client.message.mockResolvedValueOnce(submitted(answerFromDana));
    hoisted.resolveAnswers.mockResolvedValueOnce(result);

    await forward();
    expect(hoisted.client.resolveQuestion).toHaveBeenCalledExactlyOnceWith("msg_card", {
      ...outcome,
      expected_version: 2,
    });
  });

  it("cancels the Gateway question when the card was skipped", async () => {
    hoisted.client.message.mockResolvedValueOnce(
      submitted({ source: "clickclack", skipped: true, responder: answerFromDana.responder }),
    );
    hoisted.cancelQuestion.mockResolvedValueOnce({ status: "cancelled" });

    await forward();
    expect(hoisted.cancelQuestion).toHaveBeenCalledWith(
      expect.objectContaining({ questionId, senderId: "clickclack:usr_dana" }),
    );
    expect(hoisted.resolveAnswers).not.toHaveBeenCalled();
    expect(hoisted.client.resolveQuestion).toHaveBeenCalledExactlyOnceWith("msg_card", {
      status: "cancelled",
      expected_version: 2,
    });
  });

  it("recognizes its own answer when a retry finds the question already answered", async () => {
    hoisted.client.message.mockResolvedValueOnce(submitted(answerFromDana));
    hoisted.resolveAnswers.mockResolvedValueOnce({
      status: "already-terminal",
      reason: "already-terminal",
    });
    hoisted.getQuestion.mockResolvedValueOnce({
      ...pendingRecord(),
      status: "answered",
      resolvedBy: "clickclack:usr_dana",
    });

    await forward();
    expect(hoisted.client.resolveQuestion).toHaveBeenCalledExactlyOnceWith("msg_card", {
      status: "answered",
      expected_version: 2,
    });
  });

  it("closes a card it reopened when the question ended meanwhile", async () => {
    hoisted.client.message
      .mockResolvedValueOnce(submitted(answerFromDana))
      .mockResolvedValueOnce(cardMessage({ status: "open", version: 3 }));
    hoisted.resolveAnswers.mockResolvedValueOnce({ status: "invalid", message: "Pick a date." });
    hoisted.getQuestion.mockResolvedValueOnce({ ...pendingRecord(), status: "expired" });

    await forward();
    expect(hoisted.client.resolveQuestion.mock.calls).toEqual([
      ["msg_card", { status: "open", note: "Pick a date.", expected_version: 2 }],
      ["msg_card", { status: "expired", expected_version: 3 }],
    ]);
  });

  it("reopens the card for people the agent does not accept messages from", async () => {
    hoisted.client.message.mockResolvedValueOnce(submitted(answerFromDana));
    hoisted.access.mockResolvedValueOnce({
      preparedRoute: { revoked: false },
      channelIngress: { senderAccess: { allowed: false } },
    });

    await forward();
    expect(hoisted.resolveAnswers).not.toHaveBeenCalled();
    expect(hoisted.client.resolveQuestion).toHaveBeenCalledExactlyOnceWith("msg_card", {
      status: "open",
      note: "This agent does not accept answers from that person.",
      expected_version: 2,
    });
  });

  it("writes nothing when the account stops while the card is read", async () => {
    const read = deferred<ClickClackMessage>();
    hoisted.client.message.mockReturnValueOnce(read.promise);

    const run = forward();
    accountStart.abort();
    read.resolve(submitted(answerFromDana));
    await run;
    expect(hoisted.access).not.toHaveBeenCalled();
    expect(hoisted.resolveAnswers).not.toHaveBeenCalled();
    expect(hoisted.client.resolveQuestion).not.toHaveBeenCalled();
  });

  it("writes nothing when the account stops while the responder is checked", async () => {
    const access = deferred<unknown>();
    hoisted.client.message.mockResolvedValueOnce(submitted(answerFromDana));
    hoisted.access.mockReturnValueOnce(access.promise);

    const run = forward();
    await vi.waitFor(() => expect(hoisted.access).toHaveBeenCalledOnce());
    accountStart.abort();
    access.resolve({
      preparedRoute: { revoked: false },
      channelIngress: { senderAccess: { allowed: true } },
    });
    await run;
    expect(hoisted.resolveAnswers).not.toHaveBeenCalled();
    expect(hoisted.client.resolveQuestion).not.toHaveBeenCalled();
  });

  it("denies the Gateway write when the account stops before the last check", async () => {
    hoisted.client.message.mockResolvedValueOnce(
      submitted({ source: "clickclack", skipped: true, responder: answerFromDana.responder }),
    );
    // The Gateway re-authorizes right before its write, after the awaited read.
    hoisted.cancelQuestion.mockImplementationOnce(
      async (params: { authorize: () => Promise<boolean> }) => {
        accountStart.abort();
        return (await params.authorize()) ? { status: "cancelled" } : { status: "denied" };
      },
    );

    await forward();
    await expect(hoisted.cancelQuestion.mock.results[0]?.value).resolves.toEqual({
      status: "denied",
    });
    expect(hoisted.client.resolveQuestion).not.toHaveBeenCalled();
  });

  it("leaves the card for the next start when the account stops after the Gateway resolves", async () => {
    hoisted.client.message.mockResolvedValueOnce(submitted(answerFromDana));
    hoisted.resolveAnswers.mockImplementationOnce(async () => {
      accountStart.abort();
      return { status: "answered" };
    });

    await forward();
    expect(hoisted.client.resolveQuestion).not.toHaveBeenCalled();
  });

  it("does not let a newer account start join the run of a stopped one", async () => {
    const staleRead = deferred<ClickClackMessage>();
    hoisted.client.message
      .mockReturnValueOnce(staleRead.promise)
      .mockResolvedValueOnce(submitted(answerFromDana));
    hoisted.resolveAnswers.mockResolvedValueOnce({ status: "answered" });

    const stale = forward();
    accountStart.abort();
    ({ abort: accountStart, lifetime } = startAccount());
    const current = forward();
    staleRead.resolve(submitted(answerFromDana));
    await Promise.all([stale, current]);
    expect(hoisted.resolveAnswers).toHaveBeenCalledOnce();
    expect(hoisted.client.resolveQuestion).toHaveBeenCalledExactlyOnceWith("msg_card", {
      status: "answered",
      expected_version: 2,
    });
  });

  it.each([
    ["cards that are not submitted", cardMessage({ status: "answered" })],
    ["cards another bot asked", { ...submitted(answerFromDana), author_id: "usr_other_bot" }],
    ["questions from other tools", cardMessage({ status: "submitted", external_id: "deploy-42" })],
  ])("ignores %s", async (_name, message) => {
    hoisted.client.message.mockResolvedValueOnce(message);

    await forward();
    expect(hoisted.resolveAnswers).not.toHaveBeenCalled();
    expect(hoisted.cancelQuestion).not.toHaveBeenCalled();
    expect(hoisted.client.resolveQuestion).not.toHaveBeenCalled();
  });
});

describe("reconcileClickClackQuestions", () => {
  it("settles cards whose Gateway question is gone and forwards submitted ones", async () => {
    hoisted.client.unresolvedQuestions
      .mockResolvedValueOnce({
        questions: [listed("msg_gone", "open", 1), listed("msg_card", "submitted", 2)],
        nextCursor: "msg_card",
      })
      .mockResolvedValueOnce({
        questions: [listed("msg_live", "open", 1), listed("msg_tool", "open", 1, "deploy-42")],
      });
    hoisted.getQuestion
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(pendingRecord());
    hoisted.client.message.mockResolvedValueOnce(submitted(answerFromDana));
    hoisted.resolveAnswers.mockResolvedValueOnce({
      status: "already-terminal",
      reason: "not-found",
    });

    await reconcileClickClackQuestions({ lifetime });

    expect(hoisted.client.unresolvedQuestions.mock.calls).toEqual([[undefined], ["msg_card"]]);
    expect(hoisted.client.resolveQuestion.mock.calls).toEqual([
      [
        "msg_gone",
        { status: "failed", note: "No longer waiting for this answer.", expected_version: 1 },
      ],
      [
        "msg_card",
        { status: "failed", note: "No longer waiting for this answer.", expected_version: 2 },
      ],
    ]);
  });

  it("forwards a card answered between the listing and the settle", async () => {
    hoisted.client.unresolvedQuestions.mockResolvedValueOnce({
      questions: [listed("msg_card", "open", 1)],
    });
    hoisted.getQuestion.mockResolvedValueOnce(pendingRecord({ status: "expired" }));
    hoisted.client.resolveQuestion.mockRejectedValueOnce(
      new ClickClackHttpError(409, "question changed", new Headers()),
    );
    hoisted.client.message.mockResolvedValueOnce(submitted(answerFromDana));
    hoisted.resolveAnswers.mockResolvedValueOnce({ status: "answered" });

    await reconcileClickClackQuestions({ lifetime });
    expect(hoisted.resolveAnswers).toHaveBeenCalledOnce();
    expect(hoisted.client.resolveQuestion.mock.calls.at(-1)).toEqual([
      "msg_card",
      { status: "answered", expected_version: 2 },
    ]);
  });

  it("does nothing on servers without questions", async () => {
    hoisted.client.unresolvedQuestions.mockRejectedValueOnce(
      new ClickClackHttpError(404, "not found", new Headers()),
    );

    await expect(reconcileClickClackQuestions({ lifetime })).resolves.toBeUndefined();
    expect(hoisted.getQuestion).not.toHaveBeenCalled();
  });

  it("watches cards whose question is still waiting from an earlier start", async () => {
    vi.useFakeTimers();
    hoisted.client.unresolvedQuestions.mockResolvedValueOnce({
      questions: [listed("msg_adopted", "open", 1)],
    });
    hoisted.getQuestion.mockResolvedValueOnce({
      ...pendingRecord(),
      expiresAtMs: Date.now() + 15 * 60_000,
    });
    await reconcileClickClackQuestions({ lifetime });
    expect(hoisted.client.resolveQuestion).not.toHaveBeenCalled();

    // The question ends while nobody from the earlier start is left to settle it.
    hoisted.client.message.mockResolvedValueOnce({
      ...cardMessage({ version: 1 }),
      id: "msg_adopted",
    });
    hoisted.getQuestion.mockResolvedValueOnce({ ...pendingRecord(), status: "cancelled" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(hoisted.client.resolveQuestion).toHaveBeenCalledExactlyOnceWith("msg_adopted", {
      status: "cancelled",
      expected_version: 1,
    });
    vi.useRealTimers();
  });

  it("keeps watching a submitted card that the new start reopened", async () => {
    vi.useFakeTimers();
    hoisted.client.unresolvedQuestions.mockResolvedValueOnce({
      questions: [listed("msg_reopened", "submitted", 2)],
    });
    // The responder is no longer allowed, so the new start reopens the card.
    hoisted.client.message
      .mockResolvedValueOnce({ ...submitted(answerFromDana), id: "msg_reopened" })
      .mockResolvedValueOnce({ ...cardMessage({ version: 3 }), id: "msg_reopened" });
    hoisted.access.mockResolvedValueOnce({
      preparedRoute: { revoked: false },
      channelIngress: { senderAccess: { allowed: false } },
    });
    hoisted.getQuestion.mockResolvedValueOnce(pendingRecord());
    await reconcileClickClackQuestions({ lifetime });
    expect(hoisted.client.resolveQuestion).toHaveBeenCalledExactlyOnceWith("msg_reopened", {
      status: "open",
      note: "This agent does not accept answers from that person.",
      expected_version: 2,
    });

    // The question then ends another way; the watch closes the reopened card.
    hoisted.client.message.mockResolvedValueOnce({
      ...cardMessage({ version: 3 }),
      id: "msg_reopened",
    });
    hoisted.getQuestion.mockResolvedValueOnce({ ...pendingRecord(), status: "cancelled" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(hoisted.client.resolveQuestion).toHaveBeenLastCalledWith("msg_reopened", {
      status: "cancelled",
      expected_version: 3,
    });
    vi.useRealTimers();
  });
});
