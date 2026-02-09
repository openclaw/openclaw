---
summary: "Wanneer OpenClaw typindicatoren toont en hoe je ze afstemt"
read_when:
  - Het gedrag of de standaardwaarden van typindicatoren wijzigen
title: "Typindicatoren"
---

# Typindicatoren

Typindicatoren worden naar het chatkanaal gestuurd terwijl een run actief is. Gebruik
`agents.defaults.typingMode` om te bepalen **wanneer** typen start en `typingIntervalSeconds`
om te bepalen **hoe vaak** het wordt ververst.

## Standaardwaarden

Wanneer `agents.defaults.typingMode` **niet is ingesteld**, behoudt OpenClaw het legacy-gedrag:

- **Directe chats**: typen start onmiddellijk zodra de modellus begint.
- **Groepschats met een vermelding**: typen start onmiddellijk.
- **Groepschats zonder vermelding**: typen start pas wanneer berichttekst begint te streamen.
- **Heartbeat-runs**: typen is uitgeschakeld.

## Modi

Stel `agents.defaults.typingMode` in op een van de volgende opties:

- `never` — geen typindicator, ooit.
- `instant` — start typen **zodra de modellus begint**, zelfs als de run
  later alleen het stille antwoordtoken retourneert.
- `thinking` — start typen bij de **eerste redenerings-delta** (vereist
  `reasoningLevel: "stream"` voor de run).
- `message` — start typen bij de **eerste niet-stille tekstdelta** (negeert
  het `NO_REPLY` stille token).

Volgorde van “hoe vroeg het afgaat”:
`never` → `message` → `thinking` → `instant`

## Configuratie

```json5
{
  agent: {
    typingMode: "thinking",
    typingIntervalSeconds: 6,
  },
}
```

Je kunt de modus of cadans per sessie overschrijven:

```json5
{
  session: {
    typingMode: "message",
    typingIntervalSeconds: 4,
  },
}
```

## Notities

- De modus `message` toont geen typen voor uitsluitend stille antwoorden (bijv. het `NO_REPLY`
  token dat wordt gebruikt om uitvoer te onderdrukken).
- `thinking` gaat alleen af als de run redenering streamt (`reasoningLevel: "stream"`).
  Als het model geen redenerings-delta’s uitzendt, start typen niet.
- Heartbeats tonen nooit typen, ongeacht de modus.
- `typingIntervalSeconds` bepaalt de **verversingscadans**, niet het startmoment.
  De standaard is 6 seconden.
