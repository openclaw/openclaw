---
summary: "Référence CLI pour `openclaw config` (obtenir/définir/supprimer des valeurs de configuration)"
read_when:
  - Vous souhaitez lire ou modifier la configuration de manière non interactive
title: "config"
---

# `openclaw config`

Aides de configuration : obtenir/définir/supprimer des valeurs par chemin. Exécutez sans sous-commande pour ouvrir l’assistant de configuration (identique à `openclaw configure`).

## Exemples

```bash
openclaw config get browser.executablePath
openclaw config set browser.executablePath "/usr/bin/google-chrome"
openclaw config set agents.defaults.heartbeat.every "2h"
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
openclaw config unset tools.web.search.apiKey
```

## Chemins

Les chemins utilisent une notation par points ou par crochets :

```bash
openclaw config get agents.defaults.workspace
openclaw config get agents.list[0].id
```

Utilisez l’index de la liste des agents pour cibler un agent spécifique :

```bash
openclaw config get agents.list
openclaw config set agents.list[1].tools.exec.node "node-id-or-name"
```

## Valeurs

Les valeurs sont analysées en JSON5 lorsque possible ; sinon, elles sont traitées comme des chaînes.
Utilisez `--json` pour imposer l’analyse JSON5.

```bash
openclaw config set agents.defaults.heartbeat.every "0m"
openclaw config set gateway.port 19001 --json
openclaw config set channels.whatsapp.groups '["*"]' --json
```

Redémarrez la Gateway (passerelle) après les modifications.
