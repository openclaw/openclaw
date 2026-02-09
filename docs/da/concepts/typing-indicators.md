---
summary: "Hvornår OpenClaw viser skriveindikatorer, og hvordan du justerer dem"
read_when:
  - Ændring af adfærd eller standarder for skriveindikatorer
title: "Skriveindikatorer"
---

# Skriveindikatorer

Skrive indikatorer sendes til chatkanalen, mens et løb er aktivt. Brug
`agents.defaults.typingMode` til at styre **når** typning starter og `typingIntervalSeconds`
til at styre **hvor ofte** det opdateres.

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

- `message` tilstand vil ikke vise indtastning for lydløse svar (fx `NO_REPLY`
  token bruges til at undertrykke output).
- `tænkende` kun brande, hvis løbestrømmene ræsonnement (`ræsonnementLevel: "stream"`).
  Hvis modellen ikke udleder ræsonnement deltas, vil skrive ikke starte.
- Heartbeats viser aldrig skriveindikator, uanset tilstand.
- `typingIntervalSeconds` styrer **refresh cadence**, ikke starttidspunktet.
  Standard er 6 sekunder.
