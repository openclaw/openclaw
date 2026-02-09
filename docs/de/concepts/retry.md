---
summary: "Richtlinien für ausgehende Provideranrufe wiederholen"
read_when:
  - „Beim Aktualisieren des Wiederholungsverhaltens oder der Standardwerte von Anbietern“
  - „Beim Debuggen von Sende-Fehlern oder Ratenbegrenzungen von Anbietern“
title: "Richtlinie wiederholen"
---

# Retry-Richtlinie

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
