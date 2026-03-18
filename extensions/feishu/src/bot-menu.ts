import { findCommandByNativeName, normalizeCommandBody } from "openclaw/plugin-sdk/reply-runtime";

const FEISHU_MENU_COMMAND_PREFIXES = ["command:", "cmd:", "slash:", "oc:"] as const;

function normalizeRawBotMenuCommand(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const normalized = normalizeCommandBody(withSlash).trim();
  return normalized.startsWith("/") ? normalized : null;
}

export function resolveFeishuBotMenuCommand(eventKey: string): string | null {
  const trimmed = eventKey.trim();
  if (!trimmed) {
    return null;
  }

  const lowered = trimmed.toLowerCase();
  for (const prefix of FEISHU_MENU_COMMAND_PREFIXES) {
    if (!lowered.startsWith(prefix)) {
      continue;
    }
    return normalizeRawBotMenuCommand(trimmed.slice(prefix.length));
  }

  if (trimmed.startsWith("/")) {
    return normalizeRawBotMenuCommand(trimmed);
  }

  const tokenMatch = trimmed.match(/^([^\s]+)(?:\s+([\s\S]+))?$/);
  if (!tokenMatch) {
    return null;
  }
  const [, token, rest] = tokenMatch;
  const command = findCommandByNativeName(token, "feishu");
  if (!command) {
    return null;
  }

  const primaryAlias = command.textAliases[0]?.trim();
  if (!primaryAlias?.startsWith("/")) {
    return null;
  }
  const normalizedRest = rest?.trimStart();
  return normalizedRest ? `${primaryAlias} ${normalizedRest}` : primaryAlias;
}
