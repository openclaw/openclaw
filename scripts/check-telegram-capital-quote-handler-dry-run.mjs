import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { registerTelegramHandlers } from "../extensions/telegram/src/bot-handlers.runtime.ts";

const handlers = new Map();
const sendMessageCalls = [];
let processMessageCalled = false;
const nowIso = new Date().toISOString();

const fixtureDir = path.join(process.cwd(), ".artifacts", "telegram-capital-quote-handler-dry-run");
const fixturePath = path.join(fixtureDir, "capital-reportable-quote-state.json");
await fs.mkdir(fixtureDir, { recursive: true });
await fs.writeFile(
  fixturePath,
  JSON.stringify(
    {
      schema: "openclaw.capital.reportable-quote-state.v1",
      status: "partial_ready",
      quotePolicy: "fresh_matched_only",
      summary: {
        reportableCount: 6,
        blockedCount: 1,
      },
      reportableQuotes: [
        {
          query: "A50",
          symbol: "CN0000",
          name: "A50指熱2605",
          source: "overseas",
          close: 15472,
          bid: 15471,
          ask: 15473,
          receivedAt: nowIso,
          maxAgeMs: 3600000,
          sourceFile: "dry-run-reportable-state.json",
        },
        {
          query: "TX00",
          symbol: "TX00AM",
          name: "台指近",
          source: "domestic",
          close: 40078,
          bid: 40078,
          ask: 40079,
          receivedAt: nowIso,
          maxAgeMs: 3600000,
          sourceFile: "dry-run-reportable-state.json",
        },
        {
          query: "TX06AM",
          symbol: "TX06AM",
          name: "台指06",
          source: "domestic",
          close: 40108,
          bid: 40107,
          ask: 40109,
          receivedAt: nowIso,
          maxAgeMs: 3600000,
          sourceFile: "dry-run-reportable-state.json",
        },
        {
          query: "TX07AM",
          symbol: "TX07AM",
          name: "台指07",
          source: "domestic",
          close: 40158,
          bid: 40157,
          ask: 40159,
          receivedAt: nowIso,
          maxAgeMs: 3600000,
          sourceFile: "dry-run-reportable-state.json",
        },
        {
          query: "CL0000",
          symbol: "CL0000",
          name: "輕原油熱2607",
          source: "overseas",
          close: 103.85,
          bid: 103.83,
          ask: 103.86,
          receivedAt: nowIso,
          maxAgeMs: 3600000,
          sourceFile: "dry-run-reportable-state.json",
        },
        {
          query: "BZ0000",
          symbol: "BZ0000",
          name: "布蘭特油熱2607",
          source: "overseas",
          close: 110.84,
          bid: 110.83,
          ask: 110.86,
          receivedAt: nowIso,
          maxAgeMs: 3600000,
          sourceFile: "dry-run-reportable-state.json",
        },
      ],
      blockedQuotes: [
        {
          symbol: "GC0000",
          source: "overseas",
          diagnosis: "missing_callback",
          blockedCategory: "missing_callback",
          reason: "dry-run fixture: no fresh callback for gold.",
          unblockCondition: "official SKOSQuoteLib fresh callback returns for GC0000.",
          recommendedAction: "verify subscription and entitlement before reporting.",
          lastEvent: {
            stockNo: "GC0000",
            stockName: "黃金熱",
            receivedAt: nowIso,
            sourceFile: "dry-run-reportable-state.json",
          },
        },
      ],
    },
    null,
    2,
  ),
);
process.env.OPENCLAW_CAPITAL_QUOTE_REPORTABLE_STATE = fixturePath;
process.env.OPENCLAW_CAPITAL_QUOTE_NO_REFRESH = "1";

const bot = {
  api: {
    sendMessage: async (...args) => {
      sendMessageCalls.push(args);
      return { message_id: 9001, chat: { id: args[0] } };
    },
  },
  on: (event, handler) => {
    handlers.set(event, handler);
  },
};

const runtime = {
  log: () => undefined,
  warn: () => undefined,
  error: (message) => {
    throw new Error(String(message));
  },
};

const telegramDeps = {
  getRuntimeConfig: () => ({}),
  resolveStorePath: () => "reports/hermes-agent/state/telegram-handler-dry-run-session.json",
  loadSessionStore: () => ({}),
  readChannelAllowFromStore: async () => [],
  upsertChannelPairingRequest: async () => ({ code: "DRYRUN", created: true }),
  enqueueSystemEvent: async () => undefined,
  dispatchReplyWithBufferedBlockDispatcher: async () => ({
    queuedFinal: false,
    counts: { block: 0, final: 0, tool: 0 },
  }),
  buildModelsProviderData: async () => ({
    byProvider: new Map(),
    providers: [],
    resolvedDefault: { provider: "openai", model: "dry-run" },
    modelNames: new Map(),
  }),
  listSkillCommandsForAgents: () => [],
  createChannelMessageReplyPipeline: () => ({
    responsePrefix: undefined,
    responsePrefixContextProvider: () => ({ identityName: undefined }),
    onModelSelected: () => undefined,
  }),
  wasSentByBot: () => false,
  createTelegramDraftStream: () => null,
  deliverReplies: async () => undefined,
  deliverInboundReplyWithMessageSendContext: async () => undefined,
  emitInternalMessageSentHook: async () => undefined,
  editMessageTelegram: async () => undefined,
};

registerTelegramHandlers({
  cfg: {},
  accountId: "default",
  bot,
  opts: { token: "dry-run-token" },
  runtime,
  mediaMaxBytes: 8 * 1024 * 1024,
  telegramCfg: { dmPolicy: "open" },
  telegramDeps,
  allowFrom: [],
  groupAllowFrom: [],
  resolveGroupPolicy: () => "all",
  resolveTelegramGroupConfig: () => ({
    groupConfig: { enabled: true, dmPolicy: "open" },
    topicConfig: undefined,
  }),
  shouldSkipUpdate: () => false,
  processMessage: async () => {
    processMessageCalled = true;
  },
  logger: {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  },
});

const messageHandler = handlers.get("message");
assert.equal(typeof messageHandler, "function", "message handler must be registered");

function assertInstantQuoteMetadata(replyText) {
  if (!replyText.includes("狀態=即時")) {
    return;
  }
  assert.match(
    replyText,
    /全商品監控=另有(?:stale|session_closed|missing_callback|not_subscribed|zero_or_unusable_price)|全商品監控=全部就緒/u,
  );
  assert.match(replyText, /本商品=可用|全商品監控=全部就緒/u);
}

await messageHandler({
  me: { id: 999, is_bot: true, username: "OpenClawBot", first_name: "OpenClaw" },
  message: {
    message_id: 123,
    date: Math.floor(Date.now() / 1000),
    chat: { id: 777, type: "private", first_name: "Dry" },
    from: { id: 456, is_bot: false, first_name: "Tester", username: "tester" },
    text: "A50目前報價",
  },
  getFile: async () => ({}),
});

assert.equal(processMessageCalled, false, "quote dry-run must bypass model processMessage");
assert.equal(sendMessageCalls.length, 1, "quote dry-run must send exactly one Telegram message");

const [chatId, replyText, options] = sendMessageCalls[0];
assert.equal(chatId, 777);
assert.match(replyText, /^\[OpenClaw 報價\]/u);
assert.match(replyText, /A50|CN0000|封鎖/u);
assertInstantQuoteMetadata(replyText);
assert.match(replyText, /真單=封鎖/u);
assert.doesNotMatch(replyText, /@openclaw\/cron-direct/u);
assert.doesNotMatch(replyText, /Repository not found/u);
assert.equal(options?.reply_parameters?.message_id, 123);
assert.equal(options?.reply_parameters?.allow_sending_without_reply, true);

await messageHandler({
  me: { id: 999, is_bot: true, username: "OpenClawBot", first_name: "OpenClaw" },
  message: {
    message_id: 124,
    date: Math.floor(Date.now() / 1000),
    chat: { id: 777, type: "private", first_name: "Dry" },
    from: { id: 456, is_bot: false, first_name: "Tester", username: "tester" },
    text: "台指近最新價",
  },
  getFile: async () => ({}),
});

assert.equal(
  processMessageCalled,
  false,
  "natural quote dry-run must also bypass model processMessage",
);
assert.equal(
  sendMessageCalls.length,
  2,
  "natural quote dry-run must send a second Telegram message",
);

const [statusChatId, statusReplyText, statusOptions] = sendMessageCalls[1];
assert.equal(statusChatId, 777);
assert.match(statusReplyText, /^\[OpenClaw 報價\]/u);
assert.match(statusReplyText, /台指近|TX00AM|封鎖/u);
assertInstantQuoteMetadata(statusReplyText);
assert.match(statusReplyText, /真單=封鎖/u);
assert.doesNotMatch(statusReplyText, /OpenClaw Quote/u);
assert.doesNotMatch(statusReplyText, /@openclaw\/cron-direct/u);
assert.doesNotMatch(statusReplyText, /Repository not found/u);
assert.equal(statusOptions?.reply_parameters?.message_id, 124);
assert.equal(statusOptions?.reply_parameters?.allow_sending_without_reply, true);

await messageHandler({
  me: { id: 999, is_bot: true, username: "OpenClawBot", first_name: "OpenClaw" },
  message: {
    message_id: 125,
    date: Math.floor(Date.now() / 1000),
    chat: { id: 777, type: "private", first_name: "Dry" },
    from: { id: 456, is_bot: false, first_name: "Tester", username: "tester" },
    text: "台指期當月報價",
  },
  getFile: async () => ({}),
});

assert.equal(
  processMessageCalled,
  false,
  "TXF current-month quote dry-run must also bypass model processMessage",
);
assert.equal(
  sendMessageCalls.length,
  3,
  "TXF current-month quote dry-run must send a third Telegram message",
);

const [txfChatId, txfReplyText, txfOptions] = sendMessageCalls[2];
assert.equal(txfChatId, 777);
assert.match(txfReplyText, /^\[OpenClaw 報價\]/u);
assert.match(txfReplyText, /台指06|TX06AM/u);
assert.match(txfReplyText, /月份路由=TXF\/current-month\/TX06AM,TX06PM,TX06/u);
assert.doesNotMatch(txfReplyText, /月份路由=TXF\/current-month\/TX00/u);
assertInstantQuoteMetadata(txfReplyText);
assert.match(txfReplyText, /真單=封鎖/u);
assert.doesNotMatch(txfReplyText, /OpenClaw Quote/u);
assert.doesNotMatch(txfReplyText, /@openclaw\/cron-direct/u);
assert.doesNotMatch(txfReplyText, /Repository not found/u);
assert.equal(txfOptions?.reply_parameters?.message_id, 125);
assert.equal(txfOptions?.reply_parameters?.allow_sending_without_reply, true);

await messageHandler({
  me: { id: 999, is_bot: true, username: "OpenClawBot", first_name: "OpenClaw" },
  message: {
    message_id: 126,
    date: Math.floor(Date.now() / 1000),
    chat: { id: 777, type: "private", first_name: "Dry" },
    from: { id: 456, is_bot: false, first_name: "Tester", username: "tester" },
    text: "台指期下個月報價",
  },
  getFile: async () => ({}),
});

assert.equal(
  processMessageCalled,
  false,
  "TXF next-month quote dry-run must also bypass model processMessage",
);
assert.equal(
  sendMessageCalls.length,
  4,
  "TXF next-month quote dry-run must send a fourth Telegram message",
);

const [txfNextChatId, txfNextReplyText, txfNextOptions] = sendMessageCalls[3];
assert.equal(txfNextChatId, 777);
assert.match(txfNextReplyText, /^\[OpenClaw 報價\]/u);
assert.match(txfNextReplyText, /台指07|TX07AM/u);
assert.match(txfNextReplyText, /月份路由=TXF\/next-month\/TX07AM,TX07PM,TX07/u);
assert.doesNotMatch(txfNextReplyText, /月份路由=TXF\/next-month\/TX00/u);
assert.doesNotMatch(txfNextReplyText, /月份路由=TXF\/next-month\/TX06/u);
assertInstantQuoteMetadata(txfNextReplyText);
assert.match(txfNextReplyText, /真單=封鎖/u);
assert.doesNotMatch(txfNextReplyText, /OpenClaw Quote/u);
assert.doesNotMatch(txfNextReplyText, /@openclaw\/cron-direct/u);
assert.doesNotMatch(txfNextReplyText, /Repository not found/u);
assert.equal(txfNextOptions?.reply_parameters?.message_id, 126);
assert.equal(txfNextOptions?.reply_parameters?.allow_sending_without_reply, true);

await messageHandler({
  me: { id: 999, is_bot: true, username: "OpenClawBot", first_name: "OpenClaw" },
  message: {
    message_id: 127,
    date: Math.floor(Date.now() / 1000),
    chat: { id: 777, type: "private", first_name: "Dry" },
    from: { id: 456, is_bot: false, first_name: "Tester", username: "tester" },
    text: "原油期貨報",
  },
  getFile: async () => ({}),
});

assert.equal(
  processMessageCalled,
  false,
  "crude quote dry-run must also bypass model processMessage",
);
assert.equal(sendMessageCalls.length, 5, "crude quote dry-run must send a fifth Telegram message");

const [crudeChatId, crudeReplyText, crudeOptions] = sendMessageCalls[4];
assert.equal(crudeChatId, 777);
assert.match(crudeReplyText, /^\[OpenClaw 報價\]/u);
assert.match(crudeReplyText, /原油|CL0000|封鎖/u);
assertInstantQuoteMetadata(crudeReplyText);
assert.match(crudeReplyText, /真單=封鎖/u);
assert.doesNotMatch(crudeReplyText, /OpenClaw Quote/u);
assert.doesNotMatch(crudeReplyText, /@openclaw\/cron-direct/u);
assert.doesNotMatch(crudeReplyText, /Repository not found/u);
assert.equal(crudeOptions?.reply_parameters?.message_id, 127);
assert.equal(crudeOptions?.reply_parameters?.allow_sending_without_reply, true);

await messageHandler({
  me: { id: 999, is_bot: true, username: "OpenClawBot", first_name: "OpenClaw" },
  message: {
    message_id: 128,
    date: Math.floor(Date.now() / 1000),
    chat: { id: 777, type: "private", first_name: "Dry" },
    from: { id: 456, is_bot: false, first_name: "Tester", username: "tester" },
    text: "布蘭特油報價",
  },
  getFile: async () => ({}),
});

assert.equal(
  processMessageCalled,
  false,
  "Brent quote dry-run must also bypass model processMessage",
);
assert.equal(sendMessageCalls.length, 6, "Brent quote dry-run must send a sixth Telegram message");

const [brentChatId, brentReplyText, brentOptions] = sendMessageCalls[5];
assert.equal(brentChatId, 777);
assert.match(brentReplyText, /^\[OpenClaw 報價\]/u);
assert.match(brentReplyText, /布蘭特|BZ0000|封鎖/u);
assertInstantQuoteMetadata(brentReplyText);
assert.match(brentReplyText, /真單=封鎖/u);
assert.doesNotMatch(brentReplyText, /OpenClaw Quote/u);
assert.doesNotMatch(brentReplyText, /@openclaw\/cron-direct/u);
assert.doesNotMatch(brentReplyText, /Repository not found/u);
assert.equal(brentOptions?.reply_parameters?.message_id, 128);
assert.equal(brentOptions?.reply_parameters?.allow_sending_without_reply, true);

await messageHandler({
  me: { id: 999, is_bot: true, username: "OpenClawBot", first_name: "OpenClaw" },
  message: {
    message_id: 129,
    date: Math.floor(Date.now() / 1000),
    chat: { id: 777, type: "private", first_name: "Dry" },
    from: { id: 456, is_bot: false, first_name: "Tester", username: "tester" },
    text: "黃金期貨目前價",
  },
  getFile: async () => ({}),
});

assert.equal(
  processMessageCalled,
  false,
  "gold blocked quote dry-run must also bypass model processMessage",
);
assert.equal(
  sendMessageCalls.length,
  7,
  "gold blocked quote dry-run must send a seventh Telegram message",
);

const [goldChatId, goldReplyText, goldOptions] = sendMessageCalls[6];
assert.equal(goldChatId, 777);
assert.match(goldReplyText, /^\[OpenClaw 報價\]/u);
assert.match(goldReplyText, /黃金|GC0000|封鎖/u);
assert.match(goldReplyText, /不可回舊價/u);
assert.match(goldReplyText, /真單=封鎖/u);
assert.doesNotMatch(goldReplyText, /OpenClaw Quote/u);
assert.doesNotMatch(goldReplyText, /@openclaw\/cron-direct/u);
assert.doesNotMatch(goldReplyText, /Repository not found/u);
assert.equal(goldOptions?.reply_parameters?.message_id, 129);
assert.equal(goldOptions?.reply_parameters?.allow_sending_without_reply, true);

process.stdout.write(
  `telegram capital quote handler dry-run check PASS\n${replyText}\n${statusReplyText}\n${txfReplyText}\n${txfNextReplyText}\n${crudeReplyText}\n${brentReplyText}\n${goldReplyText}\n`,
);
process.exit(0);
