---
summary: "Envoi de sondages via la passerelle + CLI"
read_when:
  - Ajout ou modification de la prise en charge des sondages
  - Debogage des envois de sondages depuis la CLI ou la passerelle
title: "Sondages"
---

# Sondages

## Canaux pris en charge

- WhatsApp (canal web)
- Discord
- MS Teams (Adaptive Cards)

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

Options :

- `--channel` : `whatsapp` (par defaut), `discord` ou `msteams`
- `--poll-multi` : autorise la selection de plusieurs options
- `--poll-duration-hours` : reserve a Discord (par defaut 24 lorsqu’omis)

## RPC de la Gateway (passerelle)

Methode : `poll`

Parametres :

- `to` (string, requis)
- `question` (string, requis)
- `options` (string[], requis)
- `maxSelections` (number, optionnel)
- `durationHours` (number, optionnel)
- `channel` (string, optionnel, par defaut : `whatsapp`)
- `idempotencyKey` (string, requis)

## Differences selon le canal

- WhatsApp : 2 a 12 options, `maxSelections` doit etre compris dans le nombre d’options, ignore `durationHours`.
- Discord : 2 a 10 options, `durationHours` borne a 1–768 heures (par defaut 24). `maxSelections > 1` active la selection multiple ; Discord ne prend pas en charge un nombre de selections strict.
- MS Teams : sondages via Adaptive Cards (geres par OpenClaw). Pas d’API de sondage native ; `durationHours` est ignore.

## Outil d’agent (Message)

Utilisez l’outil `message` avec l’action `poll` (`to`, `pollQuestion`, `pollOption`, `pollMulti` optionnel, `pollDurationHours`, `channel`).

Remarque : Discord n’a pas de mode « choisir exactement N » ; `pollMulti` correspond a la selection multiple.
Les sondages Teams sont rendus sous forme d’Adaptive Cards et necessitent que la passerelle reste en ligne
pour enregistrer les votes dans `~/.openclaw/msteams-polls.json`.
