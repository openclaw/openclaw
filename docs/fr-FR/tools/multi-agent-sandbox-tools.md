---
summary: "Sandbox + restrictions tool per-agent, précédence et exemples"
title: Sandbox & Tools Multi-Agent
read_when: "Vous voulez sandboxing per-agent ou politiques tool allow/deny per-agent dans passerelle multi-agent."
status: active
---

# Configuration Sandbox & Tools Multi-Agent

## Overview

Chaque agent dans setup multi-agent peut maintenant avoir propre :

- **Configuration sandbox** (`agents.list[].sandbox` override `agents.defaults.sandbox`)
- **Restrictions tool** (`tools.allow` / `tools.deny`, plus `agents.list[].tools`)

Ceci permet exécuter agents multiples avec profils sécurité différents :

- Assistant personnel avec accès complet
- Agents famille/travail avec tools restreints
- Agents publics dans sandbox

`setupCommand` appartient sous `sandbox.docker` (global ou per-agent) et tourne une fois quand conteneur créé.

Auth per-agent : chaque agent lit depuis propre store auth `agentDir` à :

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

Credentials **non** partagés entre agents. Jamais réutiliser `agentDir` entre agents. Si vous voulez partager creds, copiez `auth-profiles.json` dans `agentDir` autre agent.

Pour comportement sandboxing à runtime, voir [Sandboxing](/fr-FR/gateway/sandboxing). Pour debugging "pourquoi ceci bloqué?", voir [Sandbox vs Tool Policy vs Elevated](/fr-FR/gateway/sandbox-vs-tool-policy-vs-elevated) et `openclaw sandbox explain`.

---

## Exemples Configuration

### Exemple 1 : Agent Personnel + Famille Restreint

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "default": true,
        "name": "Assistant Personnel",
        "workspace": "~/.openclaw/workspace",
        "sandbox": { "mode": "off" }
      },
      {
        "id": "family",
        "name": "Bot Famille",
        "workspace": "~/.openclaw/workspace-family",
        "sandbox": {
          "mode": "all",
          "scope": "agent"
        },
        "tools": {
          "allow": ["read"],
          "deny": ["exec", "write", "edit", "apply_patch", "process", "browser"]
        }
      }
    ]
  },
  "bindings": [
    {
      "agentId": "family",
      "match": {
        "provider": "whatsapp",
        "accountId": "*",
        "peer": {
          "kind": "group",
          "id": "120363424282127706@g.us"
        }
      }
    }
  ]
}
```

### Exemple 2 : Agent Public Sandboxé

```json
{
  "agents": {
    "list": [
      {
        "id": "public",
        "name": "Assistant Public",
        "workspace": "~/.openclaw/workspace-public",
        "sandbox": {
          "mode": "all",
          "scope": "session",
          "docker": {
            "image": "openclaw/sandbox:latest"
          }
        },
        "tools": {
          "deny": ["exec", "process", "elevated", "system"]
        }
      }
    ]
  }
}
```

### Exemple 3 : Agent Recherche Read-Only

```json
{
  "agents": {
    "list": [
      {
        "id": "research",
        "name": "Agent Recherche",
        "workspace": "~/.openclaw/workspace-research",
        "sandbox": { "mode": "off" },
        "tools": {
          "allow": ["read", "grep", "glob", "web_fetch"],
          "deny": ["write", "edit", "exec", "apply_patch"]
        }
      }
    ]
  }
}
```

## Précédence

1. **Per-agent tool policy** (`agents.list[].tools`) override défauts globaux
2. **Global tool policy** (`tools`) s'applique si pas override per-agent
3. **Sandbox mode** peut restreindre davantage (ex : mode `all` bloque exec même si autorisé)
4. **Elevated mode** bypass restrictions tool (si configuré `full`)

## Sandbox Scopes

### `scope: "agent"`

Conteneur sandbox partagé entre toutes sessions agent :

- **Persistance** : workspace préservé entre runs
- **Performance** : pas overhead création conteneur per-message
- **Isolation** : sessions agent séparées, mais workspace partagé

### `scope: "session"`

Conteneur sandbox nouveau per session :

- **Isolation max** : workspace complètement isolé per session
- **Overhead** : création conteneur per nouvelle session
- **Idéal pour** : agents publics, cas untrusted

## Configuration Docker

```json
{
  "agents": {
    "list": [
      {
        "id": "docker-agent",
        "sandbox": {
          "mode": "all",
          "scope": "agent",
          "docker": {
            "image": "openclaw/sandbox:latest",
            "setupCommand": "apt-get update && apt-get install -y ripgrep",
            "env": {
              "TZ": "America/New_York",
              "CUSTOM_VAR": "value"
            },
            "volumes": ["~/.config/agent-data:/data:ro"]
          }
        }
      }
    ]
  }
}
```

## Tool Policies

### Allow/Deny Lists

```json
{
  "tools": {
    "allow": ["read", "write", "grep"],
    "deny": ["exec", "process"]
  }
}
```

- `allow` : whitelist tools autorisés (si défini, tout le reste denied)
- `deny` : blacklist tools interdits (s'applique après allow)

### Tool Categories

Catégories communes :

- **Lecture** : `read`, `view`, `grep`, `glob`, `web_fetch`
- **Écriture** : `write`, `edit`, `create`, `apply_patch`
- **Exécution** : `exec`, `powershell`, `bash`, `system_run`
- **Process** : `process_list`, `process_kill`
- **Browser** : `browser`, `browser_screenshot`
- **Elevated** : `elevated_exec`
- **System** : tools système bas niveau

## Auth Per-Agent

Chaque agent a propre store auth :

```bash
# Store auth agent main
~/.openclaw/agents/main/agent/auth-profiles.json

# Store auth agent family
~/.openclaw/agents/family/agent/auth-profiles.json
```

**Configurer auth per-agent :**

```bash
# Login avec agent spécifique
openclaw login --agent family

# Voir profils agent
openclaw auth list --agent family
```

## Dépannage

**Tool bloqué :**

```bash
# Expliquer pourquoi tool bloqué
openclaw sandbox explain <tool-name> --agent <agentId>

# Vérifier politique tool
openclaw config get agents.list[].tools
```

**Sandbox pas démarre :**

```bash
# Vérifier statut conteneur
docker ps -a

# Voir logs conteneur
docker logs <container-id>

# Tester image manuellement
docker run -it openclaw/sandbox:latest bash
```

Voir aussi :

- [Sandboxing](/fr-FR/gateway/sandboxing)
- [Configuration](/fr-FR/gateway/configuration)
- [Mode Elevated](/fr-FR/tools/elevated)
