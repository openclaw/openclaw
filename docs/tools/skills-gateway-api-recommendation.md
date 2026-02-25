---
title: Skills Tool Gateway API Empfehlung
summary: "Empfehlung: skills_manage Tool sollte Gateway-APIs nutzen statt direkten Dateisystem-Zugriff"
read_when: "Du willst das skills_manage Tool sandbox-kompatibel machen"
status: active
---

# Skills Tool Gateway API Empfehlung

## Problem

Das aktuelle `skills_manage` Tool greift direkt auf das Dateisystem zu:
- `loadConfig()` / `writeConfigFile()` → `~/.activi/activi.json` (außerhalb Sandbox)
- `loadWorkspaceSkillEntries()` → Managed Skills nicht verfügbar
- `installSkill()` → Braucht Host-Zugriff für brew/npm/go

**Folge:** Tool funktioniert nicht in Sandbox, auch mit `sandbox.mode: "all"`.

## Lösung: Gateway-APIs nutzen

Es gibt bereits ein **`gateway` Tool**, das Agents erlaubt, Gateway-RPC-Methoden aufzurufen.

### Verfügbare Gateway-APIs für Skills

| Gateway-Methode | Beschreibung | Entspricht Tool-Action |
|-----------------|--------------|------------------------|
| `skills.status` | Status aller Skills abrufen | `list`, `status` |
| `skills.bins` | Liste benötigter Binaries | - |
| `skills.install` | Skill installieren | `install` |
| `skills.update` | Skill konfigurieren (enable/disable, apiKey, env) | `enable`, `disable` |
| `skills.uninstall` | Skill deaktivieren | `uninstall` |

### Gateway-Tool Verwendung

Das `gateway` Tool ist bereits verfügbar für Agents:

```typescript
// Beispiel: Gateway-Tool Aufruf
{
  "tool": "gateway",
  "method": "skills.status",
  "params": {
    "agentId": "my-agent"  // optional
  }
}
```

## Empfohlene Umstellung

### Option 1: Tool umbauen (Gateway-APIs nutzen)

**Vorteile:**
- ✅ Funktioniert in Sandbox (Gateway läuft auf Host)
- ✅ Konsistente API-Nutzung
- ✅ Keine direkten Dateisystem-Zugriffe

**Nachteile:**
- ⚠️ Tool wird zu einem Gateway-API-Wrapper
- ⚠️ Agent muss Gateway-URL/Token kennen

**Implementierung:**

```typescript
// src/agents/tools/skills-tool.ts (vereinfacht)
export function createSkillsTool(options?: SkillsToolOptions): AnyAgentTool {
  return createTool({
    name: "skills_manage",
    description: "Manage skills via Gateway API...",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "status", "install", "enable", "disable", "uninstall"] },
        skillName: { type: "string" },
        installId: { type: "string" },
        agentId: { type: "string" },
      },
      required: ["action"],
    },
    execute: async (args) => {
      const gateway = resolveGatewayOptions(options);
      
      switch (args.action) {
        case "list":
        case "status": {
          const result = await callGatewayTool("skills.status", gateway, {
            agentId: args.agentId,
          });
          return result;
        }
        
        case "install": {
          const result = await callGatewayTool("skills.install", gateway, {
            name: args.skillName,
            installId: args.installId,
          });
          return result;
        }
        
        case "enable":
        case "disable": {
          // Zuerst skillKey finden via skills.status
          const status = await callGatewayTool("skills.status", gateway, {
            agentId: args.agentId,
          });
          const skill = status?.skills?.find(s => s.name === args.skillName);
          if (!skill) {
            return { ok: false, message: `Skill not found: ${args.skillName}` };
          }
          
          const result = await callGatewayTool("skills.update", gateway, {
            skillKey: skill.skillKey || args.skillName,
            enabled: args.action === "enable",
          });
          return result;
        }
        
        case "uninstall": {
          // Ähnlich wie enable/disable
          const status = await callGatewayTool("skills.status", gateway, {
            agentId: args.agentId,
          });
          const skill = status?.skills?.find(s => s.name === args.skillName);
          if (!skill) {
            return { ok: false, message: `Skill not found: ${args.skillName}` };
          }
          
          const result = await callGatewayTool("skills.uninstall", gateway, {
            skillKey: skill.skillKey || args.skillName,
          });
          return result;
        }
      }
    },
  });
}
```

### Option 2: Gateway-Tool direkt verwenden (kein neues Tool)

**Vorteile:**
- ✅ Keine Code-Änderungen nötig
- ✅ Gateway-Tool bereits verfügbar
- ✅ Funktioniert sofort

**Nachteile:**
- ⚠️ Agent muss Gateway-API-Struktur kennen
- ⚠️ Weniger benutzerfreundlich

**System-Prompt Anpassung:**

```typescript
// src/agents/system-prompt.ts
const coreToolSummaries: Record<string, string> = {
  // ...
  gateway: "Call Gateway APIs: skills.status, skills.install, skills.update, skills.uninstall for skill management",
  // skills_manage entfernen oder als deprecated markieren
};
```

### Option 3: Hybrid (Gateway-APIs + Fallback)

**Vorteile:**
- ✅ Funktioniert in Sandbox (Gateway-APIs)
- ✅ Fallback auf direkten Zugriff wenn Gateway nicht verfügbar
- ✅ Beste Kompatibilität

**Nachteile:**
- ⚠️ Komplexere Implementierung
- ⚠️ Zwei Code-Pfade zu warten

## Empfehlung: Option 1

**Warum:**
1. Gateway läuft **immer auf Host** → Sandbox-kompatibel
2. Konsistente API-Nutzung
3. Einfacheres Warten (ein Code-Pfad)
4. Bessere Fehlerbehandlung (Gateway-APIs haben validierte Parameter)

**Migration:**
1. Tool umbauen auf Gateway-APIs
2. Alte Implementierung als Fallback behalten (für nicht-Sandbox-Umgebungen)
3. System-Prompt aktualisieren

## Gateway-API Details

### `skills.status`

```typescript
// Request
{
  method: "skills.status",
  params: {
    agentId?: string  // optional, default: current agent
  }
}

// Response
{
  ok: true,
  skills: [
    {
      name: "skill-name",
      skillKey: "skill-key",
      enabled: true,
      source: "bundled" | "managed" | "workspace",
      // ...
    }
  ]
}
```

### `skills.install`

```typescript
// Request
{
  method: "skills.install",
  params: {
    name: "skill-name",
    installId: "brew" | "npm" | "download",
    timeoutMs?: number
  }
}

// Response
{
  ok: true,
  message: "Successfully installed...",
  stdout: "...",
  stderr: "..."
}
```

### `skills.update`

```typescript
// Request
{
  method: "skills.update",
  params: {
    skillKey: "skill-key",
    enabled?: boolean,
    apiKey?: string,
    env?: Record<string, string>
  }
}

// Response
{
  ok: true,
  skillKey: "skill-key",
  config: { enabled: true, ... }
}
```

### `skills.uninstall`

```typescript
// Request
{
  method: "skills.uninstall",
  params: {
    skillKey: "skill-key"
  }
}

// Response
{
  ok: true,
  skillKey: "skill-key",
  message: "Skill disabled"
}
```

## Implementierungs-Checkliste

- [ ] Tool umbauen auf `callGatewayTool()` statt direkter Dateisystem-Zugriffe
- [ ] `resolveGatewayOptions()` nutzen für Gateway-URL/Token
- [ ] `skillKey` Mapping implementieren (name → skillKey via `skills.status`)
- [ ] Fehlerbehandlung für Gateway-API-Fehler
- [ ] System-Prompt aktualisieren
- [ ] Tests anpassen (Gateway-Mocks)
- [ ] Dokumentation aktualisieren

## Referenzen

- Gateway-APIs: `src/gateway/server-methods/skills.ts`
- Gateway-Tool: `src/agents/tools/gateway-tool.ts`
- Gateway-Call-Helper: `src/agents/tools/gateway.ts`
