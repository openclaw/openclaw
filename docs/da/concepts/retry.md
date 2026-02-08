---
summary: "Retry-politik for udgående udbyderkald"
read_when:
  - Opdatering af udbyderes retry-adfærd eller standarder
  - Fejlfinding af fejl ved afsendelse hos udbydere eller rate limits
title: "Retry-politik"
x-i18n:
  source_path: concepts/retry.md
  source_hash: 55bb261ff567f46c
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:05Z
---

# Retry-politik

## Mål

- Retry pr. HTTP-forespørgsel, ikke pr. flertrinsflow.
- Bevar rækkefølgen ved kun at retry det aktuelle trin.
- Undgå at duplikere ikke-idempotente operationer.

## Standarder

- Forsøg: 3
- Maks. forsinkelsesloft: 30000 ms
- Jitter: 0,1 (10 procent)
- Udbyderstandarder:
  - Telegram min. forsinkelse: 400 ms
  - Discord min. forsinkelse: 500 ms

## Adfærd

### Discord

- Retry kun ved rate-limit-fejl (HTTP 429).
- Bruger `retry_after` når tilgængelig, ellers eksponentiel backoff.

### Telegram

- Retry ved forbigående fejl (429, timeout, connect/reset/closed, midlertidigt utilgængelig).
- Bruger `retry_after` når tilgængelig, ellers eksponentiel backoff.
- Markdown-parsefejl retries ikke; de falder tilbage til ren tekst.

## Konfiguration

Indstil retry-politik pr. udbyder i `~/.openclaw/openclaw.json`:

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

## Noter

- Retry gælder pr. forespørgsel (afsendelse af besked, medieupload, reaktion, afstemning, sticker).
- Sammensatte flows retryer ikke gennemførte trin.
