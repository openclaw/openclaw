---
summary: "Référence CLI pour `openclaw directory` (self, pairs, groupes)"
read_when:
  - Vous voulez rechercher des contacts/groupes/ids self pour un canal
  - Vous développez un adaptateur d'annuaire de canal
title: "directory"
---

# `openclaw directory`

Recherches d'annuaire pour les canaux qui le supportent (contacts/pairs, groupes, et "moi").

## Flags courants

- `--channel <name>` : id/alias de canal (requis quand plusieurs canaux sont configurés ; auto quand un seul est configuré)
- `--account <id>` : id de compte (par défaut : défaut du canal)
- `--json` : sortie JSON

## Notes

- `directory` est destiné à vous aider à trouver des IDs que vous pouvez coller dans d'autres commandes (spécialement `openclaw message send --target ...`).
- Pour beaucoup de canaux, les résultats sont sauvegardés par config (listes blanches / groupes configurés) plutôt qu'un annuaire de fournisseur en direct.
- La sortie par défaut est `id` (et parfois `name`) séparés par une tabulation ; utilisez `--json` pour le scripting.

## Utiliser les résultats avec `message send`

```bash
openclaw directory peers list --channel slack --query "U0"
openclaw message send --channel slack --target user:U012ABCDEF --message "bonjour"
```

## Formats d'ID (par canal)

- WhatsApp : `+15551234567` (DM), `1234567890-1234567890@g.us` (groupe)
- Telegram : `@username` ou id de chat numérique ; les groupes sont des ids numériques
- Slack : `user:U…` et `channel:C…`
- Discord : `user:<id>` et `channel:<id>`
- Matrix (plugin) : `user:@user:server`, `room:!roomId:server`, ou `#alias:server`
- Microsoft Teams (plugin) : `user:<id>` et `conversation:<id>`
- Zalo (plugin) : id utilisateur (Bot API)
- Zalo Personnel / `zalouser` (plugin) : id de fil (DM/groupe) de `zca` (`me`, `friend list`, `group list`)

## Self ("moi")

```bash
openclaw directory self --channel zalouser
```

## Pairs (contacts/utilisateurs)

```bash
openclaw directory peers list --channel zalouser
openclaw directory peers list --channel zalouser --query "nom"
openclaw directory peers list --channel zalouser --limit 50
```

## Groupes

```bash
openclaw directory groups list --channel zalouser
openclaw directory groups list --channel zalouser --query "travail"
openclaw directory groups members --channel zalouser --group-id <id>
```
