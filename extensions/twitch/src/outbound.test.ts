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

vi.mock("./send.js", () => ({ sendMessageTwitchInternal: vi.fn() }));

function expectTarget(
  params: Parameters<NonNullable<typeof twitchOutbound.resolveTarget>>[0],
  to: string,
) {
  expect(twitchOutbound.resolveTarget!(params)).toEqual({ ok: true, to });
}

function expectTargetError(
  params: Parameters<NonNullable<typeof twitchOutbound.resolveTarget>>[0],
) {
  const result = twitchOutbound.resolveTarget!(params);

  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("expected resolveTarget to fail");
  }
  expect(result.error.message).toContain("Twitch");
}

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
  installTwitchTestHooks();

  function setupAccountContext(params?: {
    account?: typeof mockAccount | null;
    configured?: boolean;
  }) {
    const account = params?.account === undefined ? mockAccount : params.account;
    vi.mocked(resolveTwitchAccountContext).mockImplementation((_cfg, accountId) => ({
      accountId: accountId?.trim() || "default",
      account,
      tokenResolution: { source: "config", token: account?.accessToken ?? "" },
      configured: account ? (params?.configured ?? true) : false,
      availableAccountIds: ["default"],
    }));
  }

  describe("abort handling", () => {
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
  });

  describe("metadata", () => {
    it("preserves declared text and media receipts through both outbound interfaces", async () => {
      setupAccountContext();
      const capabilities = { text: true, media: true, messageSendingHooks: true };
      expect(twitchOutbound.deliveryCapabilities?.durableFinal).toEqual(capabilities);
      expect(twitchMessageAdapter.durableFinal?.capabilities).toEqual(capabilities);
      const receipt: MessageReceipt = {
        primaryPlatformMessageId: "twitch-msg-123",
        platformMessageIds: ["twitch-msg-123"],
        parts: [{ platformMessageId: "twitch-msg-123", kind: "text", index: 0 }],
        sentAt: 1700000000000,
      };
      vi.spyOn(Date, "now").mockReturnValue(1700000000123);
      vi.mocked(sendMessageTwitchInternal).mockResolvedValue({
        messageId: "twitch-msg-123",
        receipt,
      });
      for (const send of [
        { text: twitchOutbound.sendText!, media: twitchOutbound.sendMedia! },
        { text: twitchMessageAdapter.send!.text!, media: twitchMessageAdapter.send!.media! },
      ]) {
        vi.mocked(sendMessageTwitchInternal).mockClear();
        const textResult = await send.text({
          ...sendParams,
          text: "Hello Twitch!",
        });
        expect(sendMessageTwitchInternal).toHaveBeenCalledOnce();
        expect(sendMessageTwitchInternal).toHaveBeenCalledWith({
          ...internalParams,
          text: "Hello Twitch!",
        });
        const mediaResult = await send.media({
          ...sendParams,
          text: "image",
          mediaUrl: "https://example.com/image.png",
        });
        expect(sendMessageTwitchInternal).toHaveBeenCalledTimes(2);
        expect(sendMessageTwitchInternal).toHaveBeenNthCalledWith(2, {
          ...internalParams,
          text: "image https://example.com/image.png",
        });
        for (const result of [textResult, mediaResult]) {
          expect(result.receipt).toBe(receipt);
          expect(result).toMatchObject({ messageId: "twitch-msg-123", timestamp: 1700000000123 });
        }
        expect(mediaResult.receipt?.parts.map((part) => part.kind)).toEqual(["text"]);
      }
    });
  });

  describe("resolveTarget", () => {
    it("should return target in implicit mode when in allowlist", () => {
      expectTarget(
        { to: "#allowed", mode: "implicit", allowFrom: ["#allowed", "#other"] },
        "allowed",
      );
    });

    it("should error when target not in allowlist (implicit mode)", () => {
      expectTargetError({
        to: "#notallowed",
        mode: "implicit",
        allowFrom: ["#primary", "#secondary"],
      });
    });

    it("should accept any target when allowlist is empty", () => {
      expectTarget({ to: "#anychannel", mode: "heartbeat", allowFrom: [] }, "anychannel");
    });

    it("should error when no target provided with allowlist", () => {
      expectTargetError({ to: undefined, mode: "implicit", allowFrom: ["#fallback", "#other"] });
    });

    it("should filter wildcard from allowlist when checking membership", () => {
      expectTarget(
        { to: "#mychannel", mode: "implicit", allowFrom: ["*", "#specific"] },
        "mychannel",
      );
    });
  });

  describe("sendText", () => {
    it.each([{ name: "outbound", send: twitchOutbound.sendText! }])(
      "preserves intentional no-send through $name",
      async ({ send }) => {
        setupAccountContext();
        vi.mocked(sendMessageTwitchInternal).mockResolvedValue({
          outcome: "not_sent",
          messageId: "",
          receipt: createMessageReceiptFromOutboundResults({ results: [] }),
        });

        const result = await send({
          ...sendParams,
          text: "---",
        });

        expect(result).toMatchObject({
          outcome: "not_sent",
          receipt: { platformMessageIds: [], parts: [] },
        });
        expect(result.messageId ?? "").toBe("");
      },
    );

    it("should throw when account not found", async () => {
      setupAccountContext({ account: null });

      await expect(
        twitchOutbound.sendText!({
          ...sendParams,
          accountId: "nonexistent",
        }),
      ).rejects.toThrow("Twitch account not found: nonexistent");
    });

    it("should throw when no channel specified", async () => {
      const accountWithoutChannel = { ...mockAccount, channel: undefined as unknown as string };
      setupAccountContext({ account: accountWithoutChannel });

      await expect(
        twitchOutbound.sendText!({
          ...sendParams,
          to: "",
        }),
      ).rejects.toThrow("No channel specified");
    });

    it("rejects an unconfigured account before attempting delivery", async () => {
      setupAccountContext({ configured: false });

      await expect(twitchOutbound.sendText!(sendParams)).rejects.toThrow(
        "Account default is not properly configured. Required: username, clientId, and accessToken (config or env for default account).",
      );
      expect(sendMessageTwitchInternal).not.toHaveBeenCalled();
    });
  });

  describe("sendMedia", () => {
    it("should send media URL only when no text", async () => {
      setupAccountContext();
      vi.mocked(sendMessageTwitchInternal).mockResolvedValue({
        messageId: "media-only-msg",
        receipt: createMessageReceiptFromOutboundResults({
          results: [
            { channel: "twitch", conversationId: "testchannel", messageId: "media-only-msg" },
          ],
          kind: "text",
        }),
      });

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
});
