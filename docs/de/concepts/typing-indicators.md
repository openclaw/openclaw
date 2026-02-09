---
summary: "„Wann OpenClaw Tippindikatoren anzeigt und wie Sie sie anpassen“"
read_when:
  - „Ändern des Verhaltens oder der Standardwerte von Tippindikatoren“
title: "„Tippindikatoren“"
---

# Tippindikatoren

Tippindikatoren werden an den Chat-Kanal gesendet, während ein Run aktiv ist. Verwenden Sie
`agents.defaults.typingMode`, um zu steuern, **wann** das Tippen beginnt, und `typingIntervalSeconds`,
um zu steuern, **wie oft** es aktualisiert wird.

## Standardwerte

Wenn `agents.defaults.typingMode` **nicht gesetzt** ist, behält OpenClaw das Legacy-Verhalten bei:

- **Direktchats**: Tippen beginnt sofort, sobald die Modellschleife startet.
- **Gruppenchats mit Erwähnung**: Tippen beginnt sofort.
- **Gruppenchats ohne Erwähnung**: Tippen beginnt erst, wenn der Nachrichtentext zu streamen beginnt.
- **Heartbeat-Runs**: Tippen ist deaktiviert.

## Modi

Setzen Sie `agents.defaults.typingMode` auf einen der folgenden Werte:

- `never` — kein Tippindikator, jemals.
- `instant` — Tippen **beginnt sofort mit Start der Modellschleife**, selbst wenn der Run
  später nur das stille Antwort-Token zurückgibt.
- `thinking` — Tippen beginnt beim **ersten Reasoning-Delta** (erfordert
  `reasoningLevel: "stream"` für den Run).
- `message` — Tippen beginnt beim **ersten nicht-stillen Text-Delta** (ignoriert
  das stille Token `NO_REPLY`).

Reihenfolge nach „wie früh es auslöst“:
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

Sie können Modus oder Taktung pro Sitzung überschreiben:

```json5
{
  session: {
    typingMode: "message",
    typingIntervalSeconds: 4,
  },
}
```

## Hinweise

- Der Modus `message` zeigt kein Tippen für ausschließlich stille Antworten an (z. B. das Token `NO_REPLY`,
  das zur Unterdrückung der Ausgabe verwendet wird).
- `thinking` wird nur ausgelöst, wenn der Run Reasoning streamt (`reasoningLevel: "stream"`).
  Wenn das Modell keine Reasoning-Deltas ausgibt, beginnt das Tippen nicht.
- Heartbeats zeigen niemals Tippen an, unabhängig vom Modus.
- `typingIntervalSeconds` steuert die **Aktualisierungstaktung**, nicht den Startzeitpunkt.
  Der Standardwert beträgt 6 Sekunden.
