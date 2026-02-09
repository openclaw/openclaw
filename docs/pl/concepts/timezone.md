---
summary: "Obsługa stref czasowych dla agentów, kopert i promptów"
read_when:
  - Musisz zrozumieć, jak znaczniki czasu są normalizowane dla modelu
  - Konfigurowanie strefy czasowej użytkownika dla promptów systemowych
title: "Strefy czasowe"
---

# Strefy czasowe

OpenClaw standaryzuje znaczniki czasu, aby model widział **pojedynczy czas odniesienia**.

## Koperty wiadomości (domyślnie lokalne)

Wiadomości przychodzące są opakowywane w kopertę, taką jak:

```
[Provider ... 2026-01-05 16:26 PST] message text
```

Znacznik czasu w kopercie jest **domyślnie lokalny dla hosta**, z dokładnością do minut.

Można to nadpisać za pomocą:

```json5
{
  agents: {
    defaults: {
      envelopeTimezone: "local", // "utc" | "local" | "user" | IANA timezone
      envelopeTimestamp: "on", // "on" | "off"
      envelopeElapsed: "on", // "on" | "off"
    },
  },
}
```

- `envelopeTimezone: "utc"` używa UTC.
- `envelopeTimezone: "user"` używa `agents.defaults.userTimezone` (w razie potrzeby wraca do strefy czasowej hosta).
- Użyj jawnej strefy czasowej IANA (np. `"Europe/Vienna"`) dla stałego przesunięcia.
- `envelopeTimestamp: "off"` usuwa bezwzględne znaczniki czasu z nagłówków koperty.
- `envelopeElapsed: "off"` usuwa sufiksy czasu upływu (styl `+2m`).

### Przykłady

**Lokalna (domyślna):**

```
[Signal Alice +1555 2026-01-18 00:19 PST] hello
```

**Stała strefa czasowa:**

```
[Signal Alice +1555 2026-01-18 06:19 GMT+1] hello
```

**Czas upływu:**

```
[Signal Alice +1555 +2m 2026-01-18T05:19Z] follow-up
```

## Ładunki narzędzi (surowe dane dostawcy + pola znormalizowane)

Wywołania narzędzi (`channels.discord.readMessages`, `channels.slack.readMessages` itd.) zwracają **surowe znaczniki czasu dostawcy**.
Dla spójności dołączamy także pola znormalizowane:

- `timestampMs` (milisekundy epoki UTC)
- `timestampUtc` (łańcuch ISO 8601 UTC)

Surowe pola dostawcy są zachowywane.

## Strefa czasowa użytkownika dla promptu systemowego

Ustaw `agents.defaults.userTimezone`, aby poinformować model o lokalnej strefie czasowej użytkownika. Jeśli jest
nieustawiona, OpenClaw rozwiązuje **strefę czasową hosta w czasie wykonywania** (bez zapisu konfiguracji).

```json5
{
  agents: { defaults: { userTimezone: "America/Chicago" } },
}
```

Prompt systemowy zawiera:

- sekcję `Current Date & Time` z lokalnym czasem i strefą czasową
- `Time format: 12-hour` lub `24-hour`

Format promptu można kontrolować za pomocą `agents.defaults.timeFormat` (`auto` | `12` | `24`).

Zobacz [Date & Time](/date-time), aby poznać pełne zachowanie i przykłady.
