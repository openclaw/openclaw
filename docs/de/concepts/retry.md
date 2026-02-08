---
summary: „Wiederholungsrichtlinie für ausgehende Anbieteraufrufe“
read_when:
  - „Beim Aktualisieren des Wiederholungsverhaltens oder der Standardwerte von Anbietern“
  - „Beim Debuggen von Sende-Fehlern oder Ratenbegrenzungen von Anbietern“
title: „Wiederholungsrichtlinie“
x-i18n:
  source_path: concepts/retry.md
  source_hash: 55bb261ff567f46c
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:35:50Z
---

# Wiederholungsrichtlinie

## Ziele

- Wiederholung pro HTTP-Anfrage, nicht pro mehrstufigem Ablauf.
- Reihenfolge beibehalten, indem nur der aktuelle Schritt wiederholt wird.
- Duplizierung nicht-idempotenter Vorgänge vermeiden.

## Standardwerte

- Versuche: 3
- Maximale Verzögerungsobergrenze: 30000 ms
- Jitter: 0,1 (10 Prozent)
- Anbieter-Standardwerte:
  - Telegram minimale Verzögerung: 400 ms
  - Discord minimale Verzögerung: 500 ms

## Verhalten

### Discord

- Wiederholungen nur bei Rate-Limit-Fehlern (HTTP 429).
- Verwendet Discord `retry_after`, sofern verfügbar, andernfalls exponentielles Backoff.

### Telegram

- Wiederholungen bei transienten Fehlern (429, Timeout, Verbindung/Reset/Geschlossen, vorübergehend nicht verfügbar).
- Verwendet `retry_after`, sofern verfügbar, andernfalls exponentielles Backoff.
- Markdown-Parse-Fehler werden nicht wiederholt; es wird auf Klartext zurückgefallen.

## Konfiguration

Legen Sie die Wiederholungsrichtlinie pro Anbieter in `~/.openclaw/openclaw.json` fest:

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

## Hinweise

- Wiederholungen gelten pro Anfrage (Nachrichtenversand, Medien-Upload, Reaktion, Umfrage, Sticker).
- Zusammengesetzte Abläufe wiederholen keine bereits abgeschlossenen Schritte.
