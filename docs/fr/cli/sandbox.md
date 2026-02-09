---
title: CLI de la sandbox
summary: "Gérer les conteneurs de sandbox et inspecter la politique de sandbox effective"
read_when: "Vous gérez des conteneurs de sandbox ou déboguez le comportement de la sandbox ou des politiques d’outils."
status: active
---

# CLI de la sandbox

Gérez des conteneurs de sandbox basés sur Docker pour l’exécution isolée des agents.

## Présentation

OpenClaw peut exécuter des agents dans des conteneurs Docker isolés pour la sécurité. Les commandes `sandbox` vous aident à gérer ces conteneurs, en particulier après des mises à jour ou des changements de configuration.

## Commandes

### `openclaw sandbox explain`

Inspectez le mode/la portée/l’accès à l’espace de travail de la sandbox **effectifs**, la politique d’outils de la sandbox et les passerelles élevées (avec les chemins de clés de configuration « fix-it »).

```bash
openclaw sandbox explain
openclaw sandbox explain --session agent:main:main
openclaw sandbox explain --agent work
openclaw sandbox explain --json
```

### `openclaw sandbox list`

Listez tous les conteneurs de sandbox avec leur état et leur configuration.

```bash
openclaw sandbox list
openclaw sandbox list --browser  # List only browser containers
openclaw sandbox list --json     # JSON output
```

**La sortie inclut :**

- Nom du conteneur et état (en cours d’exécution/arrêté)
- Image Docker et correspondance avec la configuration
- Âge (temps depuis la création)
- Temps d’inactivité (temps depuis la dernière utilisation)
- Session/agent associé

### `openclaw sandbox recreate`

Supprimez des conteneurs de sandbox pour forcer leur recréation avec des images/configurations mises à jour.

```bash
openclaw sandbox recreate --all                # Recreate all containers
openclaw sandbox recreate --session main       # Specific session
openclaw sandbox recreate --agent mybot        # Specific agent
openclaw sandbox recreate --browser            # Only browser containers
openclaw sandbox recreate --all --force        # Skip confirmation
```

**Options :**

- `--all` : Recréer tous les conteneurs de sandbox
- `--session <key>` : Recréer le conteneur pour une session spécifique
- `--agent <id>` : Recréer les conteneurs pour un agent spécifique
- `--browser` : Recréer uniquement les conteneurs de navigateur
- `--force` : Ignorer l’invite de confirmation

**Important :** Les conteneurs sont automatiquement recréés lors de la prochaine utilisation de l’agent.

## Cas d’utilisation

### Après la mise à jour des images Docker

```bash
# Pull new image
docker pull openclaw-sandbox:latest
docker tag openclaw-sandbox:latest openclaw-sandbox:bookworm-slim

# Update config to use new image
# Edit config: agents.defaults.sandbox.docker.image (or agents.list[].sandbox.docker.image)

# Recreate containers
openclaw sandbox recreate --all
```

### Après un changement de configuration de la sandbox

```bash
# Edit config: agents.defaults.sandbox.* (or agents.list[].sandbox.*)

# Recreate to apply new config
openclaw sandbox recreate --all
```

### Après un changement de setupCommand

```bash
openclaw sandbox recreate --all
# or just one agent:
openclaw sandbox recreate --agent family
```

### Pour un agent spécifique uniquement

```bash
# Update only one agent's containers
openclaw sandbox recreate --agent alfred
```

## Pourquoi est-ce nécessaire ?

**Problème :** Lorsque vous mettez à jour les images Docker de la sandbox ou la configuration :

- Les conteneurs existants continuent de s’exécuter avec d’anciens paramètres
- Les conteneurs ne sont nettoyés qu’après 24 h d’inactivité
- Les agents utilisés régulièrement conservent indéfiniment d’anciens conteneurs en cours d’exécution

**Solution :** Utilisez `openclaw sandbox recreate` pour forcer la suppression des anciens conteneurs. Ils seront automatiquement recréés avec les paramètres actuels au prochain besoin.

Astuce : préférez `openclaw sandbox recreate` à `docker rm` manuel. Cela utilise la dénomination des conteneurs de la Gateway (passerelle) et évite les incohérences lorsque les clés de portée/session changent.

## Configuration

Les paramètres de la sandbox se trouvent dans `~/.openclaw/openclaw.json` sous `agents.defaults.sandbox` (les surcharges par agent se placent dans `agents.list[].sandbox`) :

```jsonc
{
  "agents": {
    "defaults": {
      "sandbox": {
        "mode": "all", // off, non-main, all
        "scope": "agent", // session, agent, shared
        "docker": {
          "image": "openclaw-sandbox:bookworm-slim",
          "containerPrefix": "openclaw-sbx-",
          // ... more Docker options
        },
        "prune": {
          "idleHours": 24, // Auto-prune after 24h idle
          "maxAgeDays": 7, // Auto-prune after 7 days
        },
      },
    },
  },
}
```

## Voir aussi

- [Documentation Sandbox](/gateway/sandboxing)
- [Configuration des agents](/concepts/agent-workspace)
- [Commande Doctor](/gateway/doctor) - Vérifier la configuration de la sandbox
