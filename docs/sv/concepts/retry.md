---
summary: "Återförsökspolicy för utgående leverantörsanrop"
read_when:
  - Uppdatering av leverantörers återförsöksbeteende eller standardvärden
  - Felsökning av leverantörers sändningsfel eller hastighetsbegränsningar
title: "Återförsökspolicy"
---

# Återförsökspolicy

## Mål

- Återförsök per HTTP-begäran, inte per flerstegsflöde.
- Bevara ordning genom att endast återförsöka det aktuella steget.
- Undvik duplicering av icke-idempotenta operationer.

## Standardvärden

- Försök: 3
- Maximal fördröjningsgräns: 30000 ms
- Jitter: 0.1 (10 procent)
- Leverantörsstandarder:
  - Telegram minsta fördröjning: 400 ms
  - Discord minsta fördröjning: 500 ms

## Beteende

### Discord

- Återförsök endast vid fel på grund av hastighetsbegränsning (HTTP 429).
- Använder Discord `retry_after` när tillgängligt, annars exponentiell backoff.

### Telegram

- Återförsök vid tillfälliga fel (429, timeout, connect/reset/closed, tillfälligt otillgänglig).
- Använder `retry_after` när tillgängligt, annars exponentiell backoff.
- Markdown-parsningsfel återförsöks inte; de faller tillbaka till vanlig text.

## Konfiguration

Ställ in återförsökspolicy per leverantör i `~/.openclaw/openclaw.json`:

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

## Noteringar

- Återförsök gäller per begäran (meddelandesändning, medieuppladdning, reaktion, omröstning, klistermärke).
- Sammansatta flöden återförsöker inte redan slutförda steg.
