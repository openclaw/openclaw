import type { Bot } from "grammy";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { buildTelegramThreadParams, type TelegramThreadSpec } from "./bot/helpers.js";
import {
  allocateTelegramDraftId,
  normalizeDraftText,
  resolveSendMessageDraftApi,
} from "./native-draft-api.js";

export type NativeTelegramToolProgressDraft = {
  update: (text: string) => Promise<boolean>;
  stop: () => void;
};

export function createNativeTelegramToolProgressDraft(params: {
  api: Bot["api"];
  chatId: Parameters<Bot["api"]["sendMessage"]>[0];
  thread?: TelegramThreadSpec | null;
  log?: (message: string) => void;
}): NativeTelegramToolProgressDraft | undefined {
  const sendMessageDraft = resolveSendMessageDraftApi(params.api);
  if (!sendMessageDraft) {
    return undefined;
  }

  const draftId = allocateTelegramDraftId();
  const threadParams = buildTelegramThreadParams(params.thread) ?? {};
  let stopped = false;
  let lastSentText: string | undefined;

  return {
    update: async (text: string): Promise<boolean> => {
      if (stopped) {
        return false;
      }
      const normalizedText = normalizeDraftText(text);
      if (!normalizedText) {
        return false;
      }
      if (normalizedText === lastSentText) {
        return true;
      }
      try {
        await sendMessageDraft(
          params.chatId,
          draftId,
          normalizedText,
          Object.keys(threadParams).length > 0 ? threadParams : undefined,
        );
        lastSentText = normalizedText;
        return true;
      } catch (err) {
        stopped = true;
        params.log?.(`telegram native tool-progress draft disabled: ${formatErrorMessage(err)}`);
        return false;
      }
    },
    stop: () => {
      stopped = true;
    },
  };
}
