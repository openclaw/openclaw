// Match Telegram/Tlon/Mattermost inbound media and media-store downloads:
// header wait is independent of body idle. Keep every QQBot remote-media path
// on one policy so adapter + file-utils callers cannot drift.
export const QQBOT_MEDIA_FETCH_TIMEOUTS = {
  responseHeaderTimeoutMs: 120_000,
  readIdleTimeoutMs: 30_000,
} as const;
