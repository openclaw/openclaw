import { beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { sendMessageTwitchInternal } from "./send.js";
import {
  BASE_TWITCH_TEST_ACCOUNT,
  installTwitchTestHooks,
  makeTwitchTestConfig,
} from "./test-fixtures.js";
import { TwitchClientManager } from "./twitch-client.js";

describe("sendMessageTwitchInternal", () => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const account = { ...BASE_TWITCH_TEST_ACCOUNT, accessToken: "test123" };
  const cfg = makeTwitchTestConfig(account);
  const clientManager = new TwitchClientManager(logger);
  let sendMessageSpy: MockInstance<TwitchClientManager["sendMessage"]>;
  const params = {
    channel: "testchannel",
    text: "Hello Twitch!",
    cfg,
    account,
    accountId: "default",
    clientManager,
  };
  installTwitchTestHooks();
  beforeEach(() => {
    sendMessageSpy = vi
      .spyOn(clientManager, "sendMessage")
      .mockResolvedValue({ ok: true, messageId: "twitch-msg-123" });
  });

  it("keeps empty Markdown unsent with a manager present", async () => {
    const result = await sendMessageTwitchInternal({
      ...params,
      text: "---",
    });

    expect(result).toMatchObject({ outcome: "not_sent", messageId: "" });
    expect(result.receipt.platformMessageIds).toStrictEqual([]);
    expect(result.receipt.parts).toStrictEqual([]);
    expect(sendMessageSpy).not.toHaveBeenCalled();
  });

  it("rejects a visible send when the caller has no manager", async () => {
    await expect(
      sendMessageTwitchInternal({ ...params, clientManager: undefined }),
    ).rejects.toThrow(
      "Client manager not found for account: default. Please start the Twitch gateway first.",
    );
  });

  it("uses the caller's prepared account when config no longer contains it", async () => {
    const result = await sendMessageTwitchInternal({ ...params, cfg: {}, text: "`---`" });

    expect(sendMessageSpy).toHaveBeenCalledExactlyOnceWith(
      account,
      "testchannel",
      "---",
      {},
      "default",
    );
    expect(result.messageId).toBe("twitch-msg-123");
    expect(result.receipt.primaryPlatformMessageId).toBe("twitch-msg-123");
    expect(result.receipt.parts).toMatchObject([
      { kind: "text", index: 0, raw: { conversationId: "testchannel" } },
    ]);
  });

  it("exposes the manager's formatted failure without a cause or another log", async () => {
    sendMessageSpy.mockResolvedValue({ ok: false, error: "Connection lost" });
    const failure = sendMessageTwitchInternal(params);

    await expect(failure).rejects.toThrow("Connection lost");
    await expect(failure).rejects.not.toHaveProperty("cause");
    expect(logger.error).not.toHaveBeenCalled();
  });
});
