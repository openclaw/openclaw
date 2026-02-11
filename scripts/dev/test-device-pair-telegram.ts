import { loadConfig } from "../../src/config/config.js";
import { matchPluginCommand, executePluginCommand } from "../../src/plugins/commands.js";
import { loadOpenClawPlugins } from "../../src/plugins/loader.js";
import { sendMessageTelegram } from "../../src/telegram/send.js";

const args = process.argv.slice(2);
const getArg = (flag: string, short?: string) => {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1];
  }
  if (short) {
    const sidx = args.indexOf(short);
    if (sidx !== -1 && sidx + 1 < args.length) {
      return args[sidx + 1];
    }
  }
  return undefined;
};

const chatId = getArg("--chat", "-c");
const accountId = getArg("--account", "-a");
if (!chatId) {
  // eslint-disable-next-line no-console
  console.error(
    "Usage: bun scripts/dev/test-device-pair-telegram.ts --chat <telegram-chat-id> [--account <accountId>]",
  );
  process.exit(1);
}

const cfg = loadConfig();
loadOpenClawPlugins({ config: cfg });

const match = matchPluginCommand("/pair");
if (!match) {
  // eslint-disable-next-line no-console
  console.error("/pair plugin command not registered.");
  process.exit(1);
}

const result = await executePluginCommand({
  command: match.command,
  args: match.args,
  senderId: chatId,
  channel: "telegram",
  channelId: "telegram",
  isAuthorizedSender: true,
  commandBody: "/pair",
  config: cfg,
  from: `telegram:${chatId}`,
  to: `telegram:${chatId}`,
  accountId: accountId,
});

if (result.text) {
  await sendMessageTelegram(chatId, result.text, {
    accountId: accountId,
  });
}

// eslint-disable-next-line no-console
console.log("Sent split /pair messages to", chatId, accountId ? `(${accountId})` : "");
