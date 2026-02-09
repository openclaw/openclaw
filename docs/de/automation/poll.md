---
summary: "„Versand von Umfragen über Gateway + CLI“"
read_when:
  - Hinzufügen oder Ändern der Umfrageunterstützung
  - Debugging von Umfrageversendungen über die CLI oder das Gateway
title: "„Umfragen“"
---

# Umfragen

## Unterstützte Kanäle

- WhatsApp (Webkanal)
- Discord
- Microsoft Teams (Adaptive Cards)

## CLI

```bash
# WhatsApp
openclaw message poll --target +15555550123 \
  --poll-question "Lunch today?" --poll-option "Yes" --poll-option "No" --poll-option "Maybe"
openclaw message poll --target 123456789@g.us \
  --poll-question "Meeting time?" --poll-option "10am" --poll-option "2pm" --poll-option "4pm" --poll-multi

# Discord
openclaw message poll --channel discord --target channel:123456789 \
  --poll-question "Snack?" --poll-option "Pizza" --poll-option "Sushi"
openclaw message poll --channel discord --target channel:123456789 \
  --poll-question "Plan?" --poll-option "A" --poll-option "B" --poll-duration-hours 48

# MS Teams
openclaw message poll --channel msteams --target conversation:19:abc@thread.tacv2 \
  --poll-question "Lunch?" --poll-option "Pizza" --poll-option "Sushi"
```

Optionen:

- `--channel`: `whatsapp` (Standard), `discord` oder `msteams`
- `--poll-multi`: Auswahl mehrerer Optionen erlauben
- `--poll-duration-hours`: Nur Discord (Standardwert 24, wenn nicht angegeben)

## Gateway RPC

Methode: `poll`

Parameter:

- `to` (string, erforderlich)
- `question` (string, erforderlich)
- `options` (string[], erforderlich)
- `maxSelections` (number, optional)
- `durationHours` (number, optional)
- `channel` (string, optional, Standard: `whatsapp`)
- `idempotencyKey` (string, erforderlich)

## Kanalunterschiede

- WhatsApp: 2–12 Optionen, `maxSelections` muss innerhalb der Optionsanzahl liegen, ignoriert `durationHours`.
- Discord: 2–10 Optionen, `durationHours` auf 1–768 Stunden begrenzt (Standard 24). `maxSelections > 1` aktiviert Mehrfachauswahl; Discord unterstützt keine strikte Auswahlanzahl.
- Microsoft Teams: Adaptive-Card-Umfragen (von OpenClaw verwaltet). Keine native Umfrage-API; `durationHours` wird ignoriert.

## Agent-Werkzeug (Nachricht)

Verwenden Sie das Werkzeug `message` mit der Aktion `poll` (`to`, `pollQuestion`, `pollOption`, optional `pollMulti`, `pollDurationHours`, `channel`).

Hinweis: Discord hat keinen Modus „genau N auswählen“; `pollMulti` wird auf Mehrfachauswahl abgebildet.
Teams-Umfragen werden als Adaptive Cards gerendert und erfordern, dass das Gateway online bleibt,
um Stimmen in `~/.openclaw/msteams-polls.json` zu erfassen.
