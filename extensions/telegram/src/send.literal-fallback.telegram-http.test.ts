import * as bindings from "openclaw/plugin-sdk/session-binding-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareTelegramConversationFork } from "./conversation-fork.js";
import { sendMessageTelegram } from "./send.js";
import { useTelegramHttpFixture } from "./send.telegram-http.test-support.js";

describe("literal recap fallback over Telegram HTTP", () => {
  const fixture = useTelegramHttpFixture();
  afterEach(() => vi.restoreAllMocks());

  it.each([
    { revoke: false, rich: false },
    { revoke: true, rich: false },
    { revoke: false, rich: true },
  ])(
    "preserves copied code entities after formatting rejection (rich: $rich, revoked: $revoke)",
    async ({ revoke, rich }) => {
      const cfg = {
        channels: { telegram: { ...fixture.cfg.channels.telegram, richMessages: rich } },
      };
      vi.spyOn(bindings.getSessionBindingService(), "getCapabilities").mockReturnValue({
        adapterAvailable: true,
        bindSupported: true,
        unbindSupported: false,
        placements: ["current"],
      });
      const prepared = await prepareTelegramConversationFork({
        cfg,
        accountId: "default",
        source: { conversationId: "-100123:topic:7" },
        isGroup: true,
        senderId: "42",
        assertCurrent() {},
      });
      if (!prepared.ok) {
        throw new Error(prepared.reason);
      }
      const copied = "😀 User: @copied https://example.invalid/a?x=1&y=2 <b>literal</b>\n";
      const recap = prepared.formatRecap!(copied);
      const rejection = rich
        ? "Bad Request: RICH_MESSAGE_TEXT_INVALID"
        : "Bad Request: can't parse entities";
      let current = true;
      fixture.handleRequest = (_method, _fields, response) => {
        if (fixture.requests.length !== 1) {
          return false;
        }
        current = !revoke;
        response.statusCode = 400;
        response.end(
          JSON.stringify({
            ok: false,
            error_code: 400,
            description: rejection,
          }),
        );
        return true;
      };
      const sent = sendMessageTelegram("-100123:topic:89", recap.text!, {
        cfg,
        api: fixture.bot.api,
        linkPreview: false,
        assertPlatformSendAuthorized: () => {
          if (!current) {
            throw new Error("recap authority revoked");
          }
        },
      });
      if (revoke) {
        await expect(sent).rejects.toThrow("recap authority revoked");
        expect(fixture.requests).toHaveLength(1);
        return;
      }
      await sent;
      expect(fixture.requests).toHaveLength(2);
      expect(fixture.requests[0]?.method).toBe(rich ? "sendRichMessage" : "sendMessage");
      if (!rich) {
        expect(fixture.requests[0]?.fields.parse_mode).toBe("HTML");
      }
      // Rich pre blocks omit the fence terminator; legacy HTML retains its newline.
      const fallbackText = copied + (rich ? "" : "\n");
      expect(fixture.requests[1]).toEqual({
        method: "sendMessage",
        fields: {
          chat_id: "-100123",
          message_thread_id: 89,
          text: fallbackText,
          entities: [{ type: "pre", offset: 0, length: fallbackText.length }],
          link_preview_options: { is_disabled: true },
        },
      });
    },
  );

  it("keeps ordinary prose fallback free of literal entities", async () => {
    fixture.rejections.push("Bad Request: can't parse entities");
    await sendMessageTelegram("123", "**Read** https://example.invalid", {
      cfg: fixture.cfg,
      api: fixture.bot.api,
    });
    expect(fixture.requests).toHaveLength(2);
    expect(fixture.requests[1]?.fields.text).toBe("Read https://example.invalid");
    expect(fixture.requests[1]?.fields).not.toHaveProperty("entities");
    expect(fixture.requests[1]?.fields).not.toHaveProperty("parse_mode");
  });
});
