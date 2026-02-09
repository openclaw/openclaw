---
summary: "Retrybeleid voor uitgaande provider-aanroepen"
read_when:
  - Bijwerken van provider-retrygedrag of -standaardwaarden
  - Debuggen van provider-verzendfouten of snelheidslimieten
title: "Retrybeleid"
---

# Retrybeleid

## Doelen

- Opnieuw proberen per HTTP-verzoek, niet per meerstappenflow.
- Volgorde behouden door alleen de huidige stap opnieuw te proberen.
- Duplicatie van niet-idempotente bewerkingen vermijden.

## Standaardwaarden

- Pogingen: 3
- Maximale vertraging (cap): 30000 ms
- Jitter: 0,1 (10 procent)
- Provider-standaardwaarden:
  - Telegram minimale vertraging: 400 ms
  - Discord minimale vertraging: 500 ms

## Gedrag

### Discord

- Probeert alleen opnieuw bij rate-limitfouten (HTTP 429).
- Gebruikt Discord `retry_after` wanneer beschikbaar, anders exponentiële backoff.

### Telegram

- Probeert opnieuw bij tijdelijke fouten (429, timeout, connect/reset/closed, tijdelijk niet beschikbaar).
- Gebruikt `retry_after` wanneer beschikbaar, anders exponentiële backoff.
- Markdown-parsefouten worden niet opnieuw geprobeerd; ze vallen terug op platte tekst.

## Configuratie

Stel het retrybeleid per provider in via `~/.openclaw/openclaw.json`:

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

## Notities

- Retries zijn van toepassing per verzoek (bericht verzenden, media uploaden, reactie, poll, sticker).
- Samengestelde flows proberen voltooide stappen niet opnieuw.
