const TELEGRAM_NATIVE_COMMAND_CALLBACK_PREFIX = "tgcmd:";
const TELEGRAM_OPAQUE_CALLBACK_PREFIX = "tgcb1:";
// Typed callbacks sent with message(action=send). A tap that no plugin handler
// claims reaches the agent as callback data instead of expiring.
const TELEGRAM_AGENT_CALLBACK_PREFIX = "tgac1:";

/** Who receives a typed callback tap that no plugin interactive handler claims. */
export type TelegramTypedCallbackOwner = "plugin" | "agent";

export function buildTelegramNativeCommandCallbackData(commandText: string): string {
  return `${TELEGRAM_NATIVE_COMMAND_CALLBACK_PREFIX}${commandText}`;
}

export function parseTelegramNativeCommandCallbackData(data?: string | null): string | null {
  const trimmed = data?.trim();
  if (!trimmed?.startsWith(TELEGRAM_NATIVE_COMMAND_CALLBACK_PREFIX)) {
    return null;
  }
  const commandText = trimmed.slice(TELEGRAM_NATIVE_COMMAND_CALLBACK_PREFIX.length).trim();
  return commandText.startsWith("/") ? commandText : null;
}

export function buildTelegramOpaqueCallbackData(
  value: string,
  owner: TelegramTypedCallbackOwner = "plugin",
): string {
  const prefix =
    owner === "agent" ? TELEGRAM_AGENT_CALLBACK_PREFIX : TELEGRAM_OPAQUE_CALLBACK_PREFIX;
  return `${prefix}${checksumTelegramOpaqueCallbackValue(value)}:${value}`;
}

export function hasTelegramOpaqueCallbackPrefix(data?: string | null): boolean {
  return data?.startsWith(TELEGRAM_OPAQUE_CALLBACK_PREFIX) === true;
}

export function hasTelegramAgentCallbackPrefix(data?: string | null): boolean {
  return data?.startsWith(TELEGRAM_AGENT_CALLBACK_PREFIX) === true;
}

export function parseTelegramOpaqueCallbackData(data?: string | null): string | null {
  return parseTelegramTypedCallbackEnvelope(TELEGRAM_OPAQUE_CALLBACK_PREFIX, data);
}

export function parseTelegramAgentCallbackData(data?: string | null): string | null {
  return parseTelegramTypedCallbackEnvelope(TELEGRAM_AGENT_CALLBACK_PREFIX, data);
}

function parseTelegramTypedCallbackEnvelope(prefix: string, data?: string | null): string | null {
  if (!data?.startsWith(prefix)) {
    return null;
  }
  const encoded = data.slice(prefix.length);
  const separatorIndex = encoded.indexOf(":");
  const value = encoded.slice(separatorIndex + 1);
  return separatorIndex > 0 &&
    value &&
    encoded.slice(0, separatorIndex) === checksumTelegramOpaqueCallbackValue(value)
    ? value
    : null;
}

function checksumTelegramOpaqueCallbackValue(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).slice(0, 5).padStart(5, "0");
}
