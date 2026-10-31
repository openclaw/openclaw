import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";

export const SYSTEM_UPDATE_MESSAGE_CUSTOM_TYPE = "openclaw.system-update";

/** The same kind survives raw messages, transcript entries, and bounded navigation. */
export function getOpenClawSystemUpdateKind(value: unknown) {
  const entry = asOptionalRecord(value);
  const message = entry?.type === "message" ? asOptionalRecord(entry.message) : entry;
  if (
    !message ||
    (message.role !== "custom" && message.type !== "custom_message") ||
    message.customType !== SYSTEM_UPDATE_MESSAGE_CUSTOM_TYPE
  ) {
    return undefined;
  }
  const kind = asOptionalRecord(message.details)?.kind;
  return kind === "prompt-update" || kind === "runtime-context" ? kind : undefined;
}

export function isOpenClawSystemUpdateMessage(message: {
  role: string;
  customType?: string;
}): boolean {
  return message.role === "custom" && message.customType === SYSTEM_UPDATE_MESSAGE_CUSTOM_TYPE;
}

/** Order only a newly admitted batch; previously sent operator positions are immutable. */
export function orderSystemUpdateMessages<T extends { role: string; customType?: string }>(
  messages: T[],
): T[] {
  if (!messages.some(isOpenClawSystemUpdateMessage)) {
    return messages;
  }
  return [
    ...messages.filter((message) => !isOpenClawSystemUpdateMessage(message)),
    ...messages.filter(isOpenClawSystemUpdateMessage),
  ];
}
