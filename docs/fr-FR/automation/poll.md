---
summary: "Envoi de sondages via la passerelle + CLI"
read_when:
  - Ajouter ou modifier le support de sondage
  - Déboguer les envois de sondage depuis la CLI ou la passerelle
title: "Sondages"
---

# Sondages

## Canaux supportés

- WhatsApp (canal web)
- Discord
- MS Teams (Adaptive Cards)

## CLI

```bash
# WhatsApp
openclaw message poll --target +15555550123 \
  --poll-question "Déjeuner aujourd'hui ?" --poll-option "Oui" --poll-option "Non" --poll-option "Peut-être"
openclaw message poll --target 123456789@g.us \
  --poll-question "Heure de réunion ?" --poll-option "10h" --poll-option "14h" --poll-option "16h" --poll-multi

# Discord
openclaw message poll --channel discord --target channel:123456789 \
  --poll-question "Collation ?" --poll-option "Pizza" --poll-option "Sushi"
openclaw message poll --channel discord --target channel:123456789 \
  --poll-question "Plan ?" --poll-option "A" --poll-option "B" --poll-duration-hours 48

# MS Teams
openclaw message poll --channel msteams --target conversation:19:abc@thread.tacv2 \
  --poll-question "Déjeuner ?" --poll-option "Pizza" --poll-option "Sushi"
```

Options :

- `--channel` : `whatsapp` (par défaut), `discord`, ou `msteams`
- `--poll-multi` : permettre la sélection de plusieurs options
- `--poll-duration-hours` : Discord uniquement (par défaut 24 quand omis)

## RPC de passerelle

Méthode : `poll`

Paramètres :

- `to` (chaîne, requis)
- `question` (chaîne, requis)
- `options` (chaîne[], requis)
- `maxSelections` (nombre, optionnel)
- `durationHours` (nombre, optionnel)
- `channel` (chaîne, optionnel, par défaut : `whatsapp`)
- `idempotencyKey` (chaîne, requis)

## Différences entre canaux

- WhatsApp : 2-12 options, `maxSelections` doit être dans le nombre d'options, ignore `durationHours`.
- Discord : 2-10 options, `durationHours` limité à 1-768 heures (par défaut 24). `maxSelections > 1` active la sélection multiple ; Discord ne supporte pas un compte de sélection strict.
- MS Teams : Sondages Adaptive Card (gérés par OpenClaw). Pas d'API de sondage native ; `durationHours` est ignoré.

## Outil d'agent (Message)

Utilisez l'outil `message` avec l'action `poll` (`to`, `pollQuestion`, `pollOption`, optionnel `pollMulti`, `pollDurationHours`, `channel`).

Note : Discord n'a pas de mode "choisir exactement N" ; `pollMulti` correspond à la sélection multiple.
Les sondages Teams sont rendus sous forme d'Adaptive Cards et nécessitent que la passerelle reste en ligne
pour enregistrer les votes dans `~/.openclaw/msteams-polls.json`.
