// The registered Telegram send action turns the host action origin into agent-owned
// callback buttons on the wire; without an origin the buttons stay plugin-owned.
import path from "node:path";
import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { captureEnv } from "openclaw/plugin-sdk/test-env";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { telegramPlugin } from "./channel.js";
import {
  parseTelegramAgentChoiceCallbackData,
  parseTelegramOpaqueCallbackData,
} from "./native-command-callback-data.js";
import { setTelegramPluginStateRuntimeForTests } from "./runtime-state.test-support.js";
import {
  clearTelegramRuntimeForTest,
  resetTelegramMessageCacheForTest,
} from "./runtime.test-support.js";
import { resetTelegramClientOptionsCacheForTests } from "./send.js";
import { useTelegramHttpFixture } from "./send.telegram-http.test-support.js";

type InlineKeyboard = { inline_keyboard?: Array<Array<{ text?: string; callback_data?: string }>> };

describe("Telegram send action callback ownership", () => {
  const fixture = useTelegramHttpFixture();
  const { requests } = fixture;
  let state: OpenClawTestState;
  let env = captureEnv([]);
  let cfg: OpenClawConfig;

  beforeEach(async () => {
    env = captureEnv(["TELEGRAM_BOT_TOKEN"]);
    delete process.env.TELEGRAM_BOT_TOKEN;
    state = await createOpenClawTestState({
      layout: "state-only",
      prefix: "telegram-actions-callback-owner-",
    });
    cfg = {
      ...fixture.cfg,
      session: { store: path.join(state.stateDir, "{agentId}", "sessions.json") },
    };
    resetTelegramMessageCacheForTest();
    resetTelegramClientOptionsCacheForTests();
    setTelegramPluginStateRuntimeForTests();
    // The registered send action hands the payload to core durable delivery,
    // which resolves the Telegram outbound adapter from the active registry.
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "telegram", source: "test", plugin: telegramPlugin }]),
    );
  });
  afterEach(async () => {
    resetPluginRuntimeStateForTest();
    clearTelegramRuntimeForTest();
    resetTelegramMessageCacheForTest();
    env.restore();
    await state.cleanup();
  });

  const sendProofButton = (context: Partial<ChannelMessageActionContext>) =>
    telegramPlugin.actions!.handleAction!({
      channel: "telegram",
      action: "send",
      params: {
        to: "123",
        message: "Proof button",
        presentation: {
          blocks: [
            {
              type: "buttons",
              buttons: [{ label: "Pick", action: { type: "callback", value: "btntest_typed" } }],
            },
          ],
        },
      },
      cfg,
      conversationReadOrigin: "direct-operator",
      skipQueue: true,
      ...context,
    });

  const sentCallbackData = (result: unknown) => {
    expect(result).toMatchObject({ details: { ok: true } });
    const sent = requests.find((request) => request.method === "sendMessage");
    expect(sent).toBeDefined();
    const raw = sent!.fields.reply_markup;
    const markup = (typeof raw === "string" ? JSON.parse(raw) : raw) as InlineKeyboard;
    const button = markup.inline_keyboard?.[0]?.[0];
    expect(button?.text).toBe("Pick");
    return String(button?.callback_data);
  };

  it("sends message-tool buttons as agent-owned callbacks the agent can receive", async () => {
    const result = await sendProofButton({ actionOrigin: "message-tool" });
    const callbackData = sentCallbackData(result);
    expect(callbackData.startsWith("tgac1:")).toBe(true);
    expect(parseTelegramAgentChoiceCallbackData(callbackData)).toBe("btntest_typed");
    expect(parseTelegramOpaqueCallbackData(callbackData)).toBeNull();
  });

  it("keeps buttons plugin-owned when no host action origin is present", async () => {
    const result = await sendProofButton({});
    const callbackData = sentCallbackData(result);
    expect(callbackData.startsWith("tgcb1:")).toBe(true);
    expect(parseTelegramOpaqueCallbackData(callbackData)).toBe("btntest_typed");
    expect(parseTelegramAgentChoiceCallbackData(callbackData)).toBeNull();
  });
});
