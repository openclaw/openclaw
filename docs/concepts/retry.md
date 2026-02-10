---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Retry policy for outbound provider calls"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Updating provider retry behavior or defaults（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Debugging provider send errors or rate limits（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Retry Policy"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Retry policy（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Goals（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Retry per HTTP request, not per multi-step flow.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Preserve ordering by retrying only the current step.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Avoid duplicating non-idempotent operations.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Defaults（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Attempts: 3（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Max delay cap: 30000 ms（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Jitter: 0.1 (10 percent)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Provider defaults:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Telegram min delay: 400 ms（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Discord min delay: 500 ms（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Behavior（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Discord（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Retries only on rate-limit errors (HTTP 429).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Uses Discord `retry_after` when available, otherwise exponential backoff.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Telegram（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Retries on transient errors (429, timeout, connect/reset/closed, temporarily unavailable).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Uses `retry_after` when available, otherwise exponential backoff.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Markdown parse errors are not retried; they fall back to plain text.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Configuration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Set retry policy per provider in `~/.openclaw/openclaw.json`:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```json5（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
{（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  channels: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    telegram: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      retry: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        attempts: 3,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        minDelayMs: 400,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        maxDelayMs: 30000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        jitter: 0.1,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    discord: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      retry: {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        attempts: 3,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        minDelayMs: 500,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        maxDelayMs: 30000,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        jitter: 0.1,（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
}（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Retries apply per request (message send, media upload, reaction, poll, sticker).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Composite flows do not retry completed steps.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
