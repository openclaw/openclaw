const TELEGRAM_NUMERIC_CHAT_ID_REGEX = /^-?\d+$/;
const TELEGRAM_USERNAME_REGEX = /^[A-Za-z0-9_]{5,}$/i;
function stripTelegramInternalPrefixes(to) {
  let trimmed = to.trim();
  let strippedTelegramPrefix = false;
  while (true) {
    const next = (() => {
      if (/^(telegram|tg):/i.test(trimmed)) {
        strippedTelegramPrefix = true;
        return trimmed.replace(/^(telegram|tg):/i, "").trim();
      }
      if (strippedTelegramPrefix && /^group:/i.test(trimmed)) {
        return trimmed.replace(/^group:/i, "").trim();
      }
      return trimmed;
    })();
    if (next === trimmed) {
      return trimmed;
    }
    trimmed = next;
  }
}
function normalizeTelegramChatId(raw) {
  const stripped = stripTelegramInternalPrefixes(raw);
  if (!stripped) {
    return void 0;
  }
  if (TELEGRAM_NUMERIC_CHAT_ID_REGEX.test(stripped)) {
    return stripped;
  }
  return void 0;
}
function isNumericTelegramChatId(raw) {
  return TELEGRAM_NUMERIC_CHAT_ID_REGEX.test(raw.trim());
}
function normalizeTelegramLookupTarget(raw) {
  const stripped = stripTelegramInternalPrefixes(raw);
  if (!stripped) {
    return void 0;
  }
  if (isNumericTelegramChatId(stripped)) {
    return stripped;
  }
  const tmeMatch = /^(?:https?:\/\/)?t\.me\/([A-Za-z0-9_]+)$/i.exec(stripped);
  if (tmeMatch?.[1]) {
    return `@${tmeMatch[1]}`;
  }
  if (stripped.startsWith("@")) {
    const handle = stripped.slice(1);
    if (!handle || !TELEGRAM_USERNAME_REGEX.test(handle)) {
      return void 0;
    }
    return `@${handle}`;
  }
  if (TELEGRAM_USERNAME_REGEX.test(stripped)) {
    return `@${stripped}`;
  }
  return void 0;
}
function resolveTelegramChatType(chatId) {
  const trimmed = chatId.trim();
  if (!trimmed) {
    return "unknown";
  }
  if (isNumericTelegramChatId(trimmed)) {
    return trimmed.startsWith("-") ? "group" : "direct";
  }
  return "unknown";
}
function parseTelegramTarget(to) {
  const normalized = stripTelegramInternalPrefixes(to);
  const topicMatch = /^(.+?):topic:(\d+)$/.exec(normalized);
  if (topicMatch) {
    return {
      chatId: topicMatch[1],
      messageThreadId: Number.parseInt(topicMatch[2], 10),
      chatType: resolveTelegramChatType(topicMatch[1])
    };
  }
  const colonMatch = /^(.+):(\d+)$/.exec(normalized);
  if (colonMatch) {
    return {
      chatId: colonMatch[1],
      messageThreadId: Number.parseInt(colonMatch[2], 10),
      chatType: resolveTelegramChatType(colonMatch[1])
    };
  }
  return {
    chatId: normalized,
    chatType: resolveTelegramChatType(normalized)
  };
}
function resolveTelegramTargetChatType(target) {
  return parseTelegramTarget(target).chatType;
}
export {
  isNumericTelegramChatId,
  normalizeTelegramChatId,
  normalizeTelegramLookupTarget,
  parseTelegramTarget,
  resolveTelegramTargetChatType,
  stripTelegramInternalPrefixes
};
