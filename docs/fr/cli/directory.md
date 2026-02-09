---
summary: "Reference CLI pour `openclaw directory` (soi, pairs, groupes)"
read_when:
  - Vous souhaitez rechercher des identifiants de contacts/groupes/soi pour un canal
  - Vous developpez un adaptateur d'annuaire de canal
title: "directory"
---

# `openclaw directory`

Recherches dans l'annuaire pour les canaux qui le prennent en charge (contacts/pairs, groupes et « moi »).

## Drapeaux courants

- `--channel <name>` : identifiant/alias de canal (requis lorsque plusieurs canaux sont configures ; automatique lorsqu'un seul est configure)
- `--account <id>` : identifiant de compte (par defaut : valeur par defaut du canal)
- `--json` : sortie JSON

## Notes

- `directory` est concu pour vous aider a trouver des identifiants que vous pouvez coller dans d'autres commandes (en particulier `openclaw message send --target ...`).
- Pour de nombreux canaux, les resultats sont adosses a la configuration (listes d'autorisation / groupes configures) plutot qu'a un annuaire fournisseur en temps reel.
- La sortie par defaut est `id` (et parfois `name`) separes par une tabulation ; utilisez `--json` pour le scripting.

## Utilisation des resultats avec `message send`

```bash
openclaw directory peers list --channel slack --query "U0"
openclaw message send --channel slack --target user:U012ABCDEF --message "hello"
```

## Formats d'identifiant (par canal)

- WhatsApp : `+15551234567` (Message prive), `1234567890-1234567890@g.us` (groupe)
- Telegram : `@username` ou identifiant de chat numerique ; les groupes sont des identifiants numeriques
- Slack : `user:U…` et `channel:C…`
- Discord : `user:<id>` et `channel:<id>`
- Matrix (plugin) : `user:@user:server`, `room:!roomId:server` ou `#alias:server`
- Microsoft Teams (plugin) : `user:<id>` et `conversation:<id>`
- Zalo (plugin) : identifiant utilisateur (API Bot)
- Zalo Personnel / `zalouser` (plugin) : identifiant de fil (Message prive/groupe) depuis `zca` (`me`, `friend list`, `group list`)

## Soi (« moi »)

```bash
openclaw directory self --channel zalouser
```

## Pairs (contacts/utilisateurs)

```bash
openclaw directory peers list --channel zalouser
openclaw directory peers list --channel zalouser --query "name"
openclaw directory peers list --channel zalouser --limit 50
```

## Groupes

```bash
openclaw directory groups list --channel zalouser
openclaw directory groups list --channel zalouser --query "work"
openclaw directory groups members --channel zalouser --group-id <id>
```
