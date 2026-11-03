import { sendDurableMessageBatch } from "openclaw/plugin-sdk/channel-outbound";
import {
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { describe, expect, it } from "vitest";
import { telegramPlugin } from "./channel.js";
import { resetTelegramClientOptionsCacheForTests } from "./send.js";
import { useTelegramHttpFixture } from "./send.telegram-http.test-support.js";

const fireEffect = "5104841245755180586";
const presentation = { blocks: [{ type: "text" as const, text: "Shipped" }] };

describe("Telegram message effects over HTTP", () => {
  const fixture = useTelegramHttpFixture();

  it.each([
    {
      route: "private text",
      to: "123",
      params: { message: "Shipped", effectId: fireEffect },
      expected: [["sendMessage", fireEffect]],
    },
    {
      route: "private media with a follow-up",
      to: "123",
      media: true,
      params: { message: "A".repeat(1100), effect: fireEffect },
      expected: [
        ["sendPhoto", fireEffect],
        ["sendMessage", undefined],
      ],
    },
    {
      route: "private rich plain fallback",
      to: "123",
      rich: true,
      rejection: "Bad Request: RICH_MESSAGE_URL_INVALID",
      params: { message: "**Shipped** https://example.com", effectId: fireEffect },
      expected: [
        ["sendRichMessage", fireEffect],
        ["sendMessage", fireEffect],
      ],
    },
    {
      route: "private prepared presentation",
      to: "123",
      prepared: true,
      params: { presentation, effectId: fireEffect },
      expected: [["sendMessage", fireEffect]],
    },
    {
      route: "group text",
      to: "-1001",
      params: { message: "Shipped", effectId: fireEffect },
      expected: [["sendMessage", undefined]],
    },
  ] as const)(
    "applies an explicit effect once in private chats only ($route)",
    async ({ to, params, expected, ...testCase }) => {
      await withOpenClawTestState({ prefix: "telegram-message-effect-" }, async () => {
        resetTelegramClientOptionsCacheForTests();
        setActivePluginRegistry(
          createTestRegistry([{ pluginId: "telegram", source: "test", plugin: telegramPlugin }]),
        );
        const cfg = {
          channels: {
            telegram: {
              ...fixture.cfg.channels.telegram,
              botToken: `123456:message-effect-${to}`,
              ...("rich" in testCase ? { richMessages: true } : {}),
            },
          },
        };
        if ("rejection" in testCase) {
          fixture.rejections.push(testCase.rejection);
        }
        const sendParams = {
          ...params,
          ...("media" in testCase ? { media: fixture.photoPath } : {}),
        };
        try {
          if ("prepared" in testCase) {
            const payload = await telegramPlugin.actions!.prepareSendPayload!({
              ctx: { channel: "telegram", action: "send", cfg, params: sendParams },
              to,
              payload: { presentation },
            });
            await expect(
              sendDurableMessageBatch({
                cfg,
                channel: "telegram",
                to,
                payloads: [payload!],
                skipQueue: true,
              }),
            ).resolves.toMatchObject({ status: "sent" });
          } else {
            await expect(
              telegramPlugin.actions!.handleAction!({
                channel: "telegram",
                action: "send",
                cfg,
                skipQueue: true,
                mediaLocalRoots: [fixture.mediaDir],
                params: { to, ...sendParams },
              }),
            ).resolves.toMatchObject({ details: { ok: true } });
          }
          expect(
            fixture.requests.map(({ method, fields }) => [method, fields.message_effect_id]),
          ).toEqual(expected);
        } finally {
          resetPluginRuntimeStateForTest();
        }
      });
    },
  );
});
