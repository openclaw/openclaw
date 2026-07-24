// Telegram message context helpers for direct audio typing preflight.
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import type { BuildTelegramMessageContextParams } from "./bot-message-context.types.js";
import { getTelegramTextParts } from "./bot/body-helpers.js";

const DIRECT_AUDIO_TYPING_PREFLIGHT_TIMEOUT_MS = 100;

type TelegramMessage = BuildTelegramMessageContextParams["primaryCtx"]["message"];

export async function waitForDirectAudioTypingPreflight(
  sendTypingPromise: Promise<void>,
  params: { chatId: TelegramMessage["chat"]["id"] },
): Promise<void> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const guardedSendTypingPromise = sendTypingPromise.then(
    () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    },
    (err: unknown) => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      throw err;
    },
  );
  const timeoutPromise = new Promise<void>((resolve) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      resolve();
    }, DIRECT_AUDIO_TYPING_PREFLIGHT_TIMEOUT_MS);
  });

  try {
    await Promise.race([guardedSendTypingPromise, timeoutPromise]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }

  if (timedOut) {
    void guardedSendTypingPromise.catch((err: unknown) => {
      logVerbose(
        `telegram audio preflight direct typing cue failed for chat ${params.chatId}: ${String(err)}`,
      );
    });
  }
}

export function shouldSendDirectAudioTypingBeforeBodyResolution(params: {
  msg: TelegramMessage;
  allMedia: BuildTelegramMessageContextParams["allMedia"];
  isGroup: boolean;
}): boolean {
  return (
    !params.isGroup &&
    !getTelegramTextParts(params.msg).text.trim() &&
    params.allMedia.some((media) => media.contentType?.startsWith("audio/"))
  );
}
