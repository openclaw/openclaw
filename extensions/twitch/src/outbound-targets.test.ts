import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getOrCreateClientManager, removeClientManager } from "./client-manager-registry.js";
import { twitchMessageAdapter, twitchOutbound } from "./outbound.js";
import { twitchPlugin } from "./plugin.js";
import { BASE_TWITCH_TEST_ACCOUNT, makeTwitchTestConfig } from "./test-fixtures.js";

const account = { ...BASE_TWITCH_TEST_ACCOUNT, accessToken: "oauth:synthetic-rh126" };
const cfg = makeTwitchTestConfig(account);
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const params = { cfg, accountId: "default", text: "**Hello** Twitch!" };

// Keep real account resolution, outbound adapters, registry lookup, Markdown
// conversion, and receipts. Only the manager's external delivery is controlled.
function installTransport() {
  const manager = getOrCreateClientManager("default", logger);
  return vi.spyOn(manager, "sendMessage").mockResolvedValue({
    ok: true,
    messageId: "rh126-message",
  });
}

describe("Twitch target normalization at outbound delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await removeClientManager("default");
    vi.restoreAllMocks();
  });

  it.each([
    "TestChannel",
    "#TestChannel",
    "twitch:TestChannel",
    "twitch:channel:TestChannel",
    "twitch-chat:channel:TestChannel",
    "CHANNEL:#TestChannel",
    "group:TestChannel",
    "conversation:TestChannel",
    "room:TestChannel",
    "  TwItCh-ChAt:ChAnNeL: #TestChannel  ",
  ])("routes, authorizes, and sends %s as the same bare channel", async (to) => {
    const transport = installTransport();
    const result = await twitchOutbound.sendText!({ ...params, to });
    expect(transport).toHaveBeenCalledExactlyOnceWith(
      account,
      "testchannel",
      "Hello Twitch!",
      cfg,
      "default",
    );
    expect(result.messageId).toBe("rh126-message");
    expect(result.receipt?.parts).toMatchObject([
      { kind: "text", raw: { conversationId: "testchannel" } },
    ]);
    expect(twitchPlugin.messaging?.normalizeTarget?.(to)).toBe("testchannel");
    expect(twitchPlugin.messaging?.inferTargetChatType?.({ to })).toBe("group");
    const route = await twitchPlugin.messaging?.resolveOutboundSessionRoute?.({
      cfg,
      agentId: "ops",
      accountId: "default",
      target: to,
    });
    expect(route).toMatchObject({
      sessionKey: "agent:ops:twitch:group:testchannel",
      peer: { kind: "group", id: "testchannel" },
      to: "testchannel",
    });
    for (const mode of ["implicit", "heartbeat"] as const) {
      // Exercise both target-side and allowlist-side normalization, with a
      // nonempty mismatch control so dropping restrictions cannot pass.
      for (const [target, allowed] of [
        [to, "testchannel"],
        ["testchannel", to],
      ] as const) {
        expect(twitchOutbound.resolveTarget!({ to: target, mode, allowFrom: [allowed] })).toEqual({
          ok: true,
          to: "testchannel",
        });
      }
      expect(twitchOutbound.resolveTarget!({ to, mode, allowFrom: ["other"] }).ok).toBe(false);
    }
  });

  it.each(["implicit", "heartbeat"] as const)(
    "preserves restrictive and empty allowlist behavior for %s targets",
    (mode) => {
      for (const entry of ["user:alice", "dm:alice", "twitch:channel:#", "twitch-chat:"]) {
        expect(twitchOutbound.resolveTarget!({ to: "other", mode, allowFrom: [entry] }).ok).toBe(
          false,
        );
      }
      for (const allowFrom of [[], [""], ["   "], ["#"], ["*"]]) {
        expect(twitchOutbound.resolveTarget!({ to: "other", mode, allowFrom })).toEqual({
          ok: true,
          to: "other",
        });
      }
    },
  );

  it.each([
    "user:alice",
    "dm:alice",
    "twitch:user:alice",
    "twitch:dm:alice",
    "twitch-chat:user:alice",
    " TwItCh-ChAt:DM:alice ",
  ])("rejects %s before any transport or default-channel fallback", async (to) => {
    const transport = installTransport();
    await expect(twitchOutbound.sendText!({ ...params, to })).rejects.toThrow(
      "Delivering to Twitch requires target <channel-name>",
    );
    await expect(
      twitchMessageAdapter.send!.media!({
        ...params,
        to,
        mediaUrl: "https://example.invalid/image.png",
      }),
    ).rejects.toThrow("Delivering to Twitch requires target <channel-name>");
    expect(twitchPlugin.messaging?.normalizeTarget?.(to)).toBe("");
    expect(
      await twitchPlugin.messaging?.resolveOutboundSessionRoute?.({
        cfg,
        agentId: "ops",
        target: to,
      }),
    ).toBeNull();
    expect(twitchOutbound.resolveTarget!({ to, allowFrom: ["*"], mode: "implicit" }).ok).toBe(
      false,
    );
    expect(transport).not.toHaveBeenCalled();
  });

  it.each(["", "   ", "#", "twitch:channel:#"])(
    "keeps configured-channel fallback for empty channel target %j",
    async (to) => {
      const transport = installTransport();
      await twitchOutbound.sendText!({ ...params, to });
      expect(transport).toHaveBeenCalledExactlyOnceWith(
        account,
        "testchannel",
        "Hello Twitch!",
        cfg,
        "default",
      );
    },
  );

  it("normalizes media through the canonical message adapter", async () => {
    const transport = installTransport();
    const result = await twitchMessageAdapter.send!.media!({
      ...params,
      to: "twitch-chat:channel:#TestChannel",
      mediaUrl: "https://example.invalid/image.png",
    });
    expect(transport).toHaveBeenCalledExactlyOnceWith(
      account,
      "testchannel",
      "Hello Twitch! https://example.invalid/image.png",
      cfg,
      "default",
    );
    expect(result.receipt?.primaryPlatformMessageId).toBe("rh126-message");
  });
});
