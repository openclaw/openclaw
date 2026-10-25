import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { chunkMarkdownTextWithMode } from "openclaw/plugin-sdk/reply-chunking";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../test-support/runtime-spies.js";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import { GoogleChatApiError } from "./api.js";
import type { GoogleChatCoreRuntime, WebhookTarget } from "./monitor-types.js";
import { createGoogleChatReplyDeliveryHarness } from "./monitor.reply-delivery.test-support.js";

const mocks = vi.hoisted(() => ({
  deleteGoogleChatMessage: vi.fn(),
  sendGoogleChatMessage: vi.fn(),
  updateGoogleChatMessage: vi.fn(),
}));

vi.mock("./api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api.js")>()),
  ...mocks,
  sendGoogleChatMessage: (
    params: Parameters<typeof import("./api.js").sendGoogleChatMessage>[0],
  ) =>
    params.text === "_OpenClaw is typing..._"
      ? Promise.resolve({
          messageName: "spaces/AAA/messages/typing",
          threadName: params.thread,
        })
      : mocks.sendGoogleChatMessage(params),
}));

const harness = createGoogleChatReplyDeliveryHarness();
const chunkText = vi.fn(chunkMarkdownTextWithMode);
const readMedia = vi.fn(async () => ({ buffer: Buffer.from("image") }));
const core = {
  ...harness.core,
  channel: {
    ...harness.core.channel,
    text: { resolveChunkMode: () => "markdown", chunkMarkdownTextWithMode: chunkText },
    media: { readRemoteMediaBuffer: readMedia },
  },
} as unknown as GoogleChatCoreRuntime;
const account = {
  accountId: "default",
  enabled: true,
  credentialSource: "inline",
  config: { replyToMode: "all", typingIndicator: "message" },
} as ResolvedGoogleChatAccount;
const noTypingAccount: ResolvedGoogleChatAccount = {
  ...account,
  config: { replyToMode: "all", typingIndicator: "none" },
};

const SPACE = "spaces/AAA";
const ROOT = `${SPACE}/threads/root`;
const REQUESTED = `${SPACE}/threads/requested`;
const TYPING = `${SPACE}/messages/typing`;
const MEDIA = "https://example.invalid/reply.png";
const typingTarget = { account, messageName: TYPING };
const sent = (text: string, thread?: string, sendAccount = account) => ({
  account: sendAccount,
  space: SPACE,
  text,
  thread,
});
function expectSent(text: string, thread?: string, sendAccount = account) {
  expect(mocks.sendGoogleChatMessage).toHaveBeenCalledWith(sent(text, thread, sendAccount));
}

function expectUpdated(text: string) {
  expect(mocks.updateGoogleChatMessage).toHaveBeenCalledWith({ ...typingTarget, text });
}

function deliver(
  payload: ReplyPayload,
  {
    typing = true,
    chunks,
    limit,
    statusSink,
  }: {
    typing?: boolean;
    chunks?: string[];
    limit?: number;
    statusSink?: WebhookTarget["statusSink"];
  } = {},
) {
  if (chunks) {
    chunkText.mockReturnValue(chunks);
  }
  const selectedAccount = typing ? account : noTypingAccount;
  return harness.process(
    {
      account: limit
        ? { ...selectedAccount, config: { ...selectedAccount.config, textChunkLimit: limit } }
        : selectedAccount,
      runtime: createRuntimeSpies(),
      core,
      config: {},
      statusSink,
    },
    async (delivery) => delivery.deliver(payload, { kind: "final" }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  chunkText.mockReset().mockImplementation(chunkMarkdownTextWithMode);
  mocks.sendGoogleChatMessage.mockResolvedValue(null);
  mocks.updateGoogleChatMessage.mockResolvedValue({});
});

afterAll(() => {
  vi.doUnmock("./api.js");
  vi.resetModules();
});

describe("Google Chat reply delivery", () => {
  it.each([
    [undefined, false, false],
    ["caption", true, false],
    ["caption", true, true],
  ] as const)(
    "delivers media caption=%s typing=%s missing=%s",
    async (text, typing, missingTyping) => {
      const expectedText = `${text ? "caption\n\n" : ""}Attachment: ${MEDIA}`;
      if (missingTyping) {
        mocks.updateGoogleChatMessage.mockRejectedValueOnce(
          new GoogleChatApiError(404, "Not Found"),
        );
      }
      await deliver({ text, mediaUrl: MEDIA, replyToId: ROOT }, { typing });
      if (typing) {
        expectUpdated(expectedText);
      }
      if (!typing || missingTyping) {
        expectSent(expectedText, ROOT, typing ? account : noTypingAccount);
      } else {
        expect(mocks.sendGoogleChatMessage).not.toHaveBeenCalled();
      }
    },
  );

  it("preserves accepted caption receipts when a later attachment-link chunk fails", async () => {
    const caption = "a".repeat(35);
    const error = new Error("send failed");
    mocks.sendGoogleChatMessage
      .mockResolvedValueOnce({ messageName: `${SPACE}/messages/caption` })
      .mockRejectedValueOnce(error);

    await expect(
      deliver(
        { text: caption, mediaUrl: "https://example.invalid/a.png" },
        { typing: false, limit: 50 },
      ),
    ).rejects.toSatisfy(
      (failure: unknown) =>
        isChannelPartialDeliveryError(failure) &&
        failure.deliveryResult.messageIds?.includes(`${SPACE}/messages/caption`) === true &&
        failure.deliveryResult.content?.trim() === caption,
    );
    expect(mocks.sendGoogleChatMessage).toHaveBeenCalledTimes(2);
  });

  it("formats Markdown for typing updates and subsequent sends", async () => {
    const first = "a".repeat(55);
    const second = "b".repeat(55);
    await deliver({ text: `**${first}**\n\n**${second}**`, replyToId: ROOT }, { limit: 64 });

    expect(mocks.updateGoogleChatMessage).toHaveBeenCalledTimes(1);
    expect(mocks.updateGoogleChatMessage.mock.calls[0]?.[0]?.text.trim()).toBe(`*${first}*`);
    expect(mocks.sendGoogleChatMessage).toHaveBeenCalledTimes(1);
    expect(mocks.sendGoogleChatMessage.mock.calls[0]?.[0]?.text.trim()).toBe(`*${second}*`);
  });

  it.each([undefined, "https://example.invalid/code.png"])(
    "keeps indented code intact with media %s",
    async (mediaUrl) => {
      await deliver({ text: "    const answer = 42;", mediaUrl }, { typing: false });

      expectSent(
        `\`\`\`\nconst answer = 42;\n\`\`\`${mediaUrl ? `\nAttachment: ${mediaUrl}` : ""}`,
        undefined,
        noTypingAccount,
      );
    },
  );

  it("preserves reference links across configured source chunk boundaries", async () => {
    const replyText = `${"A".repeat(45)} [docs][ref]\n\n[ref]: https://example.com`;
    await deliver({ text: replyText }, { limit: 64, typing: false });

    const deliveredText = mocks.sendGoogleChatMessage.mock.calls
      .map((call) => call[0]?.text)
      .join("");
    expect(deliveredText).toContain("<https://example.com|docs>");
    expect(deliveredText).not.toContain("[ref]");
  });

  it("does not resend the first chunk when the typing update result is ambiguous", async () => {
    const statusSink = vi.fn();
    const updateError = new Error("response lost");
    mocks.updateGoogleChatMessage.mockRejectedValueOnce(updateError);

    await expect(
      deliver(
        { text: "first chunk\n\nsecond chunk", replyToId: ROOT },
        { chunks: ["first chunk", "second chunk"], statusSink },
      ),
    ).rejects.toBe(updateError);

    expectUpdated("first chunk");
    expect(mocks.sendGoogleChatMessage).not.toHaveBeenCalled();
    expect(statusSink).not.toHaveBeenCalled();
  });

  it.each([
    ["provider fallback", `${SPACE}/threads/fallback`, `${SPACE}/threads/fallback`],
    ["requested when metadata is omitted", undefined, REQUESTED],
  ])("continues later chunks in the %s thread", async (_name, threadName, expectedThread) => {
    for (const name of ["first", "second"]) {
      mocks.sendGoogleChatMessage.mockResolvedValueOnce({
        messageName: `${SPACE}/messages/${name}`,
        threadName,
      });
    }

    await deliver(
      { text: "two chunks", replyToId: REQUESTED },
      { chunks: ["first chunk", "second chunk"], typing: false },
    );

    expect(mocks.sendGoogleChatMessage.mock.calls).toEqual([
      [sent("first chunk", REQUESTED, noTypingAccount)],
      [sent("second chunk", expectedThread, noTypingAccount)],
    ]);
  });

  it("replaces the typing message for a valid explicit thread target", async () => {
    mocks.sendGoogleChatMessage.mockResolvedValue({ messageName: "spaces/AAA/messages/reply" });

    await deliver({ text: "retargeted reply", replyToId: "spaces/AAA/threads/other" });

    expect(mocks.deleteGoogleChatMessage).toHaveBeenCalledWith(typingTarget);
    expect(mocks.updateGoogleChatMessage).not.toHaveBeenCalled();
    expectSent("retargeted reply", "spaces/AAA/threads/other");
  });

  it.each([
    {
      payload: { mediaUrl: "/tmp/reply.png" },
      reason: "Google Chat outbound attachments require remote HTTP(S) URLs.",
    },
    {
      payload: { text: "<div></div>" },
      reason: "Google Chat reply has no visible text after formatting.",
    },
  ])("cleans up typing and rejects undeliverable replies: $reason", async ({ payload, reason }) => {
    await expect(deliver({ ...payload, replyToId: ROOT })).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof PlatformMessageNotDispatchedError &&
        !error.retryable &&
        error.message === reason,
    );

    expect(mocks.deleteGoogleChatMessage).toHaveBeenCalledWith(typingTarget);
    expect(readMedia).not.toHaveBeenCalled();
    expect(mocks.updateGoogleChatMessage).not.toHaveBeenCalled();
    expect(mocks.sendGoogleChatMessage).not.toHaveBeenCalled();
  });
});
