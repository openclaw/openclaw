export function stripNextcloudTalkTargetPrefix(raw: string): string | undefined {
  return (
    raw
      .trim()
      .replace(/^(nextcloud-talk|nc-talk|nc):/i, "")
      .trim()
      .replace(/^room:/i, "")
      .trim() || undefined
  );
}

export function normalizeNextcloudTalkMessagingTarget(raw: string): string | undefined {
  const normalized = stripNextcloudTalkTargetPrefix(raw);
  return normalized ? `nextcloud-talk:${normalized}`.toLowerCase() : undefined;
}

export function looksLikeNextcloudTalkTargetId(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }

  if (/^(nextcloud-talk|nc-talk|nc|room):/i.test(trimmed)) {
    return true;
  }

  return /^[a-z0-9]{8,}$/i.test(trimmed);
}
