import { createChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { verifyChannelMessageAdapterCapabilityProofs } from "openclaw/plugin-sdk/channel-outbound";
import { PAIRING_APPROVED_MESSAGE } from "openclaw/plugin-sdk/channel-status";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { afterAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { IrcClient } from "./client.js";
import * as ircRuntime from "./runtime.js";
import type { CoreConfig } from "./types.js";

const mocks = vi.hoisted(() => ({
  currentConfig: vi.fn(() => ({})),
  record: vi.fn(),
  connectIrcClient: vi.fn(),
  buildIrcConnectOptions: vi.fn(),
}));
// mock-isolation: outbound tests use an owned transport instead of connecting to IRC.
vi.mock("./client.js", () => ({ connectIrcClient: mocks.connectIrcClient }));
// mock-isolation: transport option construction is fixed for the owned client fixture.
vi.mock("./connect-options.js", () => ({ buildIrcConnectOptions: mocks.buildIrcConnectOptions }));
vi.mock("node:crypto", async (original) => ({
  ...(await original<typeof import("node:crypto")>()),
  randomUUID: () => "irc-msg-1",
}));

import { ircPlugin } from "./channel.js";
import { ircOutboundBaseAdapter } from "./outbound-base.js";
import { probeIrc } from "./probe.js";
import { sendIrcMessages, sendMessageIrc } from "./send.js";

const adapter = ircPlugin.message!;
const formatted = ircPlugin.outbound!.sendFormattedText!;
const address = { host: "irc.example.com", nick: "openclaw", port: 6697, tls: true };
const cfg: CoreConfig = { channels: { irc: address } };
const context = { cfg, to: "#room", text: "hello" };
const longText = Array.from({ length: 80 }, (_, index) => `word-${index}`).join(" ");
const id = "irc-msg-1";

afterAll(() => {
  for (const path of ["./client.js", "./connect-options.js", "node:crypto"]) {
    vi.doUnmock(path);
  }
  vi.resetModules();
});

it("exposes outbound chunking without initializing the IRC runtime", () => {
  expect(ircOutboundBaseAdapter.chunker("alpha beta", 5)).toEqual(["alpha", "beta"]);
  expect(ircOutboundBaseAdapter).toMatchObject({
    deliveryMode: "direct",
    chunkerMode: "markdown",
    textChunkLimit: 350,
  });
  expect(formatted).toBeTypeOf("function");
});

describe("IRC outbound and probing", () => {
  let client: ReturnType<typeof createClient>;
  function createClient() {
    const result = {
      nick: "openclaw",
      isReady: vi.fn(() => true),
      join: vi.fn(),
      sendPrivmsg: vi.fn(),
      quit: vi.fn(),
      close: vi.fn(),
    } satisfies IrcClient;
    mocks.connectIrcClient.mockResolvedValue(result);
    return result;
  }
  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      mock.mockReset();
    }
    mocks.buildIrcConnectOptions.mockReturnValue({});
    client = createClient();
    ircRuntime.setIrcRuntime(
      createPluginRuntimeMock({
        config: { current: mocks.currentConfig },
        channel: { activity: { record: mocks.record } },
      }),
    );
  });
  const send = (options: Partial<Parameters<typeof sendMessageIrc>[2]> = {}, text = "hello") =>
    sendMessageIrc("#room", text, { cfg, ...options });
  function unsent() {
    expect(client.sendPrivmsg).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  }
  it("uses explicit named-account cfg and records a durable receipt", async () => {
    const namedCfg: CoreConfig = {
      channels: {
        irc: {
          ...address,
          accounts: { work: { host: address.host, nick: "workbot" } },
        },
      },
    };
    const result = await send({ cfg: namedCfg, accountId: "work" });
    expect(mocks.currentConfig).not.toHaveBeenCalled();
    expect(client.sendPrivmsg).toHaveBeenCalledWith("#room", "hello", undefined);
    expect(mocks.record).toHaveBeenCalledWith({
      channel: "irc",
      accountId: "work",
      direction: "outbound",
    });
    expect(result).toMatchObject({ target: "#room", messageId: id });
    expect(result.receipt.sentAt).toBeTypeOf("number");
    expect(result.receipt.sentAt).toBeGreaterThan(0);
    const raw = { channel: "irc", conversationId: "#room", messageId: id };
    expect({ ...result.receipt, sentAt: 123 }).toEqual({
      primaryPlatformMessageId: id,
      platformMessageIds: [id],
      sentAt: 123,
      parts: [{ platformMessageId: id, kind: "text", index: 0, raw }],
      sourceResults: [{ channel: "irc", messageId: id }],
      raw: [raw],
    });
  });

  it("fails hard when cfg is omitted", async () => {
    await expect(sendMessageIrc("#ops", "ping", {} as never)).rejects.toThrow(
      "IRC send requires a resolved runtime config",
    );
    expect(mocks.currentConfig).not.toHaveBeenCalled();
    unsent();
  });

  it("sends without optional runtime activity recording", async () => {
    const runtime = vi.spyOn(ircRuntime, "getOptionalIrcRuntime").mockReturnValueOnce(null);
    onTestFinished(() => runtime.mockRestore());
    expect(await send()).toMatchObject({ target: "#room", messageId: id });
    expect(mocks.currentConfig).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
    expect(client.sendPrivmsg).toHaveBeenCalledWith("#room", "hello", undefined);
  });

  it("rejects stripped-empty replies before adding reply metadata", async () => {
    await expect(send({ replyTo: "irc-parent-1" }, "#")).rejects.toThrow(
      "Message must be non-empty for IRC sends",
    );
    unsent();
  });

  it("uses one transient connection for a chunked outbound message", async () => {
    const onDeliveryResult = vi.fn(),
      onPlatformSendDispatch = vi.fn();
    const chunks = ircOutboundBaseAdapter.chunker(longText, 350);
    const results = await formatted({
      ...context,
      text: longText,
      replyToId: "parent-1",
      replyToIdSource: "explicit",
      replyToMode: "all",
      onDeliveryResult,
      onPlatformSendDispatch,
    });
    expect(mocks.connectIrcClient).toHaveBeenCalledOnce();
    expect(client.join).toHaveBeenCalledOnce();
    expect(client.sendPrivmsg.mock.calls).toEqual(
      chunks.map((chunk) => ["#room", chunk, "parent-1"]),
    );
    expect(client.quit).toHaveBeenCalledOnce();
    for (const callback of [onPlatformSendDispatch, onDeliveryResult]) {
      expect(callback).toHaveBeenCalledTimes(chunks.length);
    }
    expect(results).toHaveLength(chunks.length);
  });

  it.each(
    [
      { kind: "formatted", sendMessage: formatted },
      { kind: "text", sendMessage: adapter.send!.text! },
      { kind: "media", sendMessage: adapter.send!.media! },
    ].flatMap(({ kind, sendMessage }) =>
      ["connect", "dispatch"].map((phase) => ({ kind, sendMessage, phase })),
    ),
  )("cancels $kind sends during $phase", async ({ sendMessage, phase }) => {
    const connecting = Promise.withResolvers<IrcClient>();
    mocks.connectIrcClient.mockReturnValue(connecting.promise);
    mocks.buildIrcConnectOptions.mockImplementation((_account, overrides = {}) => overrides);
    const abort = new AbortController();
    const onPlatformSendDispatch = vi.fn(async () => {
      await Promise.resolve();
      abort.abort();
    });
    const pending = sendMessage({
      ...context,
      mediaUrl: "https://example.com/image.png",
      signal: abort.signal,
      abortSignal: abort.signal,
      onPlatformSendDispatch,
    });
    await vi.waitFor(() => expect(mocks.connectIrcClient).toHaveBeenCalledOnce());
    if (phase === "connect") {
      abort.abort();
    }
    connecting.resolve(client);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.buildIrcConnectOptions).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ abortSignal: abort.signal }),
    );
    for (const callback of [client.join, onPlatformSendDispatch]) {
      expect(callback).toHaveBeenCalledTimes(phase === "connect" ? 0 : 1);
    }
    expect(client.sendPrivmsg).not.toHaveBeenCalled();
    expect(client.quit).toHaveBeenCalledOnce();
  });

  it("stops before recording another chunk after the connection closes", async () => {
    const onDeliveryResult = vi.fn(() => {
      client.isReady.mockReturnValue(false);
    });
    const onPlatformSendDispatch = vi.fn();
    await expect(
      formatted({ ...context, text: longText, onDeliveryResult, onPlatformSendDispatch }),
    ).rejects.toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY",
      message: "IRC connection closed before send",
      deliveryResult: { messageIds: [id], visibleReplySent: true },
    });
    for (const callback of [
      client.sendPrivmsg,
      client.quit,
      onPlatformSendDispatch,
      onDeliveryResult,
    ]) {
      expect(callback).toHaveBeenCalledOnce();
    }
  });

  it.each(["send", "report", "activity", "partial-send"] as const)(
    "retains accepted receipts when a later %s fails",
    async (phase) => {
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
      const fail = () => {
        throw cause;
      };
      if (phase === "activity") {
        mocks.record.mockImplementationOnce(fail);
      }
      const messageIds = phase === "partial-send" ? [id, "nested-id"] : [id];
      await expect(
        sendIrcMessages(
          "#room",
          "first second",
          { cfg },
          () => [{ text: "first" }, { text: "second" }],
          phase === "report" ? fail : undefined,
        ),
      ).rejects.toMatchObject({
        code: "CHANNEL_PARTIAL_DELIVERY",
        cause: failure,
        deliveryResult: {
          messageIds,
          visibleReplySent: true,
          receipt: { platformMessageIds: messageIds },
        },
      });
    },
  );

  it("preserves the original failure when no message was sent", async () => {
    const failure = new Error("first send refused");
    client.sendPrivmsg.mockRejectedValueOnce(failure);
    await expect(send()).rejects.toBe(failure);
  });

  it("declares durable text, media, and reply with receipt proofs", async () => {
    const mediaUrl = "https://example.com/image.png";
    const proveSend = async (kind: "text" | "media", text: string, replyToId?: string) => {
      const params = { ...context, text, replyToId };
      const result =
        kind === "media"
          ? await adapter.send!.media!({ ...params, mediaUrl })
          : await adapter.send!.text!(params);
      expect(result?.receipt.platformMessageIds).toEqual([id]);
      expect(client.join).toHaveBeenCalledWith("#room");
      expect(client.sendPrivmsg).toHaveBeenCalledWith(
        "#room",
        kind === "media" ? `${text}\n\nAttachment: ${mediaUrl}` : text,
        replyToId,
      );
      return result;
    };
    const proofs = await verifyChannelMessageAdapterCapabilityProofs({
      adapterName: "irc",
      adapter,
      proofs: {
        text: async () => {
          expect((await proveSend("text", "hello"))?.target).toEqual({
            kind: "conversation",
            id: "#room",
          });
        },
        media: async () => {
          await proveSend("media", "image");
        },
        replyTo: async () => {
          expect((await proveSend("text", "threaded", "parent-1"))?.receipt.replyToId).toBe(
            "parent-1",
          );
        },
      },
    });
    for (const capability of ["text", "media", "replyTo"]) {
      expect(proofs.find((proof) => proof.capability === capability)?.status).toBe("verified");
    }
  });

  it("keeps siblings unchanged across named-account additions and edits", () => {
    const base = {
      ...address,
      nick: "default-bot",
      channels: ["#shared"],
      nickserv: { service: "NickServ", enabled: false },
      accounts: { alpha: { nick: "alpha-bot", channels: ["#alpha"] } },
    };
    const resolve = (config: CoreConfig) =>
      ["default", "alpha"].map((name) => ircPlugin.config.resolveAccount(config, name));
    const original = resolve({ channels: { irc: base } });
    for (const beta of [
      { nick: "beta-bot", channels: ["#beta"] },
      { nick: "beta-next", channels: ["#next"], nickserv: { enabled: true } },
    ]) {
      const next: CoreConfig = {
        channels: { irc: { ...base, accounts: { ...base.accounts, beta } } },
      };
      expect(resolve(next)).toEqual(original);
      expect(ircPlugin.config.resolveAccount(next, "beta").nick).toBe(beta.nick);
    }
    expect(ircPlugin.reload).toMatchObject({ accountScopedRestart: true });
  });

  it("distinguishes nicknames from channels", () => {
    expect(
      ["alice", "#operators"].map((to) => ircPlugin.messaging?.inferTargetChatType?.({ to })),
    ).toEqual(["direct", "group"]);
  });

  it.each(["beta", undefined] as const)(
    "sends pairing approval from account %s or the default",
    async (accountId) => {
      const { buildIrcConnectOptions } =
        await vi.importActual<typeof import("./connect-options.js")>("./connect-options.js");
      mocks.buildIrcConnectOptions.mockImplementation(buildIrcConnectOptions);
      const accounts = {
        alpha: { host: "irc.alpha.test", nick: "alpha-bot", password: "password-alpha" },
        beta: { host: "irc.beta.test", nick: "beta-bot", password: "password-beta" },
      };
      await ircPlugin.pairing!.notifyApproval!({
        cfg: { channels: { irc: { defaultAccount: "alpha", accounts } } },
        id: "paired-user",
        ...(accountId ? { accountId } : {}),
      });
      expect(mocks.connectIrcClient).toHaveBeenCalledOnce();
      expect(mocks.connectIrcClient.mock.calls[0]?.[0]).toMatchObject(
        accounts[accountId ?? "alpha"],
      );
      expect(client.sendPrivmsg).toHaveBeenCalledExactlyOnceWith(
        "paired-user",
        PAIRING_APPROVED_MESSAGE,
        undefined,
      );
    },
  );

  it("returns a configuration error for an incomplete probe account", async () => {
    const missing = { host: "", nick: "", port: 6667, tls: false };
    await expect(
      probeIrc({ channels: { irc: { accounts: { missing } } } }, { accountId: "missing" }),
    ).resolves.toEqual({ ok: false, ...missing, error: "missing host or nick" });
    expect(mocks.connectIrcClient).not.toHaveBeenCalled();
  });

  it("returns probe latency, forwards timeout and quits on success", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValueOnce(100).mockReturnValueOnce(145);
    onTestFinished(() => clock.mockRestore());
    await expect(probeIrc(cfg, { timeoutMs: 5000 })).resolves.toEqual({
      ok: true,
      ...address,
      latencyMs: 45,
    });
    expect(mocks.buildIrcConnectOptions).toHaveBeenCalledWith(expect.objectContaining(address), {
      connectTimeoutMs: 5000,
    });
    expect(client.quit).toHaveBeenCalledWith("probe");
  });

  it("formats non-Error probe failures", async () => {
    mocks.connectIrcClient.mockRejectedValue({ code: "ECONNREFUSED" });
    await expect(probeIrc(cfg)).resolves.toEqual({
      ok: false,
      ...address,
      error: JSON.stringify({ code: "ECONNREFUSED" }),
    });
  });
});
