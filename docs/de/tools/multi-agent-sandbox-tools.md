---
summary: "Sandbox pro Agent + Werkzeugeinschränkungen, Priorität und Beispiele"
title: Multi-Agent-Sandbox & Werkzeuge
read_when: "Sie möchten Sandboxing pro Agent oder pro Agent Tool-Allow-/Deny-Richtlinien in einem Multi-Agent-Gateway."
status: active
---

# Multi-Agent-Sandbox- & Werkzeugkonfiguration

## Überblick

Jeder Agent in einer Multi-Agent-Konfiguration kann nun über Folgendes verfügen:

- **Sandbox-Konfiguration** (`agents.list[].sandbox` überschreibt `agents.defaults.sandbox`)
- **Werkzeugeinschränkungen** (`tools.allow` / `tools.deny`, plus `agents.list[].tools`)

Dies ermöglicht es Ihnen, mehrere Agenten mit unterschiedlichen Sicherheitsprofilen auszuführen:

- Persönlicher Assistent mit vollem Zugriff
- Familien-/Arbeitsagenten mit eingeschränkten Werkzeugen
- Öffentlich zugängliche Agenten in Sandboxes

`setupCommand` gehört unter `sandbox.docker` (global oder pro Agent) und wird einmal ausgeführt,
wenn der Container erstellt wird.

Authentifizierung ist pro Agent: Jeder Agent liest aus seinem eigenen `agentDir`-Auth-Store unter:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

Anmeldedaten werden **nicht** zwischen Agenten geteilt. Verwenden Sie `agentDir` niemals für mehrere Agenten erneut.
Wenn Sie Anmeldedaten teilen möchten, kopieren Sie `auth-profiles.json` in den `agentDir` des anderen Agenten.

Wie sich Sandboxing zur Laufzeit verhält, siehe [Sandboxing](/gateway/sandboxing).
Zum Debuggen von „Warum ist das blockiert?“ siehe [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) und `openclaw sandbox explain`.

---

## Konfigurationsbeispiele

### Beispiel 1: Persönlicher + eingeschränkter Familienagent

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

**Ergebnis:**

- `main`-Agent: Läuft auf dem Host, voller Werkzeugzugriff
- `family`-Agent: Läuft in Docker (ein Container pro Agent), nur das Werkzeug `read`

---

### Beispiel 2: Arbeitsagent mit geteilter Sandbox

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

### Beispiel 2b: Globales Coding-Profil + reiner Messaging-Agent

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

**Ergebnis:**

- Standardagenten erhalten Coding-Werkzeuge
- `support`-Agent ist nur für Messaging (+ Slack-Werkzeug)

---

### Beispiel 3: Unterschiedliche Sandbox-Modi pro Agent

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

## Konfigurationspriorität

Wenn sowohl globale (`agents.defaults.*`) als auch agentenspezifische (`agents.list[].*`) Konfigurationen vorhanden sind:

### Sandbox-Konfiguration

Agentenspezifische Einstellungen überschreiben globale:

```
agents.list[].sandbox.mode > agents.defaults.sandbox.mode
agents.list[].sandbox.scope > agents.defaults.sandbox.scope
agents.list[].sandbox.workspaceRoot > agents.defaults.sandbox.workspaceRoot
agents.list[].sandbox.workspaceAccess > agents.defaults.sandbox.workspaceAccess
agents.list[].sandbox.docker.* > agents.defaults.sandbox.docker.*
agents.list[].sandbox.browser.* > agents.defaults.sandbox.browser.*
agents.list[].sandbox.prune.* > agents.defaults.sandbox.prune.*
```

**Hinweise:**

- `agents.list[].sandbox.{docker,browser,prune}.*` überschreibt `agents.defaults.sandbox.{docker,browser,prune}.*` für diesen Agenten (ignoriert, wenn der Sandbox-Umfang zu `"shared"` aufgelöst wird).

### Werkzeugeinschränkungen

Die Filterreihenfolge ist:

1. **Werkzeugprofil** (`tools.profile` oder `agents.list[].tools.profile`)
2. **Anbieter-Werkzeugprofil** (`tools.byProvider[provider].profile` oder `agents.list[].tools.byProvider[provider].profile`)
3. **Globale Werkzeugrichtlinie** (`tools.allow` / `tools.deny`)
4. **Anbieter-Werkzeugrichtlinie** (`tools.byProvider[provider].allow/deny`)
5. **Agentenspezifische Werkzeugrichtlinie** (`agents.list[].tools.allow/deny`)
6. **Agenten-Anbieter-Richtlinie** (`agents.list[].tools.byProvider[provider].allow/deny`)
7. **Sandbox-Werkzeugrichtlinie** (`tools.sandbox.tools` oder `agents.list[].tools.sandbox.tools`)
8. **Subagenten-Werkzeugrichtlinie** (`tools.subagents.tools`, falls zutreffend)

Jede Ebene kann Werkzeuge weiter einschränken, aber zuvor verweigerte Werkzeuge nicht wieder freigeben.
Wenn `agents.list[].tools.sandbox.tools` gesetzt ist, ersetzt es `tools.sandbox.tools` für diesen Agenten.
Wenn `agents.list[].tools.profile` gesetzt ist, überschreibt es `tools.profile` für diesen Agenten.
Anbieter-Werkzeugschlüssel akzeptieren entweder `provider` (z. B. `google-antigravity`) oder `provider/model` (z. B. `openai/gpt-5.2`).

### Werkzeuggruppen (Kurzformen)

Werkzeugrichtlinien (global, Agent, Sandbox) unterstützen `group:*`-Einträge, die zu mehreren konkreten Werkzeugen erweitert werden:

- `group:runtime`: `exec`, `bash`, `process`
- `group:fs`: `read`, `write`, `edit`, `apply_patch`
- `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory`: `memory_search`, `memory_get`
- `group:ui`: `browser`, `canvas`
- `group:automation`: `cron`, `gateway`
- `group:messaging`: `message`
- `group:nodes`: `nodes`
- `group:openclaw`: alle integrierten OpenClaw-Werkzeuge (schließt Anbieter-Plugins aus)

### Elevated Mode

`tools.elevated` ist die globale Basislinie (senderbasierte Allowlist). `agents.list[].tools.elevated` kann Elevated für bestimmte Agenten weiter einschränken (beide müssen erlauben).

Klimaschutzmuster:

- Verweigern Sie `exec` für nicht vertrauenswürdige Agenten (`agents.list[].tools.deny: ["exec"]`)
- Vermeiden Sie das Allowlisting von Absendern, die zu eingeschränkten Agenten routen
- Deaktivieren Sie Elevated global (`tools.elevated.enabled: false`), wenn Sie nur sandboxed Ausführung wünschen
- Deaktivieren Sie Elevated pro Agent (`agents.list[].tools.elevated.enabled: false`) für sensible Profile

---

## Migration von Single Agent

**Vorher (Single Agent):**

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

**Nachher (Multi-Agent mit unterschiedlichen Profilen):**

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

Legacy-`agent.*`-Konfigurationen werden durch `openclaw doctor` migriert; bevorzugen Sie künftig `agents.defaults` + `agents.list`.

---

## Beispiele für Werkzeugeinschränkungen

### Nur-Lese-Agent

```json
{
  "tools": {
    "allow": ["read"],
    "deny": ["exec", "write", "edit", "apply_patch", "process"]
  }
}
```

### Agent für sichere Ausführung (keine Dateimodifikationen)

```json
{
  "tools": {
    "allow": ["read", "exec", "process"],
    "deny": ["write", "edit", "apply_patch", "browser", "gateway"]
  }
}
```

### Kommunikationsagent

```json
{
  "tools": {
    "allow": ["sessions_list", "sessions_send", "sessions_history", "session_status"],
    "deny": ["exec", "write", "edit", "apply_patch", "read", "browser"]
  }
}
```

---

## Häufige Stolperfalle: „non-main“

`agents.defaults.sandbox.mode: "non-main"` basiert auf `session.mainKey` (Standard `"main"`),
nicht auf der Agenten-ID. Gruppen-/Kanal-Sitzungen erhalten immer eigene Schlüssel,
werden daher als non-main behandelt und sandboxed. Wenn ein Agent niemals
sandboxed werden soll, setzen Sie `agents.list[].sandbox.mode: "off"`.

---

## Tests

Nach der Konfiguration von Multi-Agent-Sandbox und Werkzeugen:

1. **Agentenauflösung prüfen:**

   ```exec
   openclaw agents list --bindings
   ```

2. **Sandbox-Container überprüfen:**

   ```exec
   docker ps --filter "name=openclaw-sbx-"
   ```

3. **Werkzeugeinschränkungen testen:**
   - Senden Sie eine Nachricht, die eingeschränkte Werkzeuge erfordert
   - Verifizieren Sie, dass der Agent verweigerte Werkzeuge nicht verwenden kann

4. **Logs überwachen:**

   ```exec
   tail -f "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/logs/gateway.log" | grep -E "routing|sandbox|tools"
   ```

---

## Fehlerbehebung

### Agent nicht sandboxed trotz `mode: "all"`

- Prüfen Sie, ob es eine globale `agents.defaults.sandbox.mode` gibt, die dies überschreibt
- Agentenspezifische Konfiguration hat Vorrang; setzen Sie daher `agents.list[].sandbox.mode: "all"`

### Werkzeuge weiterhin verfügbar trotz Deny-Liste

- Prüfen Sie die Filterreihenfolge der Werkzeuge: global → Agent → Sandbox → Subagent
- Jede Ebene kann nur weiter einschränken, nicht wieder freigeben
- Verifizieren Sie dies mit Logs: `[tools] filtering tools for agent:${agentId}`

### Container nicht pro Agent isoliert

- Setzen Sie `scope: "agent"` in der agentenspezifischen Sandbox-Konfiguration
- Standard ist `"session"`, was einen Container pro Sitzung erstellt

---

## Siehe auch

- [Multi-Agent-Routing](/concepts/multi-agent)
- [Sandbox-Konfiguration](/gateway/configuration#agentsdefaults-sandbox)
- [Sitzungsverwaltung](/concepts/session)
