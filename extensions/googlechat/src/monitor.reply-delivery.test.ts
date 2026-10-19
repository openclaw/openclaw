import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { chunkMarkdownTextWithMode } from "openclaw/plugin-sdk/reply-chunking";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../test-support/runtime-spies.js";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import { createGoogleChatTypingMessage, deliverGoogleChatReply } from "./monitor-reply-delivery.js";
import type { GoogleChatCoreRuntime } from "./monitor-types.js";

const mocks = vi.hoisted(() => ({
  deleteGoogleChatMessage: vi.fn(),
  sendGoogleChatMessage: vi.fn(),
  updateGoogleChatMessage: vi.fn(),
}));

vi.mock("./api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api.js")>()),
  ...mocks,
}));

const account = {
  accountId: "default",
  enabled: true,
  credentialSource: "inline",
  config: {},
} as ResolvedGoogleChatAccount;

const SPACE = "spaces/AAA";
const ROOT = `${SPACE}/threads/root`;
const TYPING = `${SPACE}/messages/typing`;
const typingMessage = createGoogleChatTypingMessage({
  messageName: TYPING,
  requestedThreadName: ROOT,
  deliveredThreadName: ROOT,
});
const typingTarget = { account, messageName: TYPING };
const sent = (text: string, thread?: string) => ({ account, space: SPACE, text, thread });

function deliver(
  payload: Parameters<typeof deliverGoogleChatReply>[0]["payload"],
  {
    typing = true,
    chunks,
    limit,
    ...overrides
  }: Partial<Omit<Parameters<typeof deliverGoogleChatReply>[0], "payload">> & {
    typing?: boolean;
    chunks?: readonly string[];
    limit?: number;
  } = {},
) {
  return deliverGoogleChatReply({
    payload,
    account: limit ? { ...account, config: { textChunkLimit: limit } } : account,
    spaceId: SPACE,
    runtime: createRuntimeSpies(),
    core: createCore(chunks),
    config: {},
    typingMessage: typing ? typingMessage : undefined,
    ...overrides,
  });
}

function createCore(chunks?: readonly string[]) {
  return {
    channel: {
      text: {
        resolveChunkMode: vi.fn(() => "markdown"),
        chunkMarkdownTextWithMode: vi.fn(
          (text: string, limit: number, mode: "length" | "newline") =>
            chunks ?? chunkMarkdownTextWithMode(text, limit, mode),
        ),
      },
      media: {
        readRemoteMediaBuffer: vi.fn(async () => ({ buffer: Buffer.from("image") })),
      },
    },
  } as unknown as GoogleChatCoreRuntime;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sendGoogleChatMessage.mockResolvedValue(null);
  mocks.updateGoogleChatMessage.mockResolvedValue({});
});

afterAll(() => {
  vi.doUnmock("./api.js");
  vi.resetModules();
});

describe("Google Chat reply delivery", () => {
  it("formats Markdown for typing updates and subsequent sends", async () => {
    const first = "a".repeat(55);
    const second = "b".repeat(55);
    await deliver({ text: `**${first}**\n\n**${second}**`, replyToId: ROOT }, { limit: 64 });

    expect(mocks.updateGoogleChatMessage).toHaveBeenCalledTimes(1);
    expect(mocks.updateGoogleChatMessage.mock.calls[0]?.[0]?.text.trim()).toBe(`*${first}*`);
    expect(mocks.sendGoogleChatMessage).toHaveBeenCalledTimes(1);
    expect(mocks.sendGoogleChatMessage.mock.calls[0]?.[0]?.text.trim()).toBe(`*${second}*`);
  });

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

    expect(mocks.updateGoogleChatMessage).toHaveBeenCalledWith({
      ...typingTarget,
      text: "first chunk",
    });
    expect(mocks.sendGoogleChatMessage).not.toHaveBeenCalled();
    expect(statusSink).not.toHaveBeenCalled();
  });

  it.each([
    ["provider fallback", "spaces/AAA/threads/fallback", "spaces/AAA/threads/fallback"],
    ["requested when metadata is omitted", undefined, "spaces/AAA/threads/requested"],
  ])("continues later chunks in the %s thread", async (_name, threadName, expectedThread) => {
    for (const name of ["first", "second"]) {
      mocks.sendGoogleChatMessage.mockResolvedValueOnce({
        messageName: `${SPACE}/messages/${name}`,
        threadName,
      });
    }

    await deliver(
      { text: "two chunks", replyToId: "spaces/AAA/threads/requested" },
      {
        chunks: ["first chunk", "second chunk"],
        typing: false,
      },
    );

    expect(mocks.sendGoogleChatMessage).toHaveBeenNthCalledWith(
      1,
      sent("first chunk", "spaces/AAA/threads/requested"),
    );
    expect(mocks.sendGoogleChatMessage).toHaveBeenNthCalledWith(
      2,
      sent("second chunk", expectedThread),
    );
  });

  it("replaces the typing message for a valid explicit thread target", async () => {
    mocks.sendGoogleChatMessage.mockResolvedValue({ messageName: "spaces/AAA/messages/reply" });

    await deliver({ text: "retargeted reply", replyToId: "spaces/AAA/threads/other" });

    expect(mocks.deleteGoogleChatMessage).toHaveBeenCalledWith(typingTarget);
    expect(mocks.updateGoogleChatMessage).not.toHaveBeenCalled();
    expect(mocks.sendGoogleChatMessage).toHaveBeenCalledWith(
      sent("retargeted reply", "spaces/AAA/threads/other"),
    );
  });

  it.each([
    {
      payload: { mediaUrl: "https://example.invalid/reply.png" },
      reason:
        "Google Chat outbound attachments require user OAuth and no text fallback is available.",
    },
    {
      payload: { text: "<div></div>" },
      reason: "Google Chat reply has no visible text after formatting.",
    },
  ])("cleans up typing and rejects undeliverable replies: $reason", async ({ payload, reason }) => {
    const core = createCore();

    await expect(deliver({ ...payload, replyToId: ROOT }, { core })).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof PlatformMessageNotDispatchedError &&
        !error.retryable &&
        error.message === reason,
    );

    expect(mocks.deleteGoogleChatMessage).toHaveBeenCalledWith(typingTarget);
    expect(core.channel.media.readRemoteMediaBuffer).not.toHaveBeenCalled();
    expect(mocks.updateGoogleChatMessage).not.toHaveBeenCalled();
    expect(mocks.sendGoogleChatMessage).not.toHaveBeenCalled();
  });
});
