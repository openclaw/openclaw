// Channel Message Flows runtime supports QA Lab channel delivery evidence.
import { setTimeout as sleep } from "node:timers/promises";
import type { Bot } from "grammy";
import type { Message } from "grammy/types";
import { formatReasoningMessage } from "openclaw/plugin-sdk/agent-runtime";
import { formatChannelProgressDraftText } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { TelegramThreadSpec } from "../bot/helpers.js";
import { createTelegramDraftStream, type TelegramDraftStream } from "../draft-stream.js";
import {
  buildTelegramRichMarkdown,
  type TelegramEditRichMessageTextParams,
  type TelegramInputRichMessage,
  type TelegramSendRichMessageParams,
} from "../rich-message.js";
import { deleteMessageTelegram, editMessageTelegram, sendMessageTelegram } from "../send.js";

type TelegramApi = Bot["api"];
type TelegramSendMessageParams = Parameters<TelegramApi["sendMessage"]>;
type TelegramEditMessageTextParams = Parameters<TelegramApi["editMessageText"]>;
type TelegramDeleteMessageParams = Parameters<TelegramApi["deleteMessage"]>;

type SupportedFlow = "thinking-final" | "working-final";

type TelegramSendFinalParams = {
  accountId?: string;
  cfg: OpenClawConfig;
  target: string;
  text: string;
  threadId?: number;
};

type TelegramFlowResult = {
  finalMessageId?: string;
  previewUpdates: number;
};

type TelegramFlowDeps = {
  createDraftStream?: (params: {
    accountId?: string;
    cfg: OpenClawConfig;
    target: string;
    threadId?: number;
  }) => TelegramDraftStream;
  sendFinal?: (params: TelegramSendFinalParams) => Promise<{ messageId?: string }>;
  sleep?: (ms: number) => Promise<void>;
};

export type TelegramThinkingFinalFlowOptions = {
  accountId?: string;
  cfg: OpenClawConfig;
  delayMs?: number;
  finalText?: string;
  target: string;
  threadId?: number;
  thinkingUpdates?: readonly string[];
};

export type TelegramWorkingFinalFlowOptions = TelegramThinkingFinalFlowOptions & {
  durationMs?: number;
};

const DEFAULT_THINKING_FINAL_UPDATES = [
  "I'll inspect the Telegram stream surface first.",
  "I found the reasoning preview path and I’m checking final delivery.",
  "The preview should clear before the durable final answer lands.",
] as const;

const DEFAULT_THINKING_FINAL_TEXT =
  "Final answer: the Telegram thinking preview cleared and this durable reply landed.";
const DEFAULT_WORKING_FINAL_TEXT =
  "Final answer: the Telegram working preview cleared and this durable reply landed.";
const DEFAULT_WORKING_PROGRESS_TIMELINE = [
  {
    atMs: 2_000,
    line: "🛠️ pgrep -fl Discord || true (agent)",
  },
  {
    atMs: 5_000,
    line: "🛠️ list files in /Applications/Discord.app -> run true (agent)",
  },
  {
    atMs: 7_000,
    line: "🛠️ sw_vers (agent)",
  },
  {
    atMs: 8_000,
    line: "Discord is installed as a normal '/Applications/Discord.app', not as a Homebrew-managed cask, and it's currently running.",
  },
  {
    atMs: 11_000,
    line: "🛠️ osascript -e 'tell application \"Discord\" to quit' || true sleep 3 pgrep -fl Discord || true (agent)",
  },
  {
    atMs: 14_000,
    line: "🛠️ brew install --cask --force discord (agent)",
  },
  {
    atMs: 17_000,
    line: "Homebrew found Discord as an outdated cask after updating its metadata, so this is doing a real cask reinstall.",
  },
] as const;

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function requireFinalMessageId(final: { messageId?: string }, flow: SupportedFlow): string {
  const messageId = final.messageId?.trim();
  if (!messageId) {
    throw new Error(`${flow} final send did not return a durable Telegram message id`);
  }
  return messageId;
}

function resolveWorkingProgressLines(elapsedMs: number): string[] {
  return DEFAULT_WORKING_PROGRESS_TIMELINE.filter((entry) => entry.atMs <= elapsedMs).map(
    (entry) => entry.line,
  );
}

function formatWorkingProgressPreview(elapsedMs: number): string {
  return formatChannelProgressDraftText({
    entry: { streaming: { progress: { label: "Working", toolProgress: false } } },
    lines: resolveWorkingProgressLines(elapsedMs),
  });
}

function richMessageText(richMessage: TelegramInputRichMessage): {
  text: string;
  textMode: "markdown" | "html";
} {
  return richMessage.html !== undefined
    ? { text: richMessage.html, textMode: "html" }
    : { text: richMessage.markdown, textMode: "markdown" };
}

function createTelegramFlowApi(params: { accountId?: string; cfg: OpenClawConfig }): Bot["api"] {
  const api = {
    raw: {
      sendRichMessage: async (sendParams: TelegramSendRichMessageParams) => {
        const richText = richMessageText(sendParams.rich_message);
        const result = await sendMessageTelegram(String(sendParams.chat_id), richText.text, {
          accountId: params.accountId,
          cfg: params.cfg,
          messageThreadId: sendParams.message_thread_id,
          textMode: richText.textMode,
        });
        return { message_id: Number(result.messageId) } as Message;
      },
      editMessageText: async (editParams: TelegramEditRichMessageTextParams) => {
        if (typeof editParams.message_id !== "number") {
          throw new Error("Telegram flow rich edit requires message_id.");
        }
        const richText = richMessageText(editParams.rich_message);
        await editMessageTelegram(
          String(editParams.chat_id),
          editParams.message_id,
          richText.text,
          {
            accountId: params.accountId,
            cfg: params.cfg,
            textMode: richText.textMode,
          },
        );
        return true;
      },
    },
    sendMessage: async (
      chatId: TelegramSendMessageParams[0],
      text: TelegramSendMessageParams[1],
      sendParams: TelegramSendMessageParams[2],
    ) => {
      const result = await sendMessageTelegram(String(chatId), text, {
        accountId: params.accountId,
        cfg: params.cfg,
        messageThreadId: sendParams?.message_thread_id,
        textMode: sendParams?.parse_mode === "HTML" ? "html" : "markdown",
      });
      return { message_id: Number(result.messageId) };
    },
    editMessageText: async (
      chatId: TelegramEditMessageTextParams[0],
      messageId: TelegramEditMessageTextParams[1],
      text: TelegramEditMessageTextParams[2],
      editParams: TelegramEditMessageTextParams[3],
    ) => {
      await editMessageTelegram(String(chatId), messageId, text, {
        accountId: params.accountId,
        cfg: params.cfg,
        textMode: editParams?.parse_mode === "HTML" ? "html" : "markdown",
      });
      return true;
    },
    deleteMessage: async (
      chatId: TelegramDeleteMessageParams[0],
      messageId: TelegramDeleteMessageParams[1],
    ) => {
      await deleteMessageTelegram(String(chatId), messageId, {
        accountId: params.accountId,
        cfg: params.cfg,
      });
      return true;
    },
  };
  return api as unknown as Bot["api"];
}

export function resolveTelegramFlowThreadSpec(threadId?: number): TelegramThreadSpec | undefined {
  return typeof threadId === "number" ? { id: threadId, scope: "forum" } : undefined;
}

function createDefaultTelegramDraftStream(params: {
  accountId?: string;
  cfg: OpenClawConfig;
  target: string;
  threadId?: number;
}): TelegramDraftStream {
  return createTelegramDraftStream({
    api: createTelegramFlowApi(params),
    chatId: params.target,
    minInitialChars: 0,
    renderText: (text) => ({ text, richMessage: buildTelegramRichMarkdown(text) }),
    thread: resolveTelegramFlowThreadSpec(params.threadId),
    throttleMs: 250,
  });
}

async function sendTelegramFinal(params: TelegramSendFinalParams): Promise<{ messageId?: string }> {
  return await sendMessageTelegram(params.target, params.text, {
    accountId: params.accountId,
    cfg: params.cfg,
    messageThreadId: params.threadId,
  });
}

export async function runTelegramThinkingFinalFlow(
  options: TelegramThinkingFinalFlowOptions,
  deps: TelegramFlowDeps = {},
): Promise<TelegramFlowResult> {
  const delayMs = options.delayMs ?? 900;
  const thinkingUpdates = options.thinkingUpdates ?? DEFAULT_THINKING_FINAL_UPDATES;
  const stream = (deps.createDraftStream ?? createDefaultTelegramDraftStream)({
    accountId: options.accountId,
    cfg: options.cfg,
    target: options.target,
    threadId: options.threadId,
  });
  const wait = deps.sleep ?? sleep;

  let previewStarted = false;
  let flowError: unknown;
  try {
    for (const update of thinkingUpdates) {
      previewStarted = true;
      stream.update(formatReasoningMessage(update));
      await stream.flush();
      if (delayMs > 0) {
        await wait(delayMs);
      }
    }
  } catch (error) {
    flowError = error;
  }
  let cleanupError: unknown;
  if (previewStarted) {
    try {
      await stream.clear();
    } catch (error) {
      cleanupError = error;
    }
  }
  if (flowError) {
    throw toError(flowError);
  }
  if (cleanupError) {
    throw toError(cleanupError);
  }

  const final = await (deps.sendFinal ?? sendTelegramFinal)({
    accountId: options.accountId,
    cfg: options.cfg,
    target: options.target,
    text: options.finalText ?? DEFAULT_THINKING_FINAL_TEXT,
    threadId: options.threadId,
  });

  const finalMessageId = requireFinalMessageId(final, "thinking-final");
  return {
    finalMessageId,
    previewUpdates: thinkingUpdates.length,
  };
}

export async function runTelegramWorkingFinalFlow(
  options: TelegramWorkingFinalFlowOptions,
  deps: TelegramFlowDeps = {},
): Promise<TelegramFlowResult> {
  const delayMs = options.delayMs ?? 2_000;
  const durationMs = options.durationMs ?? 12_000;
  const stream = (deps.createDraftStream ?? createDefaultTelegramDraftStream)({
    accountId: options.accountId,
    cfg: options.cfg,
    target: options.target,
    threadId: options.threadId,
  });
  const wait = deps.sleep ?? sleep;

  let previewUpdates = 0;
  let lastPreviewText = "";
  const updateIntervalMs = delayMs > 0 ? delayMs : 1_000;
  let draftStarted = false;
  let flowError: unknown;
  try {
    for (let elapsedMs = 0; elapsedMs < durationMs; elapsedMs += updateIntervalMs) {
      const previewText = formatWorkingProgressPreview(elapsedMs);
      if (previewText !== lastPreviewText) {
        draftStarted = true;
        stream.update(previewText);
        await stream.flush();
        lastPreviewText = previewText;
        previewUpdates += 1;
      }
      if (delayMs > 0 && elapsedMs + updateIntervalMs < durationMs) {
        await wait(delayMs);
      }
    }
  } catch (error) {
    flowError = error;
  }
  let cleanupError: unknown;
  if (draftStarted) {
    try {
      await stream.clear();
    } catch (error) {
      cleanupError = error;
    }
  }
  if (flowError) {
    throw toError(flowError);
  }
  if (cleanupError) {
    throw toError(cleanupError);
  }

  const final = await (deps.sendFinal ?? sendTelegramFinal)({
    accountId: options.accountId,
    cfg: options.cfg,
    target: options.target,
    text: options.finalText ?? DEFAULT_WORKING_FINAL_TEXT,
    threadId: options.threadId,
  });

  const finalMessageId = requireFinalMessageId(final, "working-final");
  return {
    finalMessageId,
    previewUpdates,
  };
}
