// Manager Bot: grammY-based Telegram bot exposing /install /status /cancel.
// Transport-owned; orchestrator owns the state machine.
import { Bot } from "grammy";
import { validateBotName, validateBotUsername } from "./mtproto-managed-bots.js";
import { retryFailed, startProvisioning } from "./provisioning-orchestrator.js";
import type { OrchestratorDeps } from "./provisioning-orchestrator.js";
import type { ProvisioningStore } from "./provisioning-store.js";

export type ManagerBotHandle = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

type SendText = (chatId: number | string, text: string) => Promise<void>;

export function parseInstallArgs(
  text: string,
): { botName: string; botUsername: string } | { error: string } {
  // "/install My Bot|mybot_bot" or "/install mybot_bot"
  const rest = text.replace(/^\/install(@\S+)?\s*/, "").trim();
  if (!rest) {
    return {
      error: "Usage: /install <bot_username_ending_in_bot> or /install <Display Name>|<username>",
    };
  }
  let botName: string;
  let botUsername: string;
  if (rest.includes("|")) {
    const [n, u] = rest.split("|").map((s) => s.trim());
    botName = n ?? "";
    botUsername = (u ?? "").replace(/^@/, "");
  } else {
    botUsername = rest.replace(/^@/, "").split(/\s+/)[0] ?? "";
    botName =
      botUsername
        .replace(/[_-]+bot$/i, "")
        .replace(/[_-]+/g, " ")
        .trim() || botUsername;
  }
  const nv = validateBotUsername(botUsername);
  if (!nv.valid) {
    return { error: nv.reason ?? "Invalid username" };
  }
  const nn = validateBotName(botName);
  if (!nn.valid) {
    return { error: nn.reason ?? "Invalid name" };
  }
  return { botName, botUsername };
}

export function createManagerBot(params: {
  token: string;
  deps: OrchestratorDeps;
  store: ProvisioningStore;
  sendText?: SendText;
}): ManagerBotHandle & { bot: Bot } {
  const bot = new Bot(params.token);
  const notifyDefault: SendText = async (chatId, text) => {
    await bot.api.sendMessage(chatId, text);
  };
  const send = params.sendText ?? notifyDefault;

  bot.command("start", async (ctx) => {
    await ctx.reply(
      "Welcome to the OpenClaw Manager Bot.\n\n/install <username_bot> — provision your own OpenClaw + Telegram bot\n/status — check provisioning progress\n/cancel — cancel a failed run so you can retry",
    );
  });

  bot.command("install", async (ctx) => {
    const telegramUserId = String(ctx.from?.id ?? "");
    if (!telegramUserId) {
      return;
    }
    const parsed = parseInstallArgs(ctx.msg?.text ?? "/install");
    if ("error" in parsed) {
      await ctx.reply(`❌ ${parsed.error}`);
      return;
    }
    try {
      await startProvisioning(params.deps, {
        telegramUserId,
        botName: parsed.botName,
        botUsername: parsed.botUsername,
      });
      await ctx.reply(
        `🚀 Provisioning started for @${parsed.botUsername} (REQUESTED → CREATING_BOT…). I'll update you here.`,
      );
    } catch (error) {
      await ctx.reply(`❌ ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  bot.command("status", async (ctx) => {
    const telegramUserId = String(ctx.from?.id ?? "");
    const record = await params.store.load(telegramUserId);
    if (!record) {
      await ctx.reply("No provisioning found. Send /install first.");
      return;
    }
    const lines = [
      `State: ${record.state}`,
      record.botUsername ? `Bot: @${record.botUsername}` : "",
      record.serverIp ? `Server: ${record.serverIp}` : "",
      record.error ? `Error: ${record.error}` : "",
      `Updated: ${record.updatedAt}`,
    ].filter(Boolean);
    await ctx.reply(lines.join("\n"));
  });

  bot.command("cancel", async (ctx) => {
    const telegramUserId = String(ctx.from?.id ?? "");
    try {
      await retryFailed({ store: params.store }, telegramUserId);
      await send(ctx.chat.id, "Reset to REQUESTED. Send /install to start again.");
    } catch (error) {
      await ctx.reply(`❌ ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  return {
    bot,
    start: () => bot.start(),
    stop: () => bot.stop(),
  };
}
