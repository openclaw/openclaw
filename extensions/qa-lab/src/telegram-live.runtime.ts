import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { startQaGatewayChild } from "./gateway-child.js";
import {
  defaultQaModelForMode,
  normalizeQaProviderMode,
  type QaProviderModeInput,
} from "./run-config.js";

type TelegramQaRuntimeEnv = {
  groupId: string;
  driverToken: string;
  sutToken: string;
};

type TelegramBotIdentity = {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
};

type TelegramQaScenarioDefinition = {
  id: "telegram-help-command";
  title: string;
  timeoutMs: number;
  buildInput: (sutUsername: string) => string;
};

type TelegramObservedMessage = {
  updateId: number;
  messageId: number;
  chatId: number;
  senderId: number;
  senderIsBot: boolean;
  senderUsername?: string;
  text: string;
  caption?: string;
  replyToMessageId?: number;
  timestamp: number;
  inlineButtons: string[];
  mediaKinds: string[];
};

type TelegramQaScenarioResult = {
  id: string;
  title: string;
  status: "pass" | "fail";
  details: string;
};

export type TelegramQaRunResult = {
  outputDir: string;
  reportPath: string;
  summaryPath: string;
  observedMessagesPath: string;
  scenarios: TelegramQaScenarioResult[];
};

type TelegramQaSummary = {
  groupId: string;
  startedAt: string;
  finishedAt: string;
  counts: {
    total: number;
    passed: number;
    failed: number;
  };
  scenarios: TelegramQaScenarioResult[];
};

type TelegramApiEnvelope<T> = {
  ok: boolean;
  result?: T;
  description?: string;
};

type TelegramReplyMarkup = {
  inline_keyboard?: Array<Array<{ text?: string }>>;
};

type TelegramMessage = {
  message_id: number;
  date: number;
  text?: string;
  caption?: string;
  reply_markup?: TelegramReplyMarkup;
  reply_to_message?: { message_id?: number };
  from?: {
    id?: number;
    is_bot?: boolean;
    username?: string;
  };
  chat: {
    id: number;
  };
  photo?: unknown[];
  document?: unknown;
  audio?: unknown;
  video?: unknown;
  voice?: unknown;
  sticker?: unknown;
};

type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
};

type TelegramSendMessageResult = {
  message_id: number;
  chat: {
    id: number;
  };
};

const TELEGRAM_QA_SCENARIOS: TelegramQaScenarioDefinition[] = [
  {
    id: "telegram-help-command",
    title: "Telegram help command reply",
    timeoutMs: 45_000,
    buildInput: (sutUsername) => `/help@${sutUsername}`,
  },
];

const TELEGRAM_QA_ENV_KEYS = [
  "OPENCLAW_QA_TELEGRAM_GROUP_ID",
  "OPENCLAW_QA_TELEGRAM_DRIVER_BOT_TOKEN",
  "OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN",
] as const;

function resolveEnvValue(env: NodeJS.ProcessEnv, key: (typeof TELEGRAM_QA_ENV_KEYS)[number]) {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`Missing ${key}.`);
  }
  return value;
}

export function resolveTelegramQaRuntimeEnv(
  env: NodeJS.ProcessEnv = process.env,
): TelegramQaRuntimeEnv {
  const groupId = resolveEnvValue(env, "OPENCLAW_QA_TELEGRAM_GROUP_ID");
  if (!/^-?\d+$/u.test(groupId)) {
    throw new Error("OPENCLAW_QA_TELEGRAM_GROUP_ID must be a numeric Telegram chat id.");
  }
  return {
    groupId,
    driverToken: resolveEnvValue(env, "OPENCLAW_QA_TELEGRAM_DRIVER_BOT_TOKEN"),
    sutToken: resolveEnvValue(env, "OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN"),
  };
}

function flattenInlineButtons(replyMarkup?: TelegramReplyMarkup) {
  return (replyMarkup?.inline_keyboard ?? [])
    .flat()
    .map((button) => button.text?.trim())
    .filter((text): text is string => Boolean(text));
}

function detectMediaKinds(message: TelegramMessage) {
  const kinds: string[] = [];
  if (Array.isArray(message.photo) && message.photo.length > 0) {
    kinds.push("photo");
  }
  if (message.document) {
    kinds.push("document");
  }
  if (message.audio) {
    kinds.push("audio");
  }
  if (message.video) {
    kinds.push("video");
  }
  if (message.voice) {
    kinds.push("voice");
  }
  if (message.sticker) {
    kinds.push("sticker");
  }
  return kinds;
}

export function normalizeTelegramObservedMessage(
  update: TelegramUpdate,
): TelegramObservedMessage | null {
  const message = update.message;
  if (!message?.from?.id) {
    return null;
  }
  return {
    updateId: update.update_id,
    messageId: message.message_id,
    chatId: message.chat.id,
    senderId: message.from.id,
    senderIsBot: message.from.is_bot === true,
    senderUsername: message.from.username,
    text: message.text ?? message.caption ?? "",
    caption: message.caption,
    replyToMessageId: message.reply_to_message?.message_id,
    timestamp: message.date * 1000,
    inlineButtons: flattenInlineButtons(message.reply_markup),
    mediaKinds: detectMediaKinds(message),
  };
}

function buildTelegramQaConfig(
  baseCfg: OpenClawConfig,
  params: {
    groupId: string;
    sutToken: string;
    driverBotId: number;
    sutAccountId: string;
  },
): OpenClawConfig {
  const pluginAllow = [...new Set([...(baseCfg.plugins?.allow ?? []), "telegram"])];
  const pluginEntries = {
    ...baseCfg.plugins?.entries,
    telegram: { enabled: true },
  };
  return {
    ...baseCfg,
    plugins: {
      ...baseCfg.plugins,
      allow: pluginAllow,
      entries: pluginEntries,
    },
    channels: {
      ...baseCfg.channels,
      telegram: {
        enabled: true,
        defaultAccount: params.sutAccountId,
        accounts: {
          [params.sutAccountId]: {
            enabled: true,
            botToken: params.sutToken,
            dmPolicy: "disabled",
            groups: {
              [params.groupId]: {
                groupPolicy: "allowlist",
                allowFrom: [String(params.driverBotId)],
                requireMention: true,
              },
            },
          },
        },
      },
    },
  };
}

async function callTelegramApi<T>(
  token: string,
  method: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body ?? {}),
  });
  const payload = (await response.json()) as TelegramApiEnvelope<T>;
  if (!response.ok || !payload.ok || payload.result === undefined) {
    throw new Error(
      payload.description?.trim() || `${method} failed with status ${response.status}`,
    );
  }
  return payload.result;
}

async function getBotIdentity(token: string) {
  return await callTelegramApi<TelegramBotIdentity>(token, "getMe");
}

async function flushTelegramUpdates(token: string) {
  let offset = 0;
  while (true) {
    const updates = await callTelegramApi<TelegramUpdate[]>(token, "getUpdates", {
      offset,
      timeout: 0,
      allowed_updates: ["message"],
    });
    if (updates.length === 0) {
      return offset;
    }
    offset = (updates.at(-1)?.update_id ?? offset) + 1;
  }
}

async function sendGroupMessage(token: string, groupId: string, text: string) {
  return await callTelegramApi<TelegramSendMessageResult>(token, "sendMessage", {
    chat_id: groupId,
    text,
    disable_notification: true,
  });
}

async function waitForObservedMessage(params: {
  token: string;
  initialOffset: number;
  timeoutMs: number;
  predicate: (message: TelegramObservedMessage) => boolean;
  observedMessages: TelegramObservedMessage[];
}) {
  const startedAt = Date.now();
  let offset = params.initialOffset;
  while (Date.now() - startedAt < params.timeoutMs) {
    const remainingMs = Math.max(
      1_000,
      Math.min(10_000, params.timeoutMs - (Date.now() - startedAt)),
    );
    const timeoutSeconds = Math.max(1, Math.min(10, Math.floor(remainingMs / 1000)));
    const updates = await callTelegramApi<TelegramUpdate[]>(params.token, "getUpdates", {
      offset,
      timeout: timeoutSeconds,
      allowed_updates: ["message"],
    });
    if (updates.length === 0) {
      continue;
    }
    offset = (updates.at(-1)?.update_id ?? offset) + 1;
    for (const update of updates) {
      const normalized = normalizeTelegramObservedMessage(update);
      if (!normalized) {
        continue;
      }
      params.observedMessages.push(normalized);
      if (params.predicate(normalized)) {
        return { message: normalized, nextOffset: offset };
      }
    }
  }
  throw new Error(`timed out after ${params.timeoutMs}ms waiting for Telegram message`);
}

async function waitForTelegramChannelRunning(
  gateway: Awaited<ReturnType<typeof startQaGatewayChild>>,
  accountId: string,
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 45_000) {
    try {
      const payload = (await gateway.call(
        "channels.status",
        { probe: false, timeoutMs: 2_000 },
        { timeoutMs: 5_000 },
      )) as {
        channelAccounts?: Record<
          string,
          Array<{ accountId?: string; running?: boolean; restartPending?: boolean }>
        >;
      };
      const accounts = payload.channelAccounts?.telegram ?? [];
      const match = accounts.find((entry) => entry.accountId === accountId);
      if (match?.running && match.restartPending !== true) {
        return;
      }
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`telegram account "${accountId}" did not become ready`);
}

function renderTelegramQaMarkdown(params: {
  groupId: string;
  startedAt: string;
  finishedAt: string;
  scenarios: TelegramQaScenarioResult[];
}) {
  const lines = [
    "# Telegram QA Report",
    "",
    `- Group: \`${params.groupId}\``,
    `- Started: ${params.startedAt}`,
    `- Finished: ${params.finishedAt}`,
    "",
    "## Scenarios",
    "",
  ];
  for (const scenario of params.scenarios) {
    lines.push(`### ${scenario.title}`);
    lines.push("");
    lines.push(`- Status: ${scenario.status}`);
    lines.push(`- Details: ${scenario.details}`);
    lines.push("");
  }
  return lines.join("\n");
}

function findScenario(ids?: string[]) {
  if (!ids || ids.length === 0) {
    return [...TELEGRAM_QA_SCENARIOS];
  }
  const selected = TELEGRAM_QA_SCENARIOS.filter((scenario) => ids.includes(scenario.id));
  if (selected.length === 0) {
    throw new Error(`No Telegram QA scenarios matched: ${ids.join(", ")}`);
  }
  return selected;
}

async function runCanary(params: {
  driverToken: string;
  groupId: string;
  sutUsername: string;
  driverBotId: number;
  sutBotId: number;
  observedMessages: TelegramObservedMessage[];
}) {
  let offset = await flushTelegramUpdates(params.driverToken);
  const driverMessage = await sendGroupMessage(
    params.driverToken,
    params.groupId,
    `/help@${params.sutUsername}`,
  );
  const driverObserved = await waitForObservedMessage({
    token: params.driverToken,
    initialOffset: offset,
    timeoutMs: 20_000,
    observedMessages: params.observedMessages,
    predicate: (message) =>
      message.chatId === Number(params.groupId) &&
      message.senderId === params.driverBotId &&
      message.messageId === driverMessage.message_id,
  });
  offset = driverObserved.nextOffset;
  await waitForObservedMessage({
    token: params.driverToken,
    initialOffset: offset,
    timeoutMs: 30_000,
    observedMessages: params.observedMessages,
    predicate: (message) =>
      message.chatId === Number(params.groupId) &&
      message.senderId === params.sutBotId &&
      message.replyToMessageId === driverMessage.message_id &&
      message.text.trim().length > 0,
  });
}

function canaryFailureMessage(error: unknown) {
  const details = formatErrorMessage(error);
  return [
    "Telegram QA canary failed.",
    details,
    "Remediation:",
    "1. Enable Bot-to-Bot Communication Mode for both the driver and SUT bots in @BotFather.",
    "2. Ensure the driver bot can observe bot traffic in the private group by making it admin or disabling privacy mode, then re-add it.",
    "3. Ensure both bots are members of the same private group.",
    "4. Confirm the SUT bot is allowed to receive /help@BotUsername commands in that group.",
  ].join("\n");
}

export async function runTelegramQaLive(params: {
  repoRoot?: string;
  outputDir?: string;
  providerMode?: QaProviderModeInput;
  primaryModel?: string;
  alternateModel?: string;
  fastMode?: boolean;
  scenarioIds?: string[];
  sutAccountId?: string;
}): Promise<TelegramQaRunResult> {
  const repoRoot = path.resolve(params.repoRoot ?? process.cwd());
  const outputDir =
    params.outputDir ??
    path.join(repoRoot, ".artifacts", "qa-e2e", `telegram-${Date.now().toString(36)}`);
  await fs.mkdir(outputDir, { recursive: true });

  const runtimeEnv = resolveTelegramQaRuntimeEnv();
  const providerMode = normalizeQaProviderMode(params.providerMode ?? "mock-openai");
  const primaryModel = params.primaryModel?.trim() || defaultQaModelForMode(providerMode);
  const alternateModel = params.alternateModel?.trim() || defaultQaModelForMode(providerMode, true);
  const sutAccountId = params.sutAccountId?.trim() || "sut";
  const scenarios = findScenario(params.scenarioIds);
  const observedMessages: TelegramObservedMessage[] = [];
  const startedAt = new Date().toISOString();

  const driverIdentity = await getBotIdentity(runtimeEnv.driverToken);
  const sutIdentity = await getBotIdentity(runtimeEnv.sutToken);
  const sutUsername = sutIdentity.username?.trim();
  const uniqueIds = new Set([driverIdentity.id, sutIdentity.id]);
  if (uniqueIds.size !== 2) {
    throw new Error("Telegram QA requires two distinct bots for driver and SUT.");
  }
  if (!sutUsername) {
    throw new Error("Telegram QA requires the SUT bot to have a Telegram username.");
  }

  await Promise.all([
    flushTelegramUpdates(runtimeEnv.driverToken),
    flushTelegramUpdates(runtimeEnv.sutToken),
  ]);

  const gateway = await startQaGatewayChild({
    repoRoot,
    qaBusBaseUrl: "http://127.0.0.1:43123",
    providerMode,
    primaryModel,
    alternateModel,
    fastMode: params.fastMode,
    controlUiEnabled: false,
    mutateConfig: (cfg) =>
      buildTelegramQaConfig(cfg, {
        groupId: runtimeEnv.groupId,
        sutToken: runtimeEnv.sutToken,
        driverBotId: driverIdentity.id,
        sutAccountId,
      }),
  });

  const scenarioResults: TelegramQaScenarioResult[] = [];
  try {
    await waitForTelegramChannelRunning(gateway, sutAccountId);
    try {
      await runCanary({
        driverToken: runtimeEnv.driverToken,
        groupId: runtimeEnv.groupId,
        sutUsername,
        driverBotId: driverIdentity.id,
        sutBotId: sutIdentity.id,
        observedMessages,
      });
    } catch (error) {
      throw new Error(canaryFailureMessage(error), { cause: error });
    }

    let driverOffset = await flushTelegramUpdates(runtimeEnv.driverToken);
    for (const scenario of scenarios) {
      try {
        const sent = await sendGroupMessage(
          runtimeEnv.driverToken,
          runtimeEnv.groupId,
          scenario.buildInput(sutUsername),
        );
        const matched = await waitForObservedMessage({
          token: runtimeEnv.driverToken,
          initialOffset: driverOffset,
          timeoutMs: scenario.timeoutMs,
          observedMessages,
          predicate: (message) =>
            message.chatId === Number(runtimeEnv.groupId) &&
            message.senderId === sutIdentity.id &&
            message.replyToMessageId === sent.message_id &&
            message.text.trim().length > 0,
        });
        driverOffset = matched.nextOffset;
        scenarioResults.push({
          id: scenario.id,
          title: scenario.title,
          status: "pass",
          details: `reply message ${matched.message.messageId} matched`,
        });
      } catch (error) {
        scenarioResults.push({
          id: scenario.id,
          title: scenario.title,
          status: "fail",
          details: formatErrorMessage(error),
        });
      }
    }
  } finally {
    await gateway.stop();
  }

  const finishedAt = new Date().toISOString();
  const summary: TelegramQaSummary = {
    groupId: runtimeEnv.groupId,
    startedAt,
    finishedAt,
    counts: {
      total: scenarioResults.length,
      passed: scenarioResults.filter((entry) => entry.status === "pass").length,
      failed: scenarioResults.filter((entry) => entry.status === "fail").length,
    },
    scenarios: scenarioResults,
  };
  const reportPath = path.join(outputDir, "telegram-qa-report.md");
  const summaryPath = path.join(outputDir, "telegram-qa-summary.json");
  const observedMessagesPath = path.join(outputDir, "telegram-qa-observed-messages.json");
  await fs.writeFile(
    reportPath,
    `${renderTelegramQaMarkdown({
      groupId: runtimeEnv.groupId,
      startedAt,
      finishedAt,
      scenarios: scenarioResults,
    })}\n`,
    "utf8",
  );
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await fs.writeFile(
    observedMessagesPath,
    `${JSON.stringify(observedMessages, null, 2)}\n`,
    "utf8",
  );

  return {
    outputDir,
    reportPath,
    summaryPath,
    observedMessagesPath,
    scenarios: scenarioResults,
  };
}

export const __testing = {
  TELEGRAM_QA_SCENARIOS,
  buildTelegramQaConfig,
  normalizeTelegramObservedMessage,
  resolveTelegramQaRuntimeEnv,
};
