---
summary: "Hvornår OpenClaw viser skriveindikatorer, og hvordan du justerer dem"
read_when:
  - Ændring af adfærd eller standarder for skriveindikatorer
title: "Skriveindikatorer"
x-i18n:
  source_path: concepts/typing-indicators.md
  source_hash: 8ee82d02829c4ff5
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:20Z
---

# Skriveindikatorer

Skriveindikatorer sendes til chatkanalen, mens et run er aktivt. Brug
`agents.defaults.typingMode` til at styre **hvornår** skrivning starter og `typingIntervalSeconds`
til at styre **hvor ofte** den opdateres.

## Standarder

Når `agents.defaults.typingMode` er **ikke angivet**, beholder OpenClaw legacy-adfærden:

- **Direkte chats**: skrivning starter med det samme, når modelløkken begynder.
- **Gruppechats med en mention**: skrivning starter med det samme.
- **Gruppechats uden en mention**: skrivning starter først, når meddelelsestekst begynder at streame.
- **Heartbeat-runs**: skrivning er deaktiveret.

## Tilstande

Sæt `agents.defaults.typingMode` til en af:

- `never` — ingen skriveindikator, nogensinde.
- `instant` — start skrivning **så snart modelløkken begynder**, selv hvis run’et
  senere kun returnerer silent reply-tokenet.
- `thinking` — start skrivning ved den **første reasoning-delta** (kræver
  `reasoningLevel: "stream"` for run’et).
- `message` — start skrivning ved den **første ikke-silent tekst-delta** (ignorerer
  det `NO_REPLY` silent-token).

Rækkefølge for “hvor tidligt den udløses”:
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

Du kan tilsidesætte tilstand eller kadence pr. session:

```json5
{
  session: {
    typingMode: "message",
    typingIntervalSeconds: 4,
  },
}
```

## Noter

- `message`-tilstand viser ikke skriveindikator for svar, der kun er silent (f.eks. `NO_REPLY`-
  tokenet, der bruges til at undertrykke output).
- `thinking` udløses kun, hvis run’et streamer reasoning (`reasoningLevel: "stream"`).
  Hvis modellen ikke udsender reasoning-deltaer, starter skrivning ikke.
- Heartbeats viser aldrig skriveindikator, uanset tilstand.
- `typingIntervalSeconds` styrer **opdateringskadencen**, ikke starttidspunktet.
  Standardværdien er 6 sekunder.
