---
summary: "아웃바운드 provider 호출에 대한 재시도 정책"
read_when:
  - Provider retry 동작 또는 기본값을 업데이트할 때
  - Provider send 오류 또는 rate limits을 디버깅할 때
title: "재시도 정책"
---

# 재시도 정책

## 목표

- HTTP request당 재시도, multi-step flow당 아님.
- 현재 step만 재시도하여 순서를 보존합니다.
- non-idempotent 작업 중복을 피합니다.

## 기본값

- 시도: 3
- Max delay cap: 30000 ms
- Jitter: 0.1 (10 percent)
- Provider 기본값:
  - Telegram min delay: 400 ms
  - Discord min delay: 500 ms

## 동작

### Discord

- Rate-limit 오류 (HTTP 429)에서만 재시도합니다.
- 사용 가능한 경우 Discord `retry_after`를 사용하고, 그렇지 않으면 exponential backoff를 사용합니다.

### Telegram

- Transient 오류 (429, timeout, connect/reset/closed, temporarily unavailable)에서 재시도합니다.
- 사용 가능한 경우 `retry_after`를 사용하고, 그렇지 않으면 exponential backoff를 사용합니다.
- Markdown parse 오류는 재시도되지 않습니다; plain text로 fallback합니다.

## 설정

`~/.openclaw/openclaw.json`에서 provider별 재시도 정책을 설정합니다:

```json5
{
  channels: {
    telegram: {
      retry: {
        attempts: 3,
        minDelayMs: 400,
        maxDelayMs: 30000,
        jitter: 0.1,
      },
    },
    discord: {
      retry: {
        attempts: 3,
        minDelayMs: 500,
        maxDelayMs: 30000,
        jitter: 0.1,
      },
    },
  },
}
```

## 노트

- 재시도는 per request (message send, media upload, reaction, poll, sticker)에 적용됩니다.
- Composite flows는 완료된 steps를 재시도하지 않습니다.
