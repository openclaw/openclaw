---
title: CLI Sandbox
summary: "Gérer conteneurs sandbox et inspecter politique sandbox effective"
read_when: "Vous gérez des conteneurs sandbox ou déboguez comportement sandbox/tool-policy."
status: active
---

# CLI Sandbox

Gérer les conteneurs sandbox basés Docker pour exécution agent isolée.

## Aperçu

OpenClaw peut exécuter des agents dans des conteneurs Docker isolés pour la sécurité. Les commandes `sandbox` vous aident à gérer ces conteneurs, surtout après mises à jour ou changements de configuration.

## Commandes

### `openclaw sandbox explain`

Inspecter le **mode/portée/accès workspace sandbox effectif**, la politique d'outil sandbox et les portes élevées (avec chemins de clé de config fix-it).

```bash
openclaw sandbox explain
openclaw sandbox explain --session agent:main:main
openclaw sandbox explain --agent work
openclaw sandbox explain --json
```

### `openclaw sandbox list`

Lister tous les conteneurs sandbox avec leur statut et configuration.

```bash
openclaw sandbox list
openclaw sandbox list --browser  # Lister uniquement conteneurs navigateur
openclaw sandbox list --json     # Sortie JSON
```

**La sortie inclut :**

- Nom et statut du conteneur (en cours/arrêté)
- Image Docker et si elle correspond à la config
- Âge (temps depuis création)
- Temps d'inactivité (temps depuis dernière utilisation)
- Session/agent associé

### `openclaw sandbox recreate`

Supprimer les conteneurs sandbox pour forcer recréation avec images/config mises à jour.

```bash
openclaw sandbox recreate --all                # Recréer tous conteneurs
openclaw sandbox recreate --session main       # Session spécifique
openclaw sandbox recreate --agent mybot        # Agent spécifique
openclaw sandbox recreate --browser            # Uniquement conteneurs navigateur
openclaw sandbox recreate --all --force        # Ignorer confirmation
```

**Options :**

- `--all` : Recréer tous conteneurs sandbox
- `--session <clé>` : Recréer conteneur pour session spécifique
- `--agent <id>` : Recréer conteneurs pour agent spécifique
- `--browser` : Recréer uniquement conteneurs navigateur
- `--force` : Ignorer invite de confirmation

**Important :** Les conteneurs sont automatiquement recréés quand l'agent est ensuite utilisé.

## Cas d'usage

### Après mise à jour d'images Docker

```bash
# Tirer nouvelle image
docker pull openclaw-sandbox:latest
docker tag openclaw-sandbox:latest openclaw-sandbox:bookworm-slim

# Mettre à jour config pour utiliser nouvelle image
# Éditer config : agents.defaults.sandbox.docker.image (ou agents.list[].sandbox.docker.image)

# Recréer conteneurs
openclaw sandbox recreate --all
```

### Après changement configuration sandbox

```bash
# Éditer config : agents.defaults.sandbox.* (ou agents.list[].sandbox.*)

# Recréer pour appliquer nouvelle config
openclaw sandbox recreate --all
```

### Après changement setupCommand

```bash
openclaw sandbox recreate --all
# ou juste un agent :
openclaw sandbox recreate --agent family
```
