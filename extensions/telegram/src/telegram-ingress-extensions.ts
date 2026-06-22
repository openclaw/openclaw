import type { Bot } from "grammy";
import type { ChannelRuntimeSurface } from "openclaw/plugin-sdk/channel-contract";
// Telegram plugin module implements optional ingress extension hooks.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";

export type TelegramRawUpdateHandlerResult = "handled" | "continue" | undefined | void;

export type TelegramRawUpdateHandlerContext = {
  update: unknown;
  accountId: string;
  bot: Bot;
  runtime: RuntimeEnv;
  channelRuntime?: ChannelRuntimeSurface;
};

export type TelegramIngressExtension = {
  id: string;
  handleRawUpdate?: (
    context: TelegramRawUpdateHandlerContext,
  ) => TelegramRawUpdateHandlerResult | Promise<TelegramRawUpdateHandlerResult>;
};

const telegramIngressExtensions = new Set<TelegramIngressExtension>();

export function registerTelegramIngressExtension(extension: TelegramIngressExtension): () => void {
  telegramIngressExtensions.add(extension);
  return () => {
    telegramIngressExtensions.delete(extension);
  };
}

export async function handleTelegramIngressExtensionRawUpdate(
  context: TelegramRawUpdateHandlerContext,
): Promise<boolean> {
  for (const extension of telegramIngressExtensions) {
    if (!extension.handleRawUpdate) {
      continue;
    }
    try {
      const result = await extension.handleRawUpdate(context);
      if (result === "handled") {
        return true;
      }
    } catch (err) {
      context.runtime.error?.(
        `[telegram] ingress extension "${extension.id}" failed: ${formatErrorMessage(err)}`,
      );
    }
  }
  return false;
}

export function resetTelegramIngressExtensionsForTests(): void {
  telegramIngressExtensions.clear();
}
