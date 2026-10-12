// Googlechat tests cover monitor.reply delivery plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
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
  deleteGoogleChatMessage: mocks.deleteGoogleChatMessage,
  sendGoogleChatMessage: mocks.sendGoogleChatMessage,
  updateGoogleChatMessage: mocks.updateGoogleChatMessage,
}));

const account = {
  accountId: "default",
  enabled: true,
  credentialSource: "inline",
  config: {},
} as ResolvedGoogleChatAccount;

const config = {} as OpenClawConfig;

function createCore(params?: { chunks?: readonly string[] }) {
  return {
    channel: {
      text: {
        resolveChunkMode: vi.fn(() => "markdown"),
        chunkMarkdownTextWithMode: vi.fn(
          (text: string, limit: number, mode: "length" | "newline") =>
            params?.chunks ?? chunkMarkdownTextWithMode(text, limit, mode),
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
    const limitedAccount = {
      ...account,
      config: { ...account.config, textChunkLimit: 64 },
    } as ResolvedGoogleChatAccount;

    await deliverGoogleChatReply({
      payload: { text: `**${first}**\n\n**${second}**`, replyToId: "spaces/AAA/threads/root" },
      account: limitedAccount,
      spaceId: "spaces/AAA",
      runtime: createRuntime(),
      core: createCore(),
      config,
      typingMessage: createGoogleChatTypingMessage({
        messageName: "spaces/AAA/messages/typing",
        requestedThreadName: "spaces/AAA/threads/root",
        deliveredThreadName: "spaces/AAA/threads/root",
      }),
    });

    expect(mocks.updateGoogleChatMessage).toHaveBeenCalledTimes(1);
    expect(mocks.updateGoogleChatMessage.mock.calls[0]?.[0]).toMatchObject({
      account: limitedAccount,
      messageName: "spaces/AAA/messages/typing",
    });
    expect(mocks.updateGoogleChatMessage.mock.calls[0]?.[0]?.text.trim()).toBe(`*${first}*`);
    expect(mocks.sendGoogleChatMessage).toHaveBeenCalledTimes(1);
    expect(mocks.sendGoogleChatMessage.mock.calls[0]?.[0]).toMatchObject({
      account: limitedAccount,
      space: "spaces/AAA",
      thread: "spaces/AAA/threads/root",
    });
    expect(mocks.sendGoogleChatMessage.mock.calls[0]?.[0]?.text.trim()).toBe(`*${second}*`);
  });

  it("preserves reference links across configured source chunk boundaries", async () => {
    const replyText = `${"A".repeat(45)} [docs][ref]\n\n[ref]: https://example.com`;
    const limitedAccount = {
      ...account,
      config: { ...account.config, textChunkLimit: 64 },
    } as ResolvedGoogleChatAccount;

    await deliverGoogleChatReply({
      payload: { text: replyText },
      account: limitedAccount,
      spaceId: "spaces/AAA",
      runtime: createRuntime(),
      core: createCore(),
      config,
    });

    const deliveredText = mocks.sendGoogleChatMessage.mock.calls
      .map((call) => call[0]?.text)
      .join("");
    expect(deliveredText).toContain("<https://example.com|docs>");
    expect(deliveredText).not.toContain("[ref]");
  });

  it("cleans up typing and rejects text removed by formatting", async () => {
    await expect(
      deliverGoogleChatReply({
        payload: { text: "<div></div>" },
        account,
        spaceId: "spaces/AAA",
        runtime: createRuntime(),
        core: createCore(),
        config,
        typingMessage: createGoogleChatTypingMessage({
          messageName: "spaces/AAA/messages/typing",
        }),
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof PlatformMessageNotDispatchedError &&
        !error.retryable &&
        error.message === "Google Chat reply has no visible text after formatting.",
    );

    expect(mocks.deleteGoogleChatMessage).toHaveBeenCalledWith({
      account,
      messageName: "spaces/AAA/messages/typing",
    });
    expect(mocks.updateGoogleChatMessage).not.toHaveBeenCalled();
    expect(mocks.sendGoogleChatMessage).not.toHaveBeenCalled();
  });

  it("does not resend the first chunk when the typing update result is ambiguous", async () => {
    const core = createCore({ chunks: ["first chunk", "second chunk"] });
    const runtime = createRuntimeSpies();
    const statusSink = vi.fn();
    const updateError = new Error("response lost");
    mocks.updateGoogleChatMessage.mockRejectedValueOnce(updateError);

    await expect(
      deliverGoogleChatReply({
        payload: { text: "first chunk\n\nsecond chunk", replyToId: "spaces/AAA/threads/root" },
        account,
        spaceId: "spaces/AAA",
        runtime,
        core,
        config,
        statusSink,
        typingMessage: {
          placement: "thread",
          name: "spaces/AAA/messages/typing",
          requestedThreadName: "spaces/AAA/threads/root",
          deliveredThreadName: "spaces/AAA/threads/root",
        },
      }),
    ).rejects.toBe(updateError);

    expect(mocks.updateGoogleChatMessage).toHaveBeenCalledWith({
      account,
      messageName: "spaces/AAA/messages/typing",
      text: "first chunk",
    });
    expect(mocks.sendGoogleChatMessage).not.toHaveBeenCalled();
    expect(statusSink).not.toHaveBeenCalled();
  });

  it.each([
    ["provider fallback", "spaces/AAA/threads/fallback", "spaces/AAA/threads/fallback"],
    ["requested when metadata is omitted", undefined, "spaces/AAA/threads/requested"],
  ])("continues later chunks in the %s thread", async (_name, threadName, expectedThread) => {
    const core = createCore({ chunks: ["first chunk", "second chunk"] });
    const runtime = createRuntimeSpies();
    mocks.sendGoogleChatMessage
      .mockResolvedValueOnce({
        messageName: "spaces/AAA/messages/first",
        threadName,
      })
      .mockResolvedValueOnce({
        messageName: "spaces/AAA/messages/second",
        threadName,
      });

    await deliverGoogleChatReply({
      payload: { text: "two chunks", replyToId: "spaces/AAA/threads/requested" },
      account,
      spaceId: "spaces/AAA",
      runtime,
      core,
      config,
    });

    expect(mocks.sendGoogleChatMessage).toHaveBeenNthCalledWith(1, {
      account,
      space: "spaces/AAA",
      text: "first chunk",
      thread: "spaces/AAA/threads/requested",
    });
    expect(mocks.sendGoogleChatMessage).toHaveBeenNthCalledWith(2, {
      account,
      space: "spaces/AAA",
      text: "second chunk",
      thread: expectedThread,
    });
  });

  it("replaces the typing message for a valid explicit thread target", async () => {
    const core = createCore();
    mocks.sendGoogleChatMessage.mockResolvedValue({ messageName: "spaces/AAA/messages/reply" });

    await deliverGoogleChatReply({
      payload: {
        text: "retargeted reply",
        replyToId: "spaces/AAA/threads/other",
      },
      account,
      spaceId: "spaces/AAA",
      runtime: createRuntimeSpies(),
      core,
      config,
      typingMessage: createGoogleChatTypingMessage({
        messageName: "spaces/AAA/messages/typing",
        requestedThreadName: "spaces/AAA/threads/root",
        deliveredThreadName: "spaces/AAA/threads/root",
      }),
    });

    expect(mocks.deleteGoogleChatMessage).toHaveBeenCalledWith({
      account,
      messageName: "spaces/AAA/messages/typing",
    });
    expect(mocks.updateGoogleChatMessage).not.toHaveBeenCalled();
    expect(mocks.sendGoogleChatMessage).toHaveBeenCalledWith({
      account,
      space: "spaces/AAA",
      text: "retargeted reply",
      thread: "spaces/AAA/threads/other",
    });
  });

  it("cleans up typing and rejects media-only replies without provider upload access", async () => {
    const core = createCore();
    const runtime = createRuntimeSpies();

    await expect(
      deliverGoogleChatReply({
        payload: {
          mediaUrl: "https://example.invalid/reply.png",
          replyToId: "spaces/AAA/threads/root",
        },
        account,
        spaceId: "spaces/AAA",
        runtime,
        core,
        config,
        typingMessage: {
          placement: "thread",
          name: "spaces/AAA/messages/typing",
          requestedThreadName: "spaces/AAA/threads/root",
          deliveredThreadName: "spaces/AAA/threads/root",
        },
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof PlatformMessageNotDispatchedError &&
        !error.retryable &&
        error.message ===
          "Google Chat outbound attachments require user OAuth and no text fallback is available.",
    );

    expect(mocks.deleteGoogleChatMessage).toHaveBeenCalledWith({
      account,
      messageName: "spaces/AAA/messages/typing",
    });
    expect(core.channel.media.readRemoteMediaBuffer).not.toHaveBeenCalled();
    expect(mocks.updateGoogleChatMessage).not.toHaveBeenCalled();
    expect(mocks.sendGoogleChatMessage).not.toHaveBeenCalled();
  });
});
