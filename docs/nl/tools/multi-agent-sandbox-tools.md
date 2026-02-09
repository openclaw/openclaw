---
summary: "Sandbox per agent + toolbeperkingen, prioriteit en voorbeelden"
title: Multi-Agent Sandbox & Tools
read_when: "Je wilt sandboxing per agent of tool-toestaan/weigeren-beleid per agent in een multi-agent gateway."
status: active
---

# Configuratie van Multi-Agent Sandbox & Tools

## Overzicht

Elke agent in een multi-agent-opzet kan nu zijn eigen:

- **Sandboxconfiguratie** (`agents.list[].sandbox` overschrijft `agents.defaults.sandbox`)
- **Toolbeperkingen** (`tools.allow` / `tools.deny`, plus `agents.list[].tools`)

Dit maakt het mogelijk om meerdere agents met verschillende beveiligingsprofielen te draaien:

- Persoonlijke assistent met volledige toegang
- Familie-/werkagents met beperkte tools
- Publiek toegankelijke agents in sandboxes

`setupCommand` hoort onder `sandbox.docker` (globaal of per agent) en wordt één keer uitgevoerd
wanneer de container wordt aangemaakt.

Authenticatie is per agent: elke agent leest uit zijn eigen `agentDir`-auth store op:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

Inloggegevens worden **niet** gedeeld tussen agents. Hergebruik `agentDir` nooit tussen agents.
Als je credentials wilt delen, kopieer `auth-profiles.json` naar de `agentDir` van de andere agent.

Voor hoe sandboxing zich tijdens runtime gedraagt, zie [Sandboxing](/gateway/sandboxing).
Voor het debuggen van “waarom is dit geblokkeerd?”, zie [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) en `openclaw sandbox explain`.

---

## Configuratievoorbeelden

### Voorbeeld 1: Persoonlijke + Beperkte familie-agent

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

**Resultaat:**

- `main`-agent: Draait op de host, volledige tooltoegang
- `family`-agent: Draait in Docker (één container per agent), alleen de `read`-tool

---

### Voorbeeld 2: Werkagent met gedeelde sandbox

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

### Voorbeeld 2b: Globaal codeerprofiel + alleen-berichten-agent

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

**Resultaat:**

- standaard agents krijgen codeertools
- `support`-agent is alleen voor berichten (+ Slack-tool)

---

### Voorbeeld 3: Verschillende sandboxmodi per agent

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

## Configuratieprioriteit

Wanneer zowel globale (`agents.defaults.*`) als agentspecifieke (`agents.list[].*`) configuraties bestaan:

### Sandboxconfiguratie

Agentspecifieke instellingen overschrijven globale:

```
agents.list[].sandbox.mode > agents.defaults.sandbox.mode
agents.list[].sandbox.scope > agents.defaults.sandbox.scope
agents.list[].sandbox.workspaceRoot > agents.defaults.sandbox.workspaceRoot
agents.list[].sandbox.workspaceAccess > agents.defaults.sandbox.workspaceAccess
agents.list[].sandbox.docker.* > agents.defaults.sandbox.docker.*
agents.list[].sandbox.browser.* > agents.defaults.sandbox.browser.*
agents.list[].sandbox.prune.* > agents.defaults.sandbox.prune.*
```

**Notities:**

- `agents.list[].sandbox.{docker,browser,prune}.*` overschrijft `agents.defaults.sandbox.{docker,browser,prune}.*` voor die agent (genegeerd wanneer de sandboxscope wordt opgelost naar `"shared"`).

### Toolbeperkingen

De filtervolgorde is:

1. **Toolprofiel** (`tools.profile` of `agents.list[].tools.profile`)
2. **Provider-toolprofiel** (`tools.byProvider[provider].profile` of `agents.list[].tools.byProvider[provider].profile`)
3. **Globaal toolbeleid** (`tools.allow` / `tools.deny`)
4. **Provider-toolbeleid** (`tools.byProvider[provider].allow/deny`)
5. **Agentspecifiek toolbeleid** (`agents.list[].tools.allow/deny`)
6. **Agent-providerbeleid** (`agents.list[].tools.byProvider[provider].allow/deny`)
7. **Sandbox-toolbeleid** (`tools.sandbox.tools` of `agents.list[].tools.sandbox.tools`)
8. **Subagent-toolbeleid** (`tools.subagents.tools`, indien van toepassing)

Elk niveau kan tools verder beperken, maar kan eerder geweigerde tools niet opnieuw toestaan.
Als `agents.list[].tools.sandbox.tools` is ingesteld, vervangt dit `tools.sandbox.tools` voor die agent.
Als `agents.list[].tools.profile` is ingesteld, overschrijft dit `tools.profile` voor die agent.
Provider-tool-sleutels accepteren zowel `provider` (bijv. `google-antigravity`) als `provider/model` (bijv. `openai/gpt-5.2`).

### Toolgroepen (verkorte notaties)

Toolbeleiden (globaal, agent, sandbox) ondersteunen `group:*`-items die uitbreiden naar meerdere concrete tools:

- `group:runtime`: `exec`, `bash`, `process`
- `group:fs`: `read`, `write`, `edit`, `apply_patch`
- `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory`: `memory_search`, `memory_get`
- `group:ui`: `browser`, `canvas`
- `group:automation`: `cron`, `gateway`
- `group:messaging`: `message`
- `group:nodes`: `nodes`
- `group:openclaw`: alle ingebouwde OpenClaw-tools (sluit provider-plugins uit)

### Elevated-modus

`tools.elevated` is de globale basislijn (afzendergebaseerde toegestane lijst). `agents.list[].tools.elevated` kan elevated verder beperken voor specifieke agents (beide moeten toestaan).

Mitigatiepatronen:

- Weiger `exec` voor niet-vertrouwde agents (`agents.list[].tools.deny: ["exec"]`)
- Vermijd het toestaan van afzenders die naar beperkte agents routeren
- Schakel elevated globaal uit (`tools.elevated.enabled: false`) als je alleen gesandboxte uitvoering wilt
- Schakel elevated per agent uit (`agents.list[].tools.elevated.enabled: false`) voor gevoelige profielen

---

## Migratie vanaf één agent

**Voor (één agent):**

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

**Na (multi-agent met verschillende profielen):**

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

Legacy `agent.*`-configuraties worden gemigreerd door `openclaw doctor`; geef voortaan de voorkeur aan `agents.defaults` + `agents.list`.

---

## Voorbeelden van toolbeperkingen

### Alleen-lezen-agent

```json
{
  "tools": {
    "allow": ["read"],
    "deny": ["exec", "write", "edit", "apply_patch", "process"]
  }
}
```

### Veilige uitvoeringsagent (geen bestandswijzigingen)

```json
{
  "tools": {
    "allow": ["read", "exec", "process"],
    "deny": ["write", "edit", "apply_patch", "browser", "gateway"]
  }
}
```

### Alleen-communicatie-agent

```json
{
  "tools": {
    "allow": ["sessions_list", "sessions_send", "sessions_history", "session_status"],
    "deny": ["exec", "write", "edit", "apply_patch", "read", "browser"]
  }
}
```

---

## Veelvoorkomende valkuil: "non-main"

`agents.defaults.sandbox.mode: "non-main"` is gebaseerd op `session.mainKey` (standaard `"main"`),
niet op de agent-id. Groeps-/kanaalsessies krijgen altijd hun eigen sleutels, dus
worden ze behandeld als non-main en gesandboxed. Als je wilt dat een agent nooit
gesandboxed wordt, stel dan `agents.list[].sandbox.mode: "off"` in.

---

## Testen

Na het configureren van multi-agent sandbox en tools:

1. **Controleer agent-resolutie:**

   ```exec
   openclaw agents list --bindings
   ```

2. **Verifieer sandboxcontainers:**

   ```exec
   docker ps --filter "name=openclaw-sbx-"
   ```

3. **Test toolbeperkingen:**
   - Stuur een bericht dat beperkte tools vereist
   - Verifieer dat de agent geweigerde tools niet kan gebruiken

4. **Monitor logs:**

   ```exec
   tail -f "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/logs/gateway.log" | grep -E "routing|sandbox|tools"
   ```

---

## Problemen oplossen

### Agent niet gesandboxed ondanks `mode: "all"`

- Controleer of er een globale `agents.defaults.sandbox.mode` is die dit overschrijft
- Agentspecifieke configuratie heeft voorrang, dus stel `agents.list[].sandbox.mode: "all"` in

### Tools nog steeds beschikbaar ondanks weigerlijst

- Controleer de filtervolgorde van tools: globaal → agent → sandbox → subagent
- Elk niveau kan alleen verder beperken, niet terug toestaan
- Verifieer met logs: `[tools] filtering tools for agent:${agentId}`

### Container niet per agent geïsoleerd

- Stel `scope: "agent"` in de agentspecifieke sandboxconfiguratie in
- Standaard is `"session"`, wat één container per sessie aanmaakt

---

## Zie ook

- [Multi-Agent Routing](/concepts/multi-agent)
- [Sandboxconfiguratie](/gateway/configuration#agentsdefaults-sandbox)
- [Sessiebeheer](/concepts/session)
