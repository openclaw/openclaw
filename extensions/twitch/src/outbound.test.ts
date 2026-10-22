import {
  createMessageReceiptFromOutboundResults,
  type MessageReceipt,
} from "openclaw/plugin-sdk/channel-outbound";
import { describe, expect, it, vi } from "vitest";
import { resolveTwitchAccountContext } from "./config.js";
import { twitchMessageAdapter, twitchOutbound } from "./outbound.js";
import { sendMessageTwitchInternal } from "./send.js";
import {
  BASE_TWITCH_TEST_ACCOUNT,
  installTwitchTestHooks,
  makeTwitchTestConfig,
} from "./test-fixtures.js";

vi.mock("./config.js", () => ({
  DEFAULT_ACCOUNT_ID: "default",
  resolveTwitchAccountContext: vi.fn(),
}));

// mock-isolation: Observe outbound payloads and receipts without a live Twitch transport.
vi.mock("./send.js", () => ({ sendMessageTwitchInternal: vi.fn() }));

describe("outbound", () => {
  const mockAccount = {
    ...BASE_TWITCH_TEST_ACCOUNT,
    accessToken: "oauth:test123",
  };

  const mockConfig = makeTwitchTestConfig(mockAccount);
  const sendParams = { cfg: mockConfig, to: "#testchannel", text: "Hello!", accountId: "default" };
  const internalParams = {
    channel: "testchannel",
    cfg: mockConfig,
    account: mockAccount,
    accountId: "default",
    clientManager: undefined,
  };
  const receipt: MessageReceipt = {
    primaryPlatformMessageId: "twitch-msg-123",
    platformMessageIds: ["twitch-msg-123"],
    parts: [{ platformMessageId: "twitch-msg-123", kind: "text", index: 0 }],
    sentAt: 1700000000000,
  };
  installTwitchTestHooks();

  function prepareSend() {
    setupAccountContext();
    vi.mocked(sendMessageTwitchInternal).mockResolvedValue({
      messageId: "twitch-msg-123",
      receipt,
    });
  }

  function setupAccountContext(params?: {
    account?: typeof mockAccount | null;
    configured?: boolean;
  }) {
    const account = params?.account === undefined ? mockAccount : params.account;
    vi.mocked(resolveTwitchAccountContext).mockImplementation((_cfg, accountId) => ({
      accountId: accountId?.trim() || "default",
      account,
      tokenResolution: { token: account?.accessToken ?? "" },
      configured: account ? (params?.configured ?? true) : false,
      availableAccountIds: ["default"],
    }));
  }

  it.each(["sendText", "sendMedia"] as const)("%s should handle abort signal", async (method) => {
    const abortController = new AbortController();
    abortController.abort();
    const params = {
      ...sendParams,
      mediaUrl: "https://example.com/image.png",
      signal: abortController.signal,
    };
    await expect(twitchOutbound[method]!(params)).rejects.toThrow("Outbound delivery aborted");
    expect(resolveTwitchAccountContext).not.toHaveBeenCalled();
  });

  it("preserves declared text and media receipts through both outbound interfaces", async () => {
    prepareSend();
    const capabilities = { text: true, media: true, messageSendingHooks: true };
    expect(twitchOutbound.deliveryCapabilities?.durableFinal).toEqual(capabilities);
    expect(twitchMessageAdapter.durableFinal?.capabilities).toEqual(capabilities);
    vi.spyOn(Date, "now").mockReturnValue(1700000000123);
    for (const send of [
      { text: twitchOutbound.sendText!, media: twitchOutbound.sendMedia! },
      { text: twitchMessageAdapter.send!.text!, media: twitchMessageAdapter.send!.media! },
    ]) {
      vi.mocked(sendMessageTwitchInternal).mockClear();
      const textResult = await send.text({ ...sendParams, text: "Hello Twitch!" });
      const mediaResult = await send.media({
        ...sendParams,
        text: "image",
        mediaUrl: "https://example.com/image.png",
      });
      expect(vi.mocked(sendMessageTwitchInternal).mock.calls).toEqual([
        [{ ...internalParams, text: "Hello Twitch!" }],
        [{ ...internalParams, text: "image https://example.com/image.png" }],
      ]);
      for (const result of [textResult, mediaResult]) {
        expect(result.receipt).toBe(receipt);
        expect(result).toMatchObject({ messageId: "twitch-msg-123", timestamp: 1700000000123 });
      }
    }
  });

  describe("resolveTarget", () => {
    it.each([
      ["allowlisted", "#allowed", "implicit", ["#allowed", "#other"], "allowed"],
      ["empty allowlist", "#anychannel", "heartbeat", [], "anychannel"],
      ["wildcard", "#mychannel", "implicit", ["*", "#specific"], "mychannel"],
    ] as const)("accepts %s target", (_name, to, mode, allowFrom, expected) => {
      expect(twitchOutbound.resolveTarget!({ to, mode, allowFrom: [...allowFrom] })).toEqual({
        ok: true,
        to: expected,
      });
    });
    it.each(["#notallowed", undefined])("rejects unavailable implicit target %s", (to) => {
      expect(
        twitchOutbound.resolveTarget!({
          to,
          mode: "implicit",
          allowFrom: ["#primary", "#secondary"],
        }),
      ).toEqual({
        ok: false,
        error: expect.objectContaining({ message: expect.stringContaining("Twitch") }),
      });
    });
  });

  describe("sendText", () => {
    it("preserves intentional no-send through outbound", async () => {
      setupAccountContext();
      vi.mocked(sendMessageTwitchInternal).mockResolvedValue({
        outcome: "not_sent",
        messageId: "",
        receipt: createMessageReceiptFromOutboundResults({ results: [] }),
      });
      const result = await twitchOutbound.sendText!({ ...sendParams, text: "---" });
      expect(result).toMatchObject({
        outcome: "not_sent",
        receipt: { platformMessageIds: [], parts: [] },
      });
      expect(result.messageId ?? "").toBe("");
    });

    it.each([
      [
        "missing account",
        { account: null },
        { accountId: "nonexistent" },
        "Twitch account not found: nonexistent",
      ],
      [
        "missing channel",
        { account: { ...mockAccount, channel: "" } },
        { to: "" },
        "No channel specified",
      ],
      [
        "unconfigured account",
        { configured: false },
        {},
        "Account default is not properly configured. Required: username, clientId, and accessToken (config or env for default account).",
      ],
    ] as const)("rejects %s before delivery", async (_name, context, overrides, error) => {
      setupAccountContext(context);
      await expect(twitchOutbound.sendText!({ ...sendParams, ...overrides })).rejects.toThrow(
        error,
      );
      expect(sendMessageTwitchInternal).not.toHaveBeenCalled();
    });
  });

  it("should send media URL only when no text", async () => {
    prepareSend();
    await twitchOutbound.sendMedia!({
      ...sendParams,
      text: "",
      mediaUrl: "https://example.com/image.png",
    });
    expect(sendMessageTwitchInternal).toHaveBeenCalledWith({
      ...internalParams,
      text: "https://example.com/image.png",
    });
  });
});
