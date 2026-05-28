import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const repoRoot = process.cwd();
const telegramCommandsPath = path.join(
  repoRoot,
  "extensions",
  "telegram",
  "src",
  "bot-native-commands.ts",
);
const packagePath = path.join(repoRoot, "package.json");

const source = await fs.readFile(telegramCommandsPath, "utf8");
const pkg = JSON.parse(await fs.readFile(packagePath, "utf8"));

assert.match(source, /CAPITAL_QUOTE_TELEGRAM_COMMAND/u);
assert.match(source, /command:\s*"quote"/u);
assert.match(source, /openclaw-capital-quote-telegram-reply\.mjs/u);
assert.match(source, /execFileAsync\(\s*process\.execPath/u);
assert.match(source, /bot\.command\(\s*CAPITAL_QUOTE_TELEGRAM_COMMAND\.command/u);
assert.match(source, /resolveTelegramCommandAuth\(/u);
assert.match(source, /buildCapitalQuoteTelegramReplyFromScript/u);

assert.equal(
  pkg.scripts["capital:telegram:quote-command:check"],
  "node --import tsx scripts/check-telegram-capital-quote-command.mjs",
);

const { registerTelegramNativeCommands } =
  await import("../extensions/telegram/src/bot-native-commands.ts");

const commandHandlers = new Map();
const sendMessageCalls = [];
const setMyCommandsCalls = [];

const bot = {
  api: {
    setMyCommands: async (...args) => {
      setMyCommandsCalls.push(args);
      return undefined;
    },
    sendMessage: async (...args) => {
      sendMessageCalls.push(args);
      return { message_id: 9101, chat: { id: args[0] } };
    },
  },
  command: (name, handler) => {
    commandHandlers.set(name, handler);
  },
};

const cfg = {};
const telegramDeps = {
  getRuntimeConfig: () => cfg,
  readChannelAllowFromStore: async () => [],
  dispatchReplyWithBufferedBlockDispatcher: async () => ({
    queuedFinal: false,
    counts: { block: 0, final: 0, tool: 0 },
  }),
  listSkillCommandsForAgents: () => [],
  syncTelegramMenuCommands: ({ bot: runtimeBot, commandsToRegister }) => {
    if (commandsToRegister.length > 0) {
      return runtimeBot.api.setMyCommands(commandsToRegister);
    }
    return undefined;
  },
  getPluginCommandSpecs: () => [],
  editMessageTelegram: async () => ({ ok: true, messageId: "9101", chatId: "777" }),
};

registerTelegramNativeCommands({
  bot,
  cfg,
  runtime: {
    log: () => undefined,
    error: () => undefined,
  },
  accountId: "default",
  telegramCfg: { dmPolicy: "allowlist" },
  allowFrom: [456],
  groupAllowFrom: [],
  replyToMode: "off",
  textLimit: 4000,
  useAccessGroups: false,
  nativeEnabled: true,
  nativeSkillsEnabled: false,
  nativeDisabledExplicit: false,
  resolveGroupPolicy: () => ({
    allowlistEnabled: false,
    allowed: true,
  }),
  resolveTelegramGroupConfig: () => ({
    groupConfig: undefined,
    topicConfig: undefined,
  }),
  shouldSkipUpdate: () => false,
  telegramDeps,
  opts: { token: "dry-run-token" },
});

assert.ok(commandHandlers.has("quote"), "native /quote handler must be registered");
assert.ok(
  setMyCommandsCalls.some(
    (call) => Array.isArray(call[0]) && call[0].some((command) => command.command === "quote"),
  ),
  "Telegram command menu must include /quote",
);

await commandHandlers.get("quote")({
  match: "status",
  message: {
    message_id: 1001,
    date: Math.floor(Date.now() / 1000),
    chat: { id: 777, type: "private", first_name: "Dry" },
    from: { id: 456, is_bot: false, first_name: "Tester", username: "tester" },
    text: "/quote status",
  },
});

assert.equal(sendMessageCalls.length, 1, "native /quote status must send one Telegram reply");
const [chatId, replyText, options] = sendMessageCalls[0];
assert.equal(chatId, 777);
assert.match(replyText, /^\[OpenClaw 報價\]/u);
assert.match(replyText, /自動化狀態：自動化=/u);
assert.match(replyText, /freshness=\d+\/\d+/u);
assert.match(replyText, /failedSteps=/u);
assert.match(replyText, /sentOrder=false/u);
assert.match(replyText, /真單：封鎖/u);
assert.match(replyText, /下單模式=國內當沖\/國內非當沖\/海外當沖\/海外非當沖:(?:READY|正常)/u);
assert.match(replyText, /Telegram=send-only:openclaw_gateway/u);
assert.doesNotMatch(replyText, /OpenClaw Quote/u);
const coreMatch = /核心商品：已就緒 (\d+)\/(\d+)/u.exec(replyText);
const automationMatch = /freshness=(\d+)\/(\d+)/u.exec(replyText);
if (
  coreMatch &&
  automationMatch &&
  (coreMatch[1] !== automationMatch[1] || coreMatch[2] !== automationMatch[2])
) {
  assert.match(replyText, /一致性：即時矩陣=\d+\/\d+｜自動化快照=\d+\/\d+｜以即時矩陣為準/u);
}
assert.doesNotMatch(replyText, /@openclaw\/cron-direct/u);
assert.doesNotMatch(replyText, /Repository not found/u);
assert.ok(
  options && typeof options === "object",
  "native /quote status should include send options",
);
assert.ok(
  options.reply_markup &&
    typeof options.reply_markup === "object" &&
    Array.isArray(options.reply_markup.inline_keyboard),
  "native /quote status must include inline keyboard buttons",
);
const keyboardRows = options.reply_markup.inline_keyboard;
const callbackData = keyboardRows.flat().map((button) => String(button?.callback_data ?? ""));
assert.ok(
  callbackData.includes("tgcmd:/quote status"),
  "native /quote keyboard must include refresh callback",
);
assert.ok(
  callbackData.includes("tgcmd:/quote simlive tx00 buy 1"),
  "native /quote keyboard must include simulated buy callback",
);
assert.ok(
  callbackData.includes("tgcmd:/quote simlive tx00 sell 1"),
  "native /quote keyboard must include simulated sell callback",
);
assert.ok(
  callbackData.includes("tgcmd:/quote semi"),
  "native /quote keyboard must include semi approval status callback",
);
assert.ok(
  callbackData.includes("tgcmd:/quote semi approve"),
  "native /quote keyboard must include semi approval approve callback",
);
assert.ok(
  callbackData.includes("tgcmd:/quote semi reject"),
  "native /quote keyboard must include semi approval reject callback",
);
assert.ok(
  callbackData.every((value) => value.startsWith("tgcmd:/")),
  "native /quote keyboard callbacks must preserve tgcmd prefix",
);

sendMessageCalls.length = 0;
await commandHandlers.get("quote")({
  match: "telegram",
  message: {
    message_id: 1002,
    date: Math.floor(Date.now() / 1000),
    chat: { id: 777, type: "private", first_name: "Dry" },
    from: { id: 456, is_bot: false, first_name: "Tester", username: "tester" },
    text: "/quote telegram",
  },
});

assert.equal(
  sendMessageCalls.length,
  1,
  "native /quote telegram must send one Telegram owner reply",
);
const [, ownerReplyText] = sendMessageCalls[0];
assert.match(ownerReplyText, /^\[OpenClaw Telegram 自檢\]/u);
assert.match(ownerReplyText, /收訊入口=OpenClaw Gateway/u);
assert.match(ownerReplyText, /CapitalHftService=send-only/u);
assert.match(ownerReplyText, /第二個poller=無/u);
assert.doesNotMatch(ownerReplyText, /OpenClaw Quote/u);

sendMessageCalls.length = 0;
await commandHandlers.get("quote")({
  match: "semi",
  message: {
    message_id: 1003,
    date: Math.floor(Date.now() / 1000),
    chat: { id: 777, type: "private", first_name: "Dry" },
    from: { id: 456, is_bot: false, first_name: "Tester", username: "tester" },
    text: "/quote semi",
  },
});

assert.equal(sendMessageCalls.length, 1, "native /quote semi must send one Telegram semi reply");
const [, semiReplyText] = sendMessageCalls[0];
assert.match(semiReplyText, /^\[OpenClaw SEMI/u);

process.stdout.write("telegram capital quote command check PASS\n");
process.stdout.write(`${replyText}\n`);
