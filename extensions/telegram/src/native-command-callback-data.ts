const TELEGRAM_NATIVE_COMMAND_CALLBACK_PREFIX = "tgcmd:";

export function buildTelegramNativeCommandCallbackData(commandText: string): string {
  return `${TELEGRAM_NATIVE_COMMAND_CALLBACK_PREFIX}${commandText}`;
}

export function parseTelegramNativeCommandCallbackData(data?: string | null): string | null {
  if (!data) {
    return null;
  }
  const trimmed = data.trim();
  if (!trimmed.startsWith(TELEGRAM_NATIVE_COMMAND_CALLBACK_PREFIX)) {
    return null;
  }
  const commandText = trimmed.slice(TELEGRAM_NATIVE_COMMAND_CALLBACK_PREFIX.length).trim();
  return commandText.startsWith("/") ? commandText : null;
}
