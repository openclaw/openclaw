import type { BotCommand } from "grammy/types";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { registerPluginCommand } from "openclaw/plugin-sdk/plugin-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { expect, it, vi } from "vitest";
import {
  apiCalls,
  commandMessage,
  createBot,
  from,
  harness,
  publishTelegramTestConfig,
  settleMenuSyncs,
} from "./bot.create-telegram-bot.native-pipeline.test-support.js";
import { registerTelegramMiniAppCommand } from "./miniapp/command.js";
import { createTelegramMiniAppLaunchTickets } from "./miniapp/launch-ticket.js";
import { getTelegramRuntime } from "./runtime.js";

vi.mock("./miniapp/url.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./miniapp/url.js")>()),
  resolveTelegramMiniAppUrls: async () => ({
    pageUrl: "https://gateway.example/__openclaw_tg_miniapp/",
    controlUiUrl: "https://gateway.example",
    gatewayUrl: "wss://gateway.example",
  }),
}));

it("registers and dispatches session /dashboard separately from owner-only /controlui", async () => {
  const cfg: OpenClawConfig = {
    commands: { native: true, text: true },
    channels: {
      telegram: { dmPolicy: "open", allowFrom: ["*"], streaming: { mode: "off" } },
    },
  };
  const launchTickets = createTelegramMiniAppLaunchTickets();
  const runtime = getTelegramRuntime();
  registerTelegramMiniAppCommand(
    createTestPluginApi({
      config: cfg,
      runtime: { ...runtime, config: { ...runtime.config, current: () => cfg } },
      registerCommand: (command) => {
        expect(registerPluginCommand("telegram", command)).toEqual({ ok: true });
      },
    }),
    launchTickets,
  );

  const bot = await createBot(true, true, cfg);
  await settleMenuSyncs();
  const menu = apiCalls.mock.calls
    .filter(([method]) => method === "setMyCommands")
    .map(([, payload]) => payload as { commands: BotCommand[]; language_code?: string })
    .find(({ language_code }) => !language_code)?.commands;
  expect(menu?.filter(({ command }) => command === "dashboard")).toHaveLength(1);
  expect(menu?.filter(({ command }) => command === "controlui")).toEqual([
    { command: "controlui", description: "Open the OpenClaw Control UI" },
  ]);

  apiCalls.mockClear();
  await bot.handleUpdate({ update_id: 1001, message: commandMessage("/controlui") });
  const denied = apiCalls.mock.calls.filter(([method]) => method === "sendMessage");
  expect(denied).toEqual([
    [
      "sendMessage",
      expect.objectContaining({
        text: expect.stringContaining(`Telegram user ID (${from.id})`),
      }),
    ],
  ]);
  expect(denied[0]?.[1]).toMatchObject({ text: expect.stringContaining("retry /controlui") });
  expect(denied[0]?.[1]).not.toHaveProperty("reply_markup");
  expect(harness.replySpy).not.toHaveBeenCalled();

  cfg.channels!.telegram!.allowFrom = ["*", String(from.id)];
  publishTelegramTestConfig(cfg);
  apiCalls.mockClear();
  await bot.handleUpdate({ update_id: 1002, message: commandMessage("/controlui") });
  const granted = apiCalls.mock.calls.filter(([method]) => method === "sendMessage");
  expect(granted).toEqual([
    [
      "sendMessage",
      expect.objectContaining({
        text: "Open OpenClaw Control UI.",
        reply_markup: {
          inline_keyboard: [[{ text: "Open Control UI", web_app: { url: expect.any(String) } }]],
        },
      }),
    ],
  ]);
  const payload = granted[0]![1] as {
    reply_markup: { inline_keyboard: Array<Array<{ web_app: { url: string } }>> };
  };
  const launchUrl = new URL(payload.reply_markup.inline_keyboard[0]![0]!.web_app.url);
  expect(launchUrl.origin).toBe("https://gateway.example");
  expect(
    launchTickets.consume({
      ticket: new URLSearchParams(launchUrl.hash.slice(1)).get("launchTicket") ?? "",
      accountId: "default",
      userId: String(from.id),
    }),
  ).toBe(true);
  expect(harness.replySpy).not.toHaveBeenCalled();

  await bot.handleUpdate({
    update_id: 1003,
    message: commandMessage("/dashboard release health"),
  });
  // Session dashboard creation belongs to the shared reply command owner after native fall-through.
  expect(harness.replySpy).toHaveBeenCalledOnce();
  expect(harness.replySpy.mock.calls[0]?.[0]).toMatchObject({
    CommandSource: "native",
    CommandBody: "/dashboard release health",
    CommandTurn: { kind: "native", body: "/dashboard release health", authorized: true },
  });
});
