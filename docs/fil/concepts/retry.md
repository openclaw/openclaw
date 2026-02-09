---
summary: "Patakaran sa retry para sa mga outbound na tawag sa provider"
read_when:
  - Ina-update ang retry behavior o mga default ng provider
  - Nagde-debug ng mga error sa pagpapadala ng provider o mga rate limit
title: "Patakaran sa Retry"
---

# Patakaran sa retry

## Mga layunin

- Mag-retry kada HTTP request, hindi kada multi-step na flow.
- Panatilihin ang pagkakasunod-sunod sa pamamagitan ng pag-retry lamang sa kasalukuyang hakbang.
- Iwasan ang pagdodoble ng mga non-idempotent na operasyon.

## Mga default

- Mga attempt: 3
- Max delay cap: 30000 ms
- Jitter: 0.1 (10 porsiyento)
- Mga default ng provider:
  - Telegram min delay: 400 ms
  - Discord min delay: 500 ms

## Behavior

### Discord

- Nagre-retry lamang sa mga error na rate-limit (HTTP 429).
- Ginagamit ang Discord `retry_after` kapag available, kung hindi ay exponential backoff.

### Telegram

- Nagre-retry sa mga transient na error (429, timeout, connect/reset/closed, pansamantalang hindi available).
- Ginagamit ang `retry_after` kapag available, kung hindi ay exponential backoff.
- Ang mga error sa pag-parse ng Markdown ay hindi nire-retry; bumabagsak ang mga ito sa plain text.

## Konpigurasyon

Itakda ang patakaran sa retry kada provider sa `~/.openclaw/openclaw.json`:

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

## Mga tala

- Nalalapat ang mga retry kada request (pagpapadala ng mensahe, pag-upload ng media, reaction, poll, sticker).
- Ang mga composite na flow ay hindi nagre-retry ng mga natapos nang hakbang.
