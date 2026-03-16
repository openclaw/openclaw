---
summary: "Référence CLI pour `openclaw config` (get/set/unset des valeurs de config)"
read_when:
  - Vous voulez lire ou modifier la config de manière non-interactive
title: "config"
---

# `openclaw config`

Aides de config : get/set/unset des valeurs par chemin. Exécutez sans sous-commande pour ouvrir l'assistant de configuration (identique à `openclaw configure`).

## Exemples

```bash
openclaw config get browser.executablePath
openclaw config set browser.executablePath "/usr/bin/google-chrome"
openclaw config set agents.defaults.heartbeat.every "2h"
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
openclaw config unset tools.web.search.apiKey
```

## Chemins

Les chemins utilisent la notation par point ou crochet :

```bash
openclaw config get agents.defaults.workspace
openclaw config get agents.list[0].id
```

Utilisez l'index de liste d'agent pour cibler un agent spécifique :

```bash
openclaw config get agents.list
openclaw config set agents.list[1].tools.exec.node "node-id-or-name"
```

## Valeurs

Les valeurs sont analysées comme JSON5 quand possible ; sinon elles sont traitées comme chaînes.
Utilisez `--json` pour exiger l'analyse JSON5.

```bash
openclaw config set agents.defaults.heartbeat.every "0m"
openclaw config set gateway.port 19001 --json
openclaw config set channels.whatsapp.groups '["*"]' --json
```

Redémarrez la passerelle après les modifications.
