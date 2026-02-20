export function normalizeDeltaChatMessagingTarget(raw: string): string | undefined {
  let normalized = raw.trim();
  if (!normalized) {
    return undefined;
  }
  const lowered = normalized.toLowerCase();
  if (lowered.startsWith("deltachat:")) {
    normalized = normalized.slice("deltachat:".length).trim();
  }
  const stripped = normalized.replace(/^(user|email):/i, "").trim();
  return stripped || undefined;
}

export function looksLikeDeltaChatTargetId(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }
  // Delta.Chat uses email addresses as identifiers
  if (/^[^@]+@[^@]+\.[^@]+$/.test(trimmed)) {
    return true;
  }
  // Or chat IDs (numeric)
  if (/^\d+$/.test(trimmed)) {
    return true;
  }
  return false;
}

export function parseDeltaChatTarget(raw: string): { kind: "email" | "chat_id"; to: string } {
  const trimmed = raw.trim();
  const lowered = trimmed.toLowerCase();

  if (lowered.startsWith("deltachat:")) {
    const content = trimmed.slice("deltachat:".length).trim();
    return parseDeltaChatTarget(content);
  }

  if (lowered.startsWith("email:")) {
    const email = trimmed.slice("email:".length).trim();
    return { kind: "email", to: email };
  }

  if (lowered.startsWith("chat_id:")) {
    const chatId = trimmed.slice("chat_id:".length).trim();
    return { kind: "chat_id", to: chatId };
  }

  // Handle group: prefix - group IDs are chat IDs
  if (lowered.startsWith("group:")) {
    const chatId = trimmed.slice("group:".length).trim();
    return { kind: "chat_id", to: chatId };
  }

  // Check if it's an email address
  if (/^[^@]+@[^@]+\.[^@]+$/.test(trimmed)) {
    return { kind: "email", to: trimmed };
  }

  // Check if it's a numeric chat ID
  if (/^\d+$/.test(trimmed)) {
    return { kind: "chat_id", to: trimmed };
  }

  // Default to email
  return { kind: "email", to: trimmed };
}

export function normalizeDeltaChatHandle(handle: string): string {
  return handle
    .replace(/^deltachat:/i, "")
    .replace(/^email:/i, "")
    .replace(/^group:/i, "")
    .trim()
    .toLowerCase();
}

export function isAllowedDeltaChatSender(sender: string, allowFrom: string[]): boolean {
  const normalizedSender = normalizeDeltaChatHandle(sender);
  return allowFrom.some((entry) => {
    const normalizedEntry = normalizeDeltaChatHandle(String(entry));
    return normalizedEntry === normalizedSender || normalizedEntry === "*";
  });
}
