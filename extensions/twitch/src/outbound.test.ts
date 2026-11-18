import { createMessageReceiptFromOutboundResults } from "openclaw/plugin-sdk/channel-outbound";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveTwitchAccountContext } from "./config.js";
import { twitchOutbound } from "./outbound.js";
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

const account = { ...BASE_TWITCH_TEST_ACCOUNT, accessToken: "oauth:test123" };
const cfg = makeTwitchTestConfig(account);
const params = { cfg, to: "#testchannel", text: "Hello!", accountId: "default" };
const image = "https://example.com/image.png";
const receipt = createMessageReceiptFromOutboundResults({
  results: [{ channel: "twitch", conversationId: "testchannel", messageId: "msg-123" }],
  kind: "text",
});

function prepare(overrides: { account?: typeof account | null; configured?: boolean } = {}) {
  vi.mocked(resolveTwitchAccountContext).mockImplementation((_cfg, accountId) => ({
    accountId: accountId?.trim() || "default",
    account,
    configured: true,
    availableAccountIds: ["default"],
    ...overrides,
  }));
  vi.mocked(sendMessageTwitchInternal).mockResolvedValue({ messageId: "msg-123", receipt });
}
installTwitchTestHooks();
beforeEach(() => prepare());

describe("outbound", () => {
  it.each(["sendText", "sendMedia"] as const)(
    "%s aborts before resolving the account",
    async (method) => {
      await expect(
        twitchOutbound[method]!({ ...params, mediaUrl: image, signal: AbortSignal.abort() }),
      ).rejects.toThrow("Outbound delivery aborted");
      expect(resolveTwitchAccountContext).not.toHaveBeenCalled();
    },
  );
  it.each([
    ["text", { ...params, text: "Hello Twitch!" }, "Hello Twitch!"],
    ["media", { ...params, text: "image", mediaUrl: image }, `image ${image}`],
    ["media", { ...params, text: "", mediaUrl: image }, image],
  ] as const)("preserves %s receipts and payloads", async (kind, input, text) => {
    vi.spyOn(Date, "now").mockReturnValue(1700000000123);
    expect(twitchOutbound.deliveryCapabilities?.durableFinal).toEqual({
      text: true,
      media: true,
      messageSendingHooks: true,
    });
    const send = { text: twitchOutbound.sendText!, media: twitchOutbound.sendMedia! };
    const result = await send[kind](input);
    expect(result.receipt).toBe(receipt);
    expect(result).toMatchObject({ messageId: "msg-123", timestamp: 1700000000123 });
    expect(sendMessageTwitchInternal).toHaveBeenLastCalledWith(expect.objectContaining({ text }));
  });
  it.each([
    ["#allowed", "implicit", ["#allowed", "#other"], "allowed"],
    ["#anychannel", "heartbeat", [], "anychannel"],
    ["#mychannel", "implicit", ["*", "#specific"], "mychannel"],
  ] as const)("allows restricted target %s", (to, mode, allowFrom, expected) => {
    expect(twitchOutbound.resolveTarget!({ to, mode, allowFrom: [...allowFrom] })).toEqual({
      ok: true,
      to: expected,
    });
  });
  it.each(["#notallowed", undefined])("rejects unavailable implicit target %s", (to) => {
    expect(
      twitchOutbound.resolveTarget!({ to, mode: "implicit", allowFrom: ["#primary"] }),
    ).toMatchObject({ ok: false, error: expect.any(Error) });
  });
  it.each([
    "TestChannel",
    "#TestChannel",
    "twitch:TestChannel",
    "twitch:channel:TestChannel",
    "twitch-chat:channel:TestChannel",
  ])("normalizes %s for resolution and delivery", async (to) => {
    expect(twitchOutbound.resolveTarget!({ to })).toEqual({ ok: true, to: "testchannel" });
    expect((await twitchOutbound.sendText!({ ...params, to })).messageId).toBe("msg-123");
    expect(sendMessageTwitchInternal).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "testchannel" }),
    );
  });
  it.each(["user:alice", "dm:alice", "twitch:user:alice", "twitch:dm:alice"])(
    "rejects direct target %s without account fallback",
    async (to) => {
      expect(twitchOutbound.resolveTarget!({ to })).toMatchObject({
        ok: false,
        error: expect.any(Error),
      });
      await expect(twitchOutbound.sendText!({ ...params, to })).rejects.toThrow(
        "Delivering to Twitch requires target <channel-name>",
      );
      expect(sendMessageTwitchInternal).not.toHaveBeenCalled();
    },
  );
  it("uses the account channel when the normalized target is empty", async () => {
    expect((await twitchOutbound.sendText!({ ...params, to: "#" })).messageId).toBe("msg-123");
    expect(sendMessageTwitchInternal).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "testchannel" }),
    );
  });
  it("preserves intentional no-send and its empty receipt", async () => {
    vi.mocked(sendMessageTwitchInternal).mockResolvedValue({
      outcome: "not_sent",
      messageId: "",
      receipt: createMessageReceiptFromOutboundResults({ results: [] }),
    });
    const result = await twitchOutbound.sendText!({ ...params, text: "---" });
    expect(result).toMatchObject({
      outcome: "not_sent",
      receipt: { platformMessageIds: [], parts: [] },
    });
    expect(result.messageId ?? "").toBe("");
  });
  it.each([
    [{ account: null }, { accountId: "nonexistent" }, "Twitch account not found: nonexistent"],
    [{ account: { ...account, channel: "" } }, { to: "" }, "No channel specified"],
    [
      { configured: false },
      {},
      "Account default is not properly configured. Required: username, clientId, and accessToken (config or env for default account).",
    ],
  ] as const)(
    "rejects invalid account context %j before delivery",
    async (context, overrides, error) => {
      prepare(context);
      await expect(twitchOutbound.sendText!({ ...params, ...overrides })).rejects.toThrow(error);
      expect(sendMessageTwitchInternal).not.toHaveBeenCalled();
    },
  );
});
