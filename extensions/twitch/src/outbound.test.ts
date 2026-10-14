import {
  createMessageReceiptFromOutboundResults,
  type MessageReceipt,
} from "openclaw/plugin-sdk/channel-outbound";
import { describe, expect, it, vi } from "vitest";
import { resolveTwitchAccountContext } from "./config.js";
import { twitchMessageAdapter, twitchOutbound } from "./outbound.js";
import {
  BASE_TWITCH_TEST_ACCOUNT,
  installTwitchTestHooks,
  makeTwitchTestConfig,
} from "./test-fixtures.js";

// Mock dependencies
vi.mock("./config.js", () => ({
  DEFAULT_ACCOUNT_ID: "default",
  resolveTwitchAccountContext: vi.fn(),
}));

vi.mock("./send.js", () => ({
  sendMessageTwitchInternal: vi.fn(),
}));

function assertResolvedTarget(
  result: ReturnType<NonNullable<typeof twitchOutbound.resolveTarget>>,
): string {
  if (!result.ok) {
    throw result.error;
  }
  return result.to;
}

function expectTargetError(
  resolveTarget: NonNullable<typeof twitchOutbound.resolveTarget>,
  params: Parameters<NonNullable<typeof twitchOutbound.resolveTarget>>[0],
  expectedMessage: string,
) {
  const result = resolveTarget(params);

  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("expected resolveTarget to fail");
  }
  expect(result.error.message).toContain(expectedMessage);
}

function twitchTestReceipt(messageId: string) {
  return createMessageReceiptFromOutboundResults({
    results: [
      {
        channel: "twitch",
        conversationId: "testchannel",
        messageId,
      },
    ],
    kind: "text",
  });
}

describe("outbound", () => {
  const mockAccount = {
    ...BASE_TWITCH_TEST_ACCOUNT,
    accessToken: "oauth:test123",
  };
  const resolveTarget = twitchOutbound.resolveTarget!;

  const mockConfig = makeTwitchTestConfig(mockAccount);
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

  const abortedSendCases = [
    {
      name: "sendText",
      invoke: (signal: AbortSignal) =>
        twitchOutbound.sendText!({
          cfg: mockConfig,
          to: "#testchannel",
          text: "Hello!",
          accountId: "default",
          signal,
        } as Parameters<NonNullable<typeof twitchOutbound.sendText>>[0]),
    },
    {
      name: "sendMedia",
      invoke: (signal: AbortSignal) =>
        twitchOutbound.sendMedia!({
          cfg: mockConfig,
          to: "#testchannel",
          text: "Check this:",
          mediaUrl: "https://example.com/image.png",
          accountId: "default",
          signal,
        } as Parameters<NonNullable<typeof twitchOutbound.sendMedia>>[0]),
    },
  ];

  describe("abort handling", () => {
    it.each(abortedSendCases)("$name should handle abort signal", async ({ invoke }) => {
      const abortController = new AbortController();
      abortController.abort();

      await expect(invoke(abortController.signal)).rejects.toThrow("Outbound delivery aborted");
      expect(resolveTwitchAccountContext).not.toHaveBeenCalled();
    });
  });

  describe("metadata", () => {
    it("preserves declared text and media receipts through both outbound interfaces", async () => {
      const { sendMessageTwitchInternal } = await import("./send.js");

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
      const sendParams = {
        channel: "testchannel",
        cfg: mockConfig,
        account: mockAccount,
        accountId: "default",
        clientManager: undefined,
      };
      for (const send of [
        { text: twitchOutbound.sendText!, media: twitchOutbound.sendMedia! },
        { text: twitchMessageAdapter.send!.text!, media: twitchMessageAdapter.send!.media! },
      ]) {
        vi.mocked(sendMessageTwitchInternal).mockClear();
        const textResult = await send.text({
          cfg: mockConfig,
          to: "#testchannel",
          text: "Hello Twitch!",
          accountId: "default",
        });
        expect(sendMessageTwitchInternal).toHaveBeenCalledOnce();
        expect(sendMessageTwitchInternal).toHaveBeenCalledWith({
          ...sendParams,
          text: "Hello Twitch!",
        });
        const mediaResult = await send.media({
          cfg: mockConfig,
          to: "#testchannel",
          text: "image",
          mediaUrl: "https://example.com/image.png",
          accountId: "default",
        });
        expect(sendMessageTwitchInternal).toHaveBeenCalledTimes(2);
        expect(sendMessageTwitchInternal).toHaveBeenNthCalledWith(2, {
          ...sendParams,
          text: "image https://example.com/image.png",
        });
        for (const result of [textResult, mediaResult]) {
          expect(result.receipt).toBe(receipt);
          expect(result).toMatchObject({
            messageId: "twitch-msg-123",
            timestamp: 1700000000123,
          });
        }
        expect(mediaResult.receipt?.parts.map((part) => part.kind)).toEqual(["text"]);
      }
    });
  });

  describe("resolveTarget", () => {
    it("should return target in implicit mode when in allowlist", () => {
      const result = resolveTarget({
        to: "#allowed",
        mode: "implicit",
        allowFrom: ["#allowed", "#other"],
      });

      expect(result.ok).toBe(true);
      expect(assertResolvedTarget(result)).toBe("allowed");
    });

    it("should error when target not in allowlist (implicit mode)", () => {
      expectTargetError(
        resolveTarget,
        {
          to: "#notallowed",
          mode: "implicit",
          allowFrom: ["#primary", "#secondary"],
        },
        "Twitch",
      );
    });

    it("should accept any target when allowlist is empty", () => {
      const result = resolveTarget({
        to: "#anychannel",
        mode: "heartbeat",
        allowFrom: [],
      });

      expect(result.ok).toBe(true);
      expect(assertResolvedTarget(result)).toBe("anychannel");
    });

    it("should error when no target provided with allowlist", () => {
      expectTargetError(
        resolveTarget,
        {
          to: undefined,
          mode: "implicit",
          allowFrom: ["#fallback", "#other"],
        },
        "Twitch",
      );
    });

    it("should filter wildcard from allowlist when checking membership", () => {
      const result = resolveTarget({
        to: "#mychannel",
        mode: "implicit",
        allowFrom: ["*", "#specific"],
      });

      // With wildcard, any target is accepted
      expect(result.ok).toBe(true);
      expect(assertResolvedTarget(result)).toBe("mychannel");
    });
  });

  describe("sendText", () => {
    it.each([{ name: "outbound", send: twitchOutbound.sendText! }])(
      "preserves intentional no-send through $name",
      async ({ send }) => {
        const { sendMessageTwitchInternal } = await import("./send.js");
        setupAccountContext();
        vi.mocked(sendMessageTwitchInternal).mockResolvedValue({
          outcome: "not_sent",
          messageId: "",
          receipt: createMessageReceiptFromOutboundResults({ results: [] }),
        });

        const result = await send({
          cfg: mockConfig,
          to: "#testchannel",
          text: "---",
          accountId: "default",
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
          cfg: mockConfig,
          to: "#testchannel",
          text: "Hello!",
          accountId: "nonexistent",
        }),
      ).rejects.toThrow("Twitch account not found: nonexistent");
    });

    it("should throw when no channel specified", async () => {
      const accountWithoutChannel = { ...mockAccount, channel: undefined as unknown as string };
      setupAccountContext({ account: accountWithoutChannel });

      await expect(
        twitchOutbound.sendText!({
          cfg: mockConfig,
          to: "",
          text: "Hello!",
          accountId: "default",
        }),
      ).rejects.toThrow("No channel specified");
    });

    it("rejects an unconfigured account before attempting delivery", async () => {
      const { sendMessageTwitchInternal } = await import("./send.js");
      setupAccountContext({ configured: false });

      await expect(
        twitchOutbound.sendText!({
          cfg: mockConfig,
          to: "#testchannel",
          text: "Hello!",
          accountId: "default",
        }),
      ).rejects.toThrow(
        "Account default is not properly configured. Required: username, clientId, and accessToken (config or env for default account).",
      );
      expect(sendMessageTwitchInternal).not.toHaveBeenCalled();
    });
  });

  describe("sendMedia", () => {
    it("should send media URL only when no text", async () => {
      const { sendMessageTwitchInternal } = await import("./send.js");

      setupAccountContext();
      vi.mocked(sendMessageTwitchInternal).mockResolvedValue({
        messageId: "media-only-msg",
        receipt: twitchTestReceipt("media-only-msg"),
      });

      await twitchOutbound.sendMedia!({
        cfg: mockConfig,
        to: "#testchannel",
        text: "",
        mediaUrl: "https://example.com/image.png",
        accountId: "default",
      });

      expect(sendMessageTwitchInternal).toHaveBeenCalledWith({
        channel: "testchannel",
        text: "https://example.com/image.png",
        cfg: mockConfig,
        account: mockAccount,
        accountId: "default",
        clientManager: undefined,
      });
    });
  });
});
