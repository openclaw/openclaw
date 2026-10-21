import { createChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { verifyChannelMessageAdapterCapabilityProofs } from "openclaw/plugin-sdk/channel-outbound";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { afterAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { IrcClient } from "./client.js";
import * as ircRuntime from "./runtime.js";
import type { CoreConfig } from "./types.js";

const hoisted = vi.hoisted(() => {
  const currentConfig = vi.fn(() => ({}));
  const stripMarkdown = vi.fn((text: string) => text);
  const record = vi.fn();
  const buildIrcConnectOptions = vi.fn(
    (_account: unknown, overrides: Record<string, unknown> = {}) => overrides,
  );
  return {
    currentConfig,
    stripMarkdown,
    record,
    connectIrcClient: vi.fn(),
    buildIrcConnectOptions,
  };
});

vi.mock("./client.js", () => ({
  connectIrcClient: hoisted.connectIrcClient,
}));

vi.mock("./connect-options.js", () => ({
  buildIrcConnectOptions: hoisted.buildIrcConnectOptions,
}));

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    randomUUID: () => "irc-msg-1",
  };
});

vi.mock("openclaw/plugin-sdk/text-chunking", async () => {
  const original = (await vi.importActual("openclaw/plugin-sdk/text-chunking")) as Record<
    string,
    unknown
  >;
  return {
    ...original,
    stripMarkdown: hoisted.stripMarkdown,
  };
});

import { ircPlugin } from "./channel.js";
import { ircOutboundBaseAdapter } from "./outbound-base.js";
import { sendIrcMessages, sendMessageIrc } from "./send.js";

const ircMessageAdapter = ircPlugin.message!;
const sendFormattedIrcText = ircPlugin.outbound!.sendFormattedText!;

function resetHoistedMocks() {
  hoisted.currentConfig.mockReset();
  hoisted.stripMarkdown.mockReset().mockImplementation((text: string) => text);
  hoisted.record.mockReset();
  hoisted.connectIrcClient.mockReset();
  hoisted.buildIrcConnectOptions.mockReset().mockReturnValue({});
}

afterAll(() => {
  vi.doUnmock("./client.js");
  vi.doUnmock("./connect-options.js");
  vi.doUnmock("node:crypto");
  vi.doUnmock("openclaw/plugin-sdk/text-chunking");
  vi.resetModules();
});

const providedCfg: CoreConfig = {
  channels: { irc: { host: "irc.example.com", nick: "openclaw" } },
};

function createClient(isReady = () => true) {
  const client = {
    nick: "openclaw",
    isReady: vi.fn(isReady),
    join: vi.fn(),
    sendPrivmsg: vi.fn(),
    quit: vi.fn(),
    close: vi.fn(),
  } satisfies IrcClient;
  hoisted.connectIrcClient.mockResolvedValue(client);
  return client;
}

describe("sendMessageIrc cfg threading", () => {
  beforeEach(() => {
    resetHoistedMocks();
    ircRuntime.setIrcRuntime(
      createPluginRuntimeMock({
        config: { current: hoisted.currentConfig },
        channel: { activity: { record: hoisted.record } },
      }),
    );
  });

  it("uses explicitly provided cfg without loading runtime config", async () => {
    const namedCfg = {
      channels: {
        irc: {
          host: "irc.example.com",
          nick: "openclaw",
          accounts: {
            work: {
              host: "irc.example.com",
              nick: "workbot",
            },
          },
        },
      },
    } as unknown as CoreConfig;
    const client = createClient();

    const result = await sendMessageIrc("#room", "hello", {
      cfg: namedCfg,
      accountId: "work",
    });

    expect(hoisted.currentConfig).not.toHaveBeenCalled();
    expect(client.sendPrivmsg).toHaveBeenCalledWith("#room", "hello", undefined);
    expect(hoisted.record).toHaveBeenCalledWith({
      channel: "irc",
      accountId: "work",
      direction: "outbound",
    });
    expect(result.target).toBe("#room");
    expect(result.messageId).toBeTypeOf("string");
    expect(result.messageId.length).toBeGreaterThan(0);
    expect(result.receipt.sentAt).toBeTypeOf("number");
    expect(result.receipt.sentAt).toBeGreaterThan(0);
    expect({ ...result.receipt, sentAt: 123 }).toEqual({
      primaryPlatformMessageId: "irc-msg-1",
      platformMessageIds: ["irc-msg-1"],
      parts: [
        {
          platformMessageId: "irc-msg-1",
          kind: "text",
          index: 0,
          raw: {
            channel: "irc",
            conversationId: "#room",
            messageId: "irc-msg-1",
          },
        },
      ],
      sentAt: 123,
      sourceResults: [{ channel: "irc", messageId: "irc-msg-1" }],
      raw: [
        {
          channel: "irc",
          conversationId: "#room",
          messageId: "irc-msg-1",
        },
      ],
    });
  });

  it("fails hard when cfg is omitted", async () => {
    const client = createClient();

    await expect(sendMessageIrc("#ops", "ping", {} as never)).rejects.toThrow(
      "IRC send requires a resolved runtime config",
    );

    expect(hoisted.currentConfig).not.toHaveBeenCalled();
    expect(client.sendPrivmsg).not.toHaveBeenCalled();
    expect(hoisted.record).not.toHaveBeenCalled();
  });

  it("sends with provided cfg when runtime activity recording is unavailable", async () => {
    const client = createClient();
    const runtime = vi.spyOn(ircRuntime, "getOptionalIrcRuntime").mockReturnValueOnce(null);
    onTestFinished(() => runtime.mockRestore());

    const result = await sendMessageIrc("#room", "hello", {
      cfg: providedCfg,
    });

    expect(hoisted.currentConfig).not.toHaveBeenCalled();
    expect(hoisted.record).not.toHaveBeenCalled();
    expect(client.sendPrivmsg).toHaveBeenCalledWith("#room", "hello", undefined);
    expect(result.target).toBe("#room");
    expect(result.messageId).toBeTypeOf("string");
    expect(result.messageId.length).toBeGreaterThan(0);
  });

  it("rejects stripped-empty replies before adding reply metadata", async () => {
    const client = createClient();
    hoisted.stripMarkdown.mockReturnValue("");

    await expect(
      sendMessageIrc("#room", "#", {
        cfg: providedCfg,
        replyTo: "irc-parent-1",
      }),
    ).rejects.toThrow("Message must be non-empty for IRC sends");

    expect(client.sendPrivmsg).not.toHaveBeenCalled();
    expect(hoisted.record).not.toHaveBeenCalled();
  });

  it("uses one transient connection for a chunked outbound message", async () => {
    const client = createClient();
    const onDeliveryResult = vi.fn();
    const onPlatformSendDispatch = vi.fn();
    const text = Array.from({ length: 80 }, (_, index) => `word-${index}`).join(" ");
    const chunks = ircOutboundBaseAdapter.chunker(text, 350);

    const results = await sendFormattedIrcText({
      cfg: providedCfg,
      to: "#room",
      text,
      replyToId: "parent-1",
      replyToIdSource: "explicit",
      replyToMode: "all",
      onDeliveryResult,
      onPlatformSendDispatch,
    });

    expect(hoisted.connectIrcClient).toHaveBeenCalledOnce();
    expect(client.join).toHaveBeenCalledOnce();
    expect(client.sendPrivmsg.mock.calls).toEqual(
      chunks.map((chunk) => ["#room", chunk, "parent-1"]),
    );
    expect(client.quit).toHaveBeenCalledOnce();
    expect(onPlatformSendDispatch).toHaveBeenCalledTimes(chunks.length);
    expect(onDeliveryResult).toHaveBeenCalledTimes(chunks.length);
    expect(results).toHaveLength(chunks.length);
  });

  it.each(
    [
      { kind: "formatted", sendMessage: sendFormattedIrcText },
      { kind: "text", sendMessage: ircMessageAdapter.send!.text! },
      { kind: "media", sendMessage: ircMessageAdapter.send!.media! },
    ].flatMap(({ kind, sendMessage }) =>
      ["connect", "dispatch"].map((phase) => ({ kind, sendMessage, phase })),
    ),
  )("cancels $kind sends during $phase", async ({ sendMessage, phase }) => {
    const client = createClient();
    let resolveConnect!: (client: IrcClient) => void;
    const connect = new Promise<IrcClient>((resolve) => {
      resolveConnect = resolve;
    });
    hoisted.buildIrcConnectOptions.mockImplementation((_account, overrides = {}) => overrides);
    hoisted.connectIrcClient.mockReturnValue(connect);
    const abortController = new AbortController();

    const onPlatformSendDispatch = vi.fn(async () => {
      await Promise.resolve();
      abortController.abort();
    });
    const send = sendMessage({
      cfg: providedCfg,
      to: "#room",
      text: "hello",
      mediaUrl: "https://example.com/image.png",
      signal: abortController.signal,
      abortSignal: abortController.signal,
      onPlatformSendDispatch,
    });
    await vi.waitFor(() => expect(hoisted.connectIrcClient).toHaveBeenCalledOnce());
    if (phase === "connect") {
      abortController.abort();
    }
    resolveConnect(client);

    await expect(send).rejects.toMatchObject({ name: "AbortError" });
    expect(hoisted.buildIrcConnectOptions).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ abortSignal: abortController.signal }),
    );
    expect(client.join).toHaveBeenCalledTimes(phase === "connect" ? 0 : 1);
    expect(onPlatformSendDispatch).toHaveBeenCalledTimes(phase === "connect" ? 0 : 1);
    expect(client.sendPrivmsg).not.toHaveBeenCalled();
    expect(client.quit).toHaveBeenCalledOnce();
  });

  it("stops before recording another chunk after the connection closes", async () => {
    let ready = true;
    const client = createClient(() => ready);
    const onDeliveryResult = vi.fn(() => {
      ready = false;
    });
    const onPlatformSendDispatch = vi.fn();
    const text = Array.from({ length: 80 }, (_, index) => `word-${index}`).join(" ");

    await expect(
      sendFormattedIrcText({
        cfg: providedCfg,
        to: "#room",
        text,
        onDeliveryResult,
        onPlatformSendDispatch,
      }),
    ).rejects.toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY",
      message: "IRC connection closed before send",
      deliveryResult: { messageIds: ["irc-msg-1"], visibleReplySent: true },
    });

    expect(client.sendPrivmsg).toHaveBeenCalledOnce();
    expect(onPlatformSendDispatch).toHaveBeenCalledOnce();
    expect(onDeliveryResult).toHaveBeenCalledOnce();
    expect(client.quit).toHaveBeenCalledOnce();
  });

  it.each(["send", "report", "activity", "partial-send"] as const)(
    "retains accepted receipts when a later %s fails",
    async (phase) => {
      const client = createClient();
      const cause = new Error("send interrupted");
      const failure =
        phase === "partial-send"
          ? createChannelPartialDeliveryError(cause, {
              messageIds: ["nested-id"],
              visibleReplySent: true,
            })
          : cause;
      if (phase === "send" || phase === "partial-send") {
        client.sendPrivmsg.mockResolvedValueOnce(undefined).mockRejectedValueOnce(failure);
      }
      if (phase === "activity") {
        hoisted.record.mockImplementationOnce(() => {
          throw cause;
        });
      }
      const onDeliveryResult =
        phase === "report"
          ? () => {
              throw cause;
            }
          : undefined;

      await expect(
        sendIrcMessages(
          "#room",
          "first second",
          { cfg: providedCfg },
          () => [{ text: "first" }, { text: "second" }],
          onDeliveryResult,
        ),
      ).rejects.toMatchObject({
        code: "CHANNEL_PARTIAL_DELIVERY",
        cause: failure,
        deliveryResult: {
          messageIds: phase === "partial-send" ? ["irc-msg-1", "nested-id"] : ["irc-msg-1"],
          visibleReplySent: true,
          receipt: {
            platformMessageIds:
              phase === "partial-send" ? ["irc-msg-1", "nested-id"] : ["irc-msg-1"],
          },
        },
      });
    },
  );

  it("preserves the original failure when no message was sent", async () => {
    const client = createClient();
    const failure = new Error("first send refused");
    client.sendPrivmsg.mockRejectedValueOnce(failure);
    await expect(sendMessageIrc("#room", "hello", { cfg: providedCfg })).rejects.toBe(failure);
  });

  it("declares message adapter durable text, media, and reply with receipt proofs", async () => {
    const client = createClient();

    const proofResults = await verifyChannelMessageAdapterCapabilityProofs({
      adapterName: "irc",
      adapter: ircMessageAdapter,
      proofs: {
        text: async () => {
          const result = await ircMessageAdapter.send?.text?.({
            cfg: providedCfg,
            to: "#room",
            text: "hello",
          });
          expect(result?.receipt.platformMessageIds).toEqual(["irc-msg-1"]);
          expect(result?.target).toEqual({ kind: "conversation", id: "#room" });
          expect(client.join).toHaveBeenCalledWith("#room");
          expect(client.sendPrivmsg).toHaveBeenCalledWith("#room", "hello", undefined);
        },
        media: async () => {
          const result = await ircMessageAdapter.send?.media?.({
            cfg: providedCfg,
            to: "#room",
            text: "image",
            mediaUrl: "https://example.com/image.png",
          });
          expect(result?.receipt.platformMessageIds).toEqual(["irc-msg-1"]);
          expect(client.join).toHaveBeenCalledWith("#room");
          expect(client.sendPrivmsg).toHaveBeenCalledWith(
            "#room",
            "image\n\nAttachment: https://example.com/image.png",
            undefined,
          );
        },
        replyTo: async () => {
          const result = await ircMessageAdapter.send?.text?.({
            cfg: providedCfg,
            to: "#room",
            text: "threaded",
            replyToId: "parent-1",
          });
          expect(result?.receipt.replyToId).toBe("parent-1");
          expect(client.join).toHaveBeenCalledWith("#room");
          expect(client.sendPrivmsg).toHaveBeenCalledWith("#room", "threaded", "parent-1");
        },
      },
    });

    expect(proofResults.find((result) => result.capability === "text")?.status).toBe("verified");
    expect(proofResults.find((result) => result.capability === "media")?.status).toBe("verified");
    expect(proofResults.find((result) => result.capability === "replyTo")?.status).toBe("verified");
  });
});
