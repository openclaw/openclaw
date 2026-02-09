---
summary: "Sandbox par agent + restrictions d’outils, précédence et exemples"
title: Sandbox multi-agents et outils
read_when: "Vous souhaitez un sandboxing par agent ou des politiques d’autorisation/refus d’outils par agent dans une Gateway (passerelle) multi-agents."
status: active
---

# Configuration du sandbox et des outils multi-agents

## Présentation

Chaque agent dans une configuration multi-agents peut désormais avoir sa propre :

- **Configuration de sandbox** (`agents.list[].sandbox` remplace `agents.defaults.sandbox`)
- **Restrictions d’outils** (`tools.allow` / `tools.deny`, plus `agents.list[].tools`)

Cela vous permet d’exécuter plusieurs agents avec des profils de sécurité différents :

- Assistant personnel avec accès complet
- Agents famille/travail avec outils restreints
- Agents exposés au public dans des sandboxes

`setupCommand` relève de `sandbox.docker` (global ou par agent) et s’exécute une seule fois
lorsque le conteneur est créé.

L’authentification est par agent : chaque agent lit depuis son propre magasin d’authentification `agentDir` à l’emplacement :

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

Les identifiants **ne sont pas** partagés entre agents. Ne réutilisez jamais `agentDir` entre agents.
Si vous souhaitez partager des identifiants, copiez `auth-profiles.json` dans le `agentDir` de l’autre agent.

Pour le comportement du sandbox à l’exécution, voir [Sandboxing](/gateway/sandboxing).
Pour déboguer « pourquoi est-ce bloqué ? », voir [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) et `openclaw sandbox explain`.

---

## Exemples de configuration

### Exemple 1 : Agent personnel + agent familial restreint

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "default": true,
        "name": "Personal Assistant",
        "workspace": "~/.openclaw/workspace",
        "sandbox": { "mode": "off" }
      },
      {
        "id": "family",
        "name": "Family Bot",
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

**Résultat :**

- Agent `main` : s’exécute sur l’hôte, accès complet aux outils
- Agent `family` : s’exécute dans Docker (un conteneur par agent), uniquement l’outil `read`

---

### Exemple 2 : Agent de travail avec sandbox partagé

```json
{
  "agents": {
    "list": [
      {
        "id": "personal",
        "workspace": "~/.openclaw/workspace-personal",
        "sandbox": { "mode": "off" }
      },
      {
        "id": "work",
        "workspace": "~/.openclaw/workspace-work",
        "sandbox": {
          "mode": "all",
          "scope": "shared",
          "workspaceRoot": "/tmp/work-sandboxes"
        },
        "tools": {
          "allow": ["read", "write", "apply_patch", "exec"],
          "deny": ["browser", "gateway", "discord"]
        }
      }
    ]
  }
}
```

---

### Exemple 2b : Profil de codage global + agent uniquement messagerie

```json
{
  "tools": { "profile": "coding" },
  "agents": {
    "list": [
      {
        "id": "support",
        "tools": { "profile": "messaging", "allow": ["slack"] }
      }
    ]
  }
}
```

**Résultat :**

- Les agents par défaut obtiennent les outils de codage
- L’agent `support` est uniquement messagerie (+ outil Slack)

---

### Exemple 3 : Modes de sandbox différents par agent

```json
{
  "agents": {
    "defaults": {
      "sandbox": {
        "mode": "non-main", // Global default
        "scope": "session"
      }
    },
    "list": [
      {
        "id": "main",
        "workspace": "~/.openclaw/workspace",
        "sandbox": {
          "mode": "off" // Override: main never sandboxed
        }
      },
      {
        "id": "public",
        "workspace": "~/.openclaw/workspace-public",
        "sandbox": {
          "mode": "all", // Override: public always sandboxed
          "scope": "agent"
        },
        "tools": {
          "allow": ["read"],
          "deny": ["exec", "write", "edit", "apply_patch"]
        }
      }
    ]
  }
}
```

---

## Précédence de configuration

Lorsque des configurations globales (`agents.defaults.*`) et spécifiques à l’agent (`agents.list[].*`) existent :

### Configuration du sandbox

Les paramètres spécifiques à l’agent remplacent les paramètres globaux :

```
agents.list[].sandbox.mode > agents.defaults.sandbox.mode
agents.list[].sandbox.scope > agents.defaults.sandbox.scope
agents.list[].sandbox.workspaceRoot > agents.defaults.sandbox.workspaceRoot
agents.list[].sandbox.workspaceAccess > agents.defaults.sandbox.workspaceAccess
agents.list[].sandbox.docker.* > agents.defaults.sandbox.docker.*
agents.list[].sandbox.browser.* > agents.defaults.sandbox.browser.*
agents.list[].sandbox.prune.* > agents.defaults.sandbox.prune.*
```

**Remarques :**

- `agents.list[].sandbox.{docker,browser,prune}.*` remplace `agents.defaults.sandbox.{docker,browser,prune}.*` pour cet agent (ignoré lorsque la portée du sandbox se résout en `"shared"`).

### Restrictions d’outils

L’ordre de filtrage est le suivant :

1. **Profil d’outils** (`tools.profile` ou `agents.list[].tools.profile`)
2. **Profil d’outils du fournisseur** (`tools.byProvider[provider].profile` ou `agents.list[].tools.byProvider[provider].profile`)
3. **Politique d’outils globale** (`tools.allow` / `tools.deny`)
4. **Politique d’outils du fournisseur** (`tools.byProvider[provider].allow/deny`)
5. **Politique d’outils spécifique à l’agent** (`agents.list[].tools.allow/deny`)
6. **Politique du fournisseur de l’agent** (`agents.list[].tools.byProvider[provider].allow/deny`)
7. **Politique d’outils du sandbox** (`tools.sandbox.tools` ou `agents.list[].tools.sandbox.tools`)
8. **Politique d’outils du sous-agent** (`tools.subagents.tools`, le cas échéant)

Chaque niveau peut restreindre davantage les outils, mais ne peut pas rétablir des outils refusés par des niveaux antérieurs.
Si `agents.list[].tools.sandbox.tools` est défini, il remplace `tools.sandbox.tools` pour cet agent.
Si `agents.list[].tools.profile` est défini, il remplace `tools.profile` pour cet agent.
Les clés d’outils du fournisseur acceptent soit `provider` (par ex. `google-antigravity`), soit `provider/model` (par ex. `openai/gpt-5.2`).

### Groupes d’outils (raccourcis)

Les politiques d’outils (globales, par agent, sandbox) prennent en charge des entrées `group:*` qui s’étendent à plusieurs outils concrets :

- `group:runtime` : `exec`, `bash`, `process`
- `group:fs` : `read`, `write`, `edit`, `apply_patch`
- `group:sessions` : `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory` : `memory_search`, `memory_get`
- `group:ui` : `browser`, `canvas`
- `group:automation` : `cron`, `gateway`
- `group:messaging` : `message`
- `group:nodes` : `nodes`
- `group:openclaw` : tous les outils OpenClaw intégrés (exclut les plugins de fournisseur)

### Mode Elevated

`tools.elevated` constitue la base globale (liste d’autorisation basée sur l’expéditeur). `agents.list[].tools.elevated` peut restreindre davantage l’elevated pour des agents spécifiques (les deux doivent autoriser).

Schémas d’atténuation :

- Refuser `exec` pour les agents non fiables (`agents.list[].tools.deny: ["exec"]`)
- Éviter d’autoriser des expéditeurs qui routent vers des agents restreints
- Désactiver elevated globalement (`tools.elevated.enabled: false`) si vous souhaitez uniquement une exécution sandboxée
- Désactiver elevated par agent (`agents.list[].tools.elevated.enabled: false`) pour des profils sensibles

---

## Migration depuis un agent unique

**Avant (agent unique) :**

```json
{
  "agents": {
    "defaults": {
      "workspace": "~/.openclaw/workspace",
      "sandbox": {
        "mode": "non-main"
      }
    }
  },
  "tools": {
    "sandbox": {
      "tools": {
        "allow": ["read", "write", "apply_patch", "exec"],
        "deny": []
      }
    }
  }
}
```

**Après (multi-agents avec des profils différents) :**

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "default": true,
        "workspace": "~/.openclaw/workspace",
        "sandbox": { "mode": "off" }
      }
    ]
  }
}
```

Les configurations héritées `agent.*` sont migrées par `openclaw doctor` ; privilégiez `agents.defaults` + `agents.list` à l’avenir.

---

## Exemples de restriction d’outils

### Agent en lecture seule

```json
{
  "tools": {
    "allow": ["read"],
    "deny": ["exec", "write", "edit", "apply_patch", "process"]
  }
}
```

### Agent d’exécution sécurisée (aucune modification de fichiers)

```json
{
  "tools": {
    "allow": ["read", "exec", "process"],
    "deny": ["write", "edit", "apply_patch", "browser", "gateway"]
  }
}
```

### Agent uniquement communication

```json
{
  "tools": {
    "allow": ["sessions_list", "sessions_send", "sessions_history", "session_status"],
    "deny": ["exec", "write", "edit", "apply_patch", "read", "browser"]
  }
}
```

---

## Piège courant : « non-main »

`agents.defaults.sandbox.mode: "non-main"` est basé sur `session.mainKey` (par défaut `"main"`),
et non sur l’identifiant de l’agent. Les sessions de groupe/canal obtiennent toujours leurs propres clés,
elles sont donc traitées comme non-main et seront sandboxées. Si vous voulez qu’un agent ne soit jamais
sandboxé, définissez `agents.list[].sandbox.mode: "off"`.

---

## Tests

Après avoir configuré le sandbox et les outils multi-agents :

1. **Vérifier la résolution des agents :**

   ```exec
   openclaw agents list --bindings
   ```

2. **Vérifier les conteneurs de sandbox :**

   ```exec
   docker ps --filter "name=openclaw-sbx-"
   ```

3. **Tester les restrictions d’outils :**
   - Envoyer un message nécessitant des outils restreints
   - Vérifier que l’agent ne peut pas utiliser les outils refusés

4. **Journaux du moniteur :**

   ```exec
   tail -f "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/logs/gateway.log" | grep -E "routing|sandbox|tools"
   ```

---

## Problemes courants

### Agent non sandboxé malgré `mode: "all"`

- Vérifiez s’il existe un `agents.defaults.sandbox.mode` global qui l’écrase
- La configuration spécifique à l’agent a priorité ; définissez donc `agents.list[].sandbox.mode: "all"`

### Outils toujours disponibles malgré la liste de refus

- Vérifiez l’ordre de filtrage des outils : global → agent → sandbox → sous-agent
- Chaque niveau ne peut que restreindre davantage, pas rétablir
- Vérifiez via les journaux : `[tools] filtering tools for agent:${agentId}`

### Conteneur non isolé par agent

- Définissez `scope: "agent"` dans la configuration de sandbox spécifique à l’agent
- La valeur par défaut est `"session"`, qui crée un conteneur par session

---

## Voir aussi

- [Routage multi-agents](/concepts/multi-agent)
- [Configuration du sandbox](/gateway/configuration#agentsdefaults-sandbox)
- [Gestion des sessions](/concepts/session)
