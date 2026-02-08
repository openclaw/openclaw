---
summary: "När OpenClaw visar skrivindikatorer och hur du finjusterar dem"
read_when:
  - Ändrar beteende eller standardvärden för skrivindikatorer
title: "Skrivindikatorer"
x-i18n:
  source_path: concepts/typing-indicators.md
  source_hash: 8ee82d02829c4ff5
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:17:03Z
---

# Skrivindikatorer

Skrivindikatorer skickas till chattkanalen medan en körning är aktiv. Använd
`agents.defaults.typingMode` för att styra **när** skrivandet startar och `typingIntervalSeconds`
för att styra **hur ofta** den uppdateras.

## Standardvärden

När `agents.defaults.typingMode` är **inte satt** behåller OpenClaw det äldre beteendet:

- **Direktchattar**: skrivning startar omedelbart när modellloopen börjar.
- **Gruppchattar med en omnämning**: skrivning startar omedelbart.
- **Gruppchattar utan en omnämning**: skrivning startar först när meddelandetext börjar strömmas.
- **Heartbeat-körningar**: skrivning är inaktiverad.

## Lägen

Sätt `agents.defaults.typingMode` till ett av följande:

- `never` — ingen skrivindikator, någonsin.
- `instant` — starta skrivning **så snart modellloopen börjar**, även om körningen
  senare endast returnerar den tysta svarstoken.
- `thinking` — starta skrivning vid **första resonemangsdeltat** (kräver
  `reasoningLevel: "stream"` för körningen).
- `message` — starta skrivning vid **första icke‑tysta textdeltat** (ignorerar
  den tysta token `NO_REPLY`).

Ordning för ”hur tidigt den triggas”:
`never` → `message` → `thinking` → `instant`

## Konfiguration

```json5
{
  agent: {
    typingMode: "thinking",
    typingIntervalSeconds: 6,
  },
}
```

Du kan åsidosätta läge eller kadens per session:

```json5
{
  session: {
    typingMode: "message",
    typingIntervalSeconds: 4,
  },
}
```

## Noteringar

- Läget `message` visar inte skrivning för enbart tysta svar (t.ex. token `NO_REPLY`
  som används för att undertrycka utdata).
- `thinking` triggas endast om körningen strömmar resonemang (`reasoningLevel: "stream"`).
  Om modellen inte emitterar resonemangsdeltan startar inte skrivningen.
- Heartbeats visar aldrig skrivning, oavsett läge.
- `typingIntervalSeconds` styr **uppdateringskadensen**, inte starttiden.
  Standardvärdet är 6 sekunder.
