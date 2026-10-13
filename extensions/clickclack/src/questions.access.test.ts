// Exercises card answer authority through the real inbound access owner.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createInboundAccountConfig,
  createInboundAgentAccount,
  createInboundAuthor,
  createInboundMessage,
  createInboundRuntime,
  publishInboundAccountConfig,
} from "./inbound.test-support.js";
import { forwardClickClackQuestionAnswer } from "./questions.js";
import { setClickClackRuntime } from "./runtime.js";
import type { ClickClackAccountLifetime, ClickClackMessage } from "./types.js";

const hoisted = vi.hoisted(() => ({
  resolveAnswers: vi.fn(),
  cancelQuestion: vi.fn(),
  gatewayWrite: vi.fn(),
  client: { message: vi.fn(), resolveQuestion: vi.fn() },
}));

vi.mock("openclaw/plugin-sdk/question-gateway-runtime", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("openclaw/plugin-sdk/question-gateway-runtime")>();
  return {
    ...original,
    questionGatewayRuntime: {
      ...original.questionGatewayRuntime,
      resolveAnswers: hoisted.resolveAnswers,
      cancelQuestion: hoisted.cancelQuestion,
    },
  };
});
vi.mock("./http-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./http-client.js")>()),
  createClickClackClient: () => hoisted.client,
}));

const questionId = "ask_0123456789abcdef0123456789abcdef";
let abort: AbortController;

beforeEach(() => {
  vi.resetAllMocks();
  abort = new AbortController();
  hoisted.client.resolveQuestion.mockResolvedValue({});
});
afterEach(() => abort.abort());

it.each([false, true])(
  "accepts an explicit card answer with requireMention=%s",
  async (requireMention) => {
    const runtime = createInboundRuntime(true);
    setClickClackRuntime(runtime);
    const account = createInboundAgentAccount({ requireMention });
    publishInboundAccountConfig(runtime, account);
    const lifetime: ClickClackAccountLifetime = {
      cfg: createInboundAccountConfig(account),
      account,
      abortSignal: abort.signal,
      runInAccountContext: (run) => run(),
    };
    hoisted.client.message.mockResolvedValue(submittedCard(account.botUserId!));
    hoisted.resolveAnswers.mockImplementationOnce(
      async ({ authorize }: { authorize: () => Promise<boolean> }) => {
        if (!(await authorize())) {
          return { status: "denied" };
        }
        hoisted.gatewayWrite();
        return { status: "answered" };
      },
    );

    await forwardClickClackQuestionAnswer({ lifetime, messageId: "msg_card" });

    expect(hoisted.gatewayWrite).toHaveBeenCalledOnce();
    expect(hoisted.client.resolveQuestion).toHaveBeenCalledExactlyOnceWith("msg_card", {
      status: "answered",
      expected_version: 2,
    });
  },
);

it.each(["answer", "skip"] as const)(
  "refuses a %s after sender policy changes during the awaited Gateway read",
  async (action) => {
    const runtime = createInboundRuntime(true);
    setClickClackRuntime(runtime);
    const account = createInboundAgentAccount({ requireMention: true });
    publishInboundAccountConfig(runtime, account);
    const lifetime: ClickClackAccountLifetime = {
      cfg: createInboundAccountConfig(account),
      account,
      abortSignal: abort.signal,
      runInAccountContext: (run) => run(),
    };
    hoisted.client.message.mockResolvedValue(submittedCard(account.botUserId!, action === "skip"));
    const resolve = action === "skip" ? hoisted.cancelQuestion : hoisted.resolveAnswers;
    resolve.mockImplementationOnce(async ({ authorize }: { authorize: () => Promise<boolean> }) => {
      // The old transport is still alive during config publication. Its captured
      // wildcard ingress remains allowed, but the current sender policy does not.
      publishInboundAccountConfig(runtime, {
        ...account,
        allowFrom: ["usr_someone_else"],
        config: { ...account.config, allowFrom: ["usr_someone_else"] },
      });
      if (!(await authorize())) {
        return { status: "denied" };
      }
      hoisted.gatewayWrite();
      return { status: action === "skip" ? "cancelled" : "answered" };
    });

    await forwardClickClackQuestionAnswer({ lifetime, messageId: "msg_card" });

    expect(resolve).toHaveBeenCalledOnce();
    expect(hoisted.gatewayWrite).not.toHaveBeenCalled();
    expect(hoisted.client.resolveQuestion).toHaveBeenCalledExactlyOnceWith("msg_card", {
      status: "open",
      note: "This agent does not accept answers from that person.",
      expected_version: 2,
    });
  },
);

function submittedCard(botUserId: string, skipped = false): ClickClackMessage {
  return createInboundMessage({
    id: "msg_card",
    author_id: botUserId,
    body: "Agent needs input",
    question: {
      status: "submitted",
      external_id: questionId,
      expires_at: "2026-10-13T12:00:00Z",
      allow_skip: true,
      items: [],
      version: 2,
      response: {
        source: "clickclack",
        ...(skipped ? { skipped: true } : { answers: { date: ["Tuesday"] } }),
        responder: createInboundAuthor({ id: "usr_dana", display_name: "Dana", handle: "dana" }),
      },
    },
  });
}
