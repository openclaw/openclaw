// Telegram plugin module owns the lazy send runtime import.
export type TelegramSendModule = typeof import("./send.js");

let telegramSendModulePromise: Promise<TelegramSendModule> | undefined;

export async function loadTelegramSendModule(): Promise<TelegramSendModule> {
  telegramSendModulePromise ??= import("./send.js");
  return await telegramSendModulePromise;
}
