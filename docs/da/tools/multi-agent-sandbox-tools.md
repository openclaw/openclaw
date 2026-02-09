---
summary: "Sandbox pr. agent + værktøjsbegrænsninger, præcedens og eksempler"
title: Multi-Agent Sandbox & Tools
read_when: "Du vil have sandboxing pr. agent eller tillad/afvis-politikker for værktøjer pr. agent i en multi-agent gateway."
status: active
---

# Konfiguration af Multi-Agent Sandbox & Tools

## Overblik

Hver agent i en multi-agent-opsætning kan nu have sin egen:

- **Sandbox-konfiguration** (`agents.list[].sandbox` tilsidesætter `agents.defaults.sandbox`)
- **Værktøjsbegrænsninger** (`tools.allow` / `tools.deny`, plus `agents.list[].tools`)

Dette gør det muligt at køre flere agenter med forskellige sikkerhedsprofiler:

- Personlig assistent med fuld adgang
- Familie-/arbejdsagenter med begrænsede værktøjer
- Offentligt tilgængelige agenter i sandboxes

`setupCommand` hører under `sandbox.docker` (globalt eller pr. agent) og kører én gang,
når containeren oprettes.

Autentificering er pr. agent: hver agent læser fra sin egen `agentDir` auth-store på:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

Legitimationsoplysninger deles **ikke** mellem agenter. Genbrug aldrig 'agentDir' på tværs af midler.
Hvis du ønsker at dele creds, kopiere `auth-profiles.json` til den anden agent's `agentDir`.

For hvordan sandboxing opfører sig på runtime, se [Sandboxing](/gateway/sandboxing).
For fejlfinding “hvorfor er denne blokeret?”, se [Sandbox vs Tool Politik vs forhøjet](/gateway/sandbox-vs-tool-policy-vs-elevated) og `openclaw sandbox explain`.

---

## Konfigurationseksempler

### Eksempel 1: Personlig + Begrænset familieagent

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

**Resultat:**

- `main` agent: Kører på værten, fuld værktøjsadgang
- `family` agent: Kører i Docker (én container pr. agent), kun `read`-værktøj

---

### Eksempel 2: Arbejdsagent med delt sandbox

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

### Eksempel 2b: Global kodningsprofil + agent kun til beskeder

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

**Resultat:**

- standardagenter får kodningsværktøjer
- `support` agent er kun til beskeder (+ Slack-værktøj)

---

### Eksempel 3: Forskellige sandbox-tilstande pr. agent

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

## Konfigurationspræcedens

Når både globale (`agents.defaults.*`) og agent-specifikke (`agents.list[].*`) konfigurationer findes:

### Sandbox-konfiguration

Agent-specifikke indstillinger tilsidesætter globale:

```
agents.list[].sandbox.mode > agents.defaults.sandbox.mode
agents.list[].sandbox.scope > agents.defaults.sandbox.scope
agents.list[].sandbox.workspaceRoot > agents.defaults.sandbox.workspaceRoot
agents.list[].sandbox.workspaceAccess > agents.defaults.sandbox.workspaceAccess
agents.list[].sandbox.docker.* > agents.defaults.sandbox.docker.*
agents.list[].sandbox.browser.* > agents.defaults.sandbox.browser.*
agents.list[].sandbox.prune.* > agents.defaults.sandbox.prune.*
```

**Noter:**

- `agents.list[].sandbox.{docker,browser,prune}.*` tilsidesætter `agents.defaults.sandbox.{docker,browser,prune}.*` for den pågældende agent (ignoreres når sandbox-scope opløses til `"shared"`).

### Værktøjsbegrænsninger

Filtreringsrækkefølgen er:

1. **Værktøjsprofil** (`tools.profile` eller `agents.list[].tools.profile`)
2. **Udbyder-værktøjsprofil** (`tools.byProvider[provider].profile` eller `agents.list[].tools.byProvider[provider].profile`)
3. **Global værktøjspolitik** (`tools.allow` / `tools.deny`)
4. **Udbyder-værktøjspolitik** (`tools.byProvider[provider].allow/deny`)
5. **Agent-specifik værktøjspolitik** (`agents.list[].tools.allow/deny`)
6. **Agent-udbyderpolitik** (`agents.list[].tools.byProvider[provider].allow/deny`)
7. **Sandbox-værktøjspolitik** (`tools.sandbox.tools` eller `agents.list[].tools.sandbox.tools`)
8. **Subagent-værktøjspolitik** (`tools.subagents.tools`, hvis relevant)

Hvert niveau kan yderligere begrænse værktøjer, men kan ikke give tilbage nægtede værktøjer fra tidligere niveauer.
Hvis `agents.list[].tools.sandbox.tools` er indstillet, erstatter den `tools.sandbox.tools` for det agent.
Hvis `agents.list[].tools.profile` er sat, tilsidesætter den `tools.profile` for den agent.
Udbyderværktøjstaster accepterer enten `provider` (f.eks. `google-antigravity`) eller `provider/model` (f.eks. `openai/gpt-5.2`).

### Værktøjsgrupper (genveje)

Værktøjspolitikker (globale, agent, sandbox) understøtter `group:*`-poster, der udvides til flere konkrete værktøjer:

- `group:runtime`: `exec`, `bash`, `process`
- `group:fs`: `read`, `write`, `edit`, `apply_patch`
- `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory`: `memory_search`, `memory_get`
- `group:ui`: `browser`, `canvas`
- `group:automation`: `cron`, `gateway`
- `group:messaging`: `message`
- `group:nodes`: `nodes`
- `group:openclaw`: alle indbyggede OpenClaw-værktøjer (udelukker udbyder-plugins)

### Elevated-tilstand

`tools.elevated` er den globale baseline (afsenderbaseret tilladelsesliste). `agents.list[].tools.elevated` kan yderligere begrænse forhøjet for specifikke agenser (begge skal tillade).

Afhjælpningsmønstre:

- Afvis `exec` for ikke-betroede agenter (`agents.list[].tools.deny: ["exec"]`)
- Undgå at tillade afsendere, der rout’er til begrænsede agenter
- Deaktivér elevated globalt (`tools.elevated.enabled: false`), hvis du kun vil have sandboxet eksekvering
- Deaktivér elevated pr. agent (`agents.list[].tools.elevated.enabled: false`) for følsomme profiler

---

## Migration fra enkelt agent

**Før (enkelt agent):**

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

**Efter (multi-agent med forskellige profiler):**

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

Ældre `agent.*`-konfigurationer migreres af `openclaw doctor`; foretræk `agents.defaults` + `agents.list` fremover.

---

## Eksempler på værktøjsbegrænsninger

### Skrivebeskyttet agent

```json
{
  "tools": {
    "allow": ["read"],
    "deny": ["exec", "write", "edit", "apply_patch", "process"]
  }
}
```

### Sikker eksekveringsagent (ingen filændringer)

```json
{
  "tools": {
    "allow": ["read", "exec", "process"],
    "deny": ["write", "edit", "apply_patch", "browser", "gateway"]
  }
}
```

### Agent kun til kommunikation

```json
{
  "tools": {
    "allow": ["sessions_list", "sessions_send", "sessions_history", "session_status"],
    "deny": ["exec", "write", "edit", "apply_patch", "read", "browser"]
  }
}
```

---

## Almindelig faldgrube: "non-main"

`agents.defaults.sandbox.mode: "non-main"` er baseret på `session.mainKey` (standard `"main"`),
ikke agenten id. Gruppe/kanal sessioner altid få deres egne nøgler, så de
behandles som ikke-main og vil blive sandboxed. Hvis du vil have en agent til aldrig
sandkasse, sæt `agents.list[].sandbox.mode: "off"`.

---

## Test

Efter konfiguration af multi-agent sandbox og værktøjer:

1. **Tjek agent-resolving:**

   ```exec
   openclaw agents list --bindings
   ```

2. **Verificér sandbox-containere:**

   ```exec
   docker ps --filter "name=openclaw-sbx-"
   ```

3. **Test værktøjsbegrænsninger:**
   - Send en besked, der kræver begrænsede værktøjer
   - Verificér, at agenten ikke kan bruge nægtede værktøjer

4. **Overvåg logs:**

   ```exec
   tail -f "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/logs/gateway.log" | grep -E "routing|sandbox|tools"
   ```

---

## Fejlfinding

### Agent ikke sandboxet trods `mode: "all"`

- Tjek om der er en global `agents.defaults.sandbox.mode`, der tilsidesætter den
- Agent-specifik konfiguration har forrang, så sæt `agents.list[].sandbox.mode: "all"`

### Værktøjer stadig tilgængelige trods deny-liste

- Tjek værktøjsfiltreringsrækkefølgen: global → agent → sandbox → subagent
- Hvert niveau kan kun yderligere begrænse, ikke give tilbage
- Verificér med logs: `[tools] filtering tools for agent:${agentId}`

### Container ikke isoleret pr. agent

- Sæt `scope: "agent"` i agent-specifik sandbox-konfiguration
- Standard er `"session"`, som opretter én container pr. session

---

## Se også

- [Multi-Agent Routing](/concepts/multi-agent)
- [Sandbox-konfiguration](/gateway/configuration#agentsdefaults-sandbox)
- [Session Management](/concepts/session)
