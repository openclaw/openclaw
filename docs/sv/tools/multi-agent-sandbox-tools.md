---
summary: "Per-agent sandbox + verktygsbegränsningar, företräde och exempel"
title: Multi-Agent Sandbox & Tools
read_when: "Du vill ha per-agent sandboxing eller per-agent tillåt/nek-policyer för verktyg i en multi-agent gateway."
status: active
---

# Konfiguration av Multi-Agent Sandbox & Tools

## Översikt

Varje agent i en multi-agent-konfiguration kan nu ha sin egen:

- **Sandbox-konfiguration** (`agents.list[].sandbox` åsidosätter `agents.defaults.sandbox`)
- **Verktygsbegränsningar** (`tools.allow` / `tools.deny`, plus `agents.list[].tools`)

Detta gör att du kan köra flera agenter med olika säkerhetsprofiler:

- Personlig assistent med full åtkomst
- Familje-/arbetsagenter med begränsade verktyg
- Publikt exponerade agenter i sandboxes

`setupCommand` hör hemma under `sandbox.docker` (globalt eller per agent) och körs en gång
när containern skapas.

Autentisering är per agent: varje agent läser från sitt eget `agentDir`-autentiseringslager på:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

Referenser är **inte** delade mellan agenter. Återanvänd aldrig `agentDir` över agenter.
Om du vill dela krediter, kopiera `auth-profiles.json` till den andra agentens `agentDir`.

För hur sandlådan beter sig vid körning, se [Sandboxing](/gateway/sandboxing).
För felsökning “varför är detta blockerat?”, se [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) och `openclaw sandlåda förklara`.

---

## Konfigurationsexempel

### Exempel 1: Personlig + begränsad familjeagent

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

- `main`-agent: Körs på värden, full verktygsåtkomst
- `family`-agent: Körs i Docker (en container per agent), endast `read`-verktyget

---

### Exempel 2: Arbetsagent med delad sandbox

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

### Exempel 2b: Global kodningsprofil + agent endast för meddelanden

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

- standardagenter får kodningsverktyg
- `support`-agenten är endast för meddelanden (+ Slack-verktyg)

---

### Exempel 3: Olika sandbox-lägen per agent

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

## Konfigurationsföreträde

När både globala (`agents.defaults.*`) och agentspecifika (`agents.list[].*`) konfigurationer finns:

### Sandbox-konfiguration

Agentspecifika inställningar åsidosätter globala:

```
agents.list[].sandbox.mode > agents.defaults.sandbox.mode
agents.list[].sandbox.scope > agents.defaults.sandbox.scope
agents.list[].sandbox.workspaceRoot > agents.defaults.sandbox.workspaceRoot
agents.list[].sandbox.workspaceAccess > agents.defaults.sandbox.workspaceAccess
agents.list[].sandbox.docker.* > agents.defaults.sandbox.docker.*
agents.list[].sandbox.browser.* > agents.defaults.sandbox.browser.*
agents.list[].sandbox.prune.* > agents.defaults.sandbox.prune.*
```

**Noteringar:**

- `agents.list[].sandbox.{docker,browser,prune}.*` åsidosätter `agents.defaults.sandbox.{docker,browser,prune}.*` för den agenten (ignoreras när sandbox-omfattningen löses till `"shared"`).

### Verktygsbegränsningar

Filtreringsordningen är:

1. **Verktygsprofil** (`tools.profile` eller `agents.list[].tools.profile`)
2. **Leverantörens verktygsprofil** (`tools.byProvider[provider].profile` eller `agents.list[].tools.byProvider[provider].profile`)
3. **Global verktygspolicy** (`tools.allow` / `tools.deny`)
4. **Leverantörens verktygspolicy** (`tools.byProvider[provider].allow/deny`)
5. **Agentspecifik verktygspolicy** (`agents.list[].tools.allow/deny`)
6. **Agentens leverantörspolicy** (`agents.list[].tools.byProvider[provider].allow/deny`)
7. **Sandbox-verktygspolicy** (`tools.sandbox.tools` eller `agents.list[].tools.sandbox.tools`)
8. **Underagentens verktygspolicy** (`tools.subagents.tools`, om tillämpligt)

Varje nivå kan ytterligare begränsa verktyg, men kan inte ge tillbaka nekade verktyg från tidigare nivåer.
Om `agents.list[].tools.sandbox.tools` är satt, ersätter det `tools.sandbox.tools` för den agenten.
Om `agents.list[].tools.profile` är satt, åsidosätter den `tools.profile` för den agenten.
Verktygsnycklar för leverantörer accepterar antingen `provider` (t.ex. `google-antigravity`) eller `provider/model` (t.ex. `openai/gpt-5.2`).

### Verktygsgrupper (förkortningar)

Verktygspolicys (globala, agent, sandbox) stödjer `group:*`-poster som expanderar till flera konkreta verktyg:

- `group:runtime`: `exec`, `bash`, `process`
- `group:fs`: `read`, `write`, `edit`, `apply_patch`
- `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory`: `memory_search`, `memory_get`
- `group:ui`: `browser`, `canvas`
- `group:automation`: `cron`, `gateway`
- `group:messaging`: `message`
- `group:nodes`: `nodes`
- `group:openclaw`: alla inbyggda OpenClaw-verktyg (exkluderar leverantörsplugins)

### Förhöjt läge

`tools.elevated` är den globala baslinjen (avsändarbaserad allowlist). `agents.list[].tools.elevated` kan ytterligare begränsa förhöjd för specifika agenter (båda måste tillåta).

Mönster för riskminimering:

- Neka `exec` för ej betrodda agenter (`agents.list[].tools.deny: ["exec"]`)
- Undvik att tillåtslista avsändare som routar till begränsade agenter
- Inaktivera förhöjt läge globalt (`tools.elevated.enabled: false`) om du endast vill ha sandboxad körning
- Inaktivera förhöjt läge per agent (`agents.list[].tools.elevated.enabled: false`) för känsliga profiler

---

## Migrering från en agent

**Före (en agent):**

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

**Efter (multi-agent med olika profiler):**

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

Äldre `agent.*`-konfigurationer migreras av `openclaw doctor`; föredra `agents.defaults` + `agents.list` framöver.

---

## Exempel på verktygsbegränsningar

### Skrivskyddad agent

```json
{
  "tools": {
    "allow": ["read"],
    "deny": ["exec", "write", "edit", "apply_patch", "process"]
  }
}
```

### Agent för säker körning (inga filändringar)

```json
{
  "tools": {
    "allow": ["read", "exec", "process"],
    "deny": ["write", "edit", "apply_patch", "browser", "gateway"]
  }
}
```

### Agent endast för kommunikation

```json
{
  "tools": {
    "allow": ["sessions_list", "sessions_send", "sessions_history", "session_status"],
    "deny": ["exec", "write", "edit", "apply_patch", "read", "browser"]
  }
}
```

---

## Vanlig fallgrop: ”non-main”

`agents.defaults.sandbox.mode: "non-main"` är baserad på `session.mainKey` (standard `"main"`),
inte agent-id. Grupp/kanal sessioner får alltid sina egna nycklar, så de
behandlas som icke-huvud och kommer att sandlåda. Om du vill ha en agent att aldrig
sandbox, sätt `agents.list[].sandbox.mode: "off"`.

---

## Testning

Efter att ha konfigurerat multi-agent sandbox och verktyg:

1. **Kontrollera agentupplösning:**

   ```exec
   openclaw agents list --bindings
   ```

2. **Verifiera sandbox-containrar:**

   ```exec
   docker ps --filter "name=openclaw-sbx-"
   ```

3. **Testa verktygsbegränsningar:**
   - Skicka ett meddelande som kräver begränsade verktyg
   - Verifiera att agenten inte kan använda nekade verktyg

4. **Övervaka loggar:**

   ```exec
   tail -f "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/logs/gateway.log" | grep -E "routing|sandbox|tools"
   ```

---

## Felsökning

### Agenten är inte sandboxad trots `mode: "all"`

- Kontrollera om det finns en global `agents.defaults.sandbox.mode` som åsidosätter den
- Agentspecifik konfiguration har företräde, så sätt `agents.list[].sandbox.mode: "all"`

### Verktyg fortfarande tillgängliga trots neklista

- Kontrollera filtreringsordningen för verktyg: global → agent → sandbox → underagent
- Varje nivå kan endast ytterligare begränsa, inte återge
- Verifiera med loggar: `[tools] filtering tools for agent:${agentId}`

### Containern är inte isolerad per agent

- Sätt `scope: "agent"` i agentspecifik sandbox-konfiguration
- Standard är `"session"` som skapar en container per session

---

## Se även

- [Multi-Agent Routing](/concepts/multi-agent)
- [Sandbox-konfiguration](/gateway/configuration#agentsdefaults-sandbox)
- [Sessionshantering](/concepts/session)
