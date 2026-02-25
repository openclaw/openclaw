---
title: Skills Tool Sandbox Limitations
summary: "Einschränkungen des skills_manage Tools in Sandbox-Modus"
read_when: "Du willst skills_manage in einer Sandbox verwenden"
status: active
---

# Skills Tool Sandbox Einschränkungen

Das `skills_manage` Tool hat **kritische Einschränkungen**, wenn es in einer Sandbox läuft, auch mit `sandbox.mode: "all"` und vollständigen Berechtigungen.

## Was funktioniert NICHT in der Sandbox

### 1. Config-Datei Zugriff

**Problem:** `loadConfig()` und `writeConfigFile()` greifen auf `~/.activi/activi.json` zu, die **außerhalb** der Sandbox liegt.

```typescript
// Diese Aufrufe greifen auf Host-Dateisystem zu:
const cfg = loadConfig();  // Liest ~/.activi/activi.json vom Host
await writeConfigFile(nextConfig);  // Schreibt ~/.activi/activi.json auf Host
```

**Folge:**
- ✅ `list` und `status` funktionieren (nur lesen)
- ❌ `enable`, `disable`, `uninstall` schlagen fehl (können nicht schreiben)
- ⚠️ Tool läuft auf Host, nicht in Sandbox

### 2. Managed Skills Verzeichnis

**Problem:** Managed Skills (`~/.activi/skills`) sind **nicht** in der Sandbox verfügbar.

```typescript
// loadWorkspaceSkillEntries sucht in:
// 1. workspaceDir/skills (✅ verfügbar mit workspaceAccess: "rw")
// 2. ~/.activi/skills (❌ NICHT in Sandbox)
// 3. bundled skills (⚠️ nur wenn gemountet)
```

**Folge:**
- Skills aus `~/.activi/skills` werden nicht gefunden
- `list` zeigt nur Workspace- und Bundled-Skills

### 3. Skill Installation

**Problem:** `installSkill()` führt System-Befehle aus (`brew`, `npm`, `go`, etc.), die **außerhalb** der Sandbox laufen müssen.

```typescript
// installSkill() ruft auf:
// - brew install (braucht Host-Zugriff)
// - npm install (braucht Host-Zugriff)
// - go install (braucht Host-Zugriff)
// - Downloads (brauchen Netzwerk, aber Container hat network: "none" default)
```

**Folge:**
- ❌ `install` schlägt fehl, weil:
  - Container hat `network: "none"` (kein Internet)
  - Brew/npm/go sind nicht im Container verfügbar
  - Installationsbefehle müssen auf Host laufen

### 4. Workspace-Zugriff

**Problem:** Mit `workspaceAccess: "none"` ist der Agent-Workspace nicht verfügbar.

```typescript
const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
// Mit workspaceAccess: "none":
// - workspaceDir zeigt auf ~/.activi/sandboxes/... (Sandbox-Workspace)
// - Agent-Workspace ist nicht gemountet
```

**Folge:**
- Workspace-Skills werden nicht gefunden
- Skills können nicht in Workspace installiert werden

## Was funktioniert MIT Einschränkungen

### Mit `workspaceAccess: "rw"`

✅ **Funktioniert:**
- `list` - zeigt Workspace- und Bundled-Skills
- `status` - zeigt Status für verfügbare Skills
- `enable`/`disable` - **NUR wenn Config-Datei gemountet ist**

❌ **Funktioniert NICHT:**
- `install` - braucht Host-Zugriff für brew/npm/go
- Managed Skills werden nicht gefunden

### Mit Config-Bind Mount

Wenn du `~/.activi/activi.json` als Bind Mount hinzufügst:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        docker: {
          binds: [
            "~/.activi/activi.json:/tmp/activi-config.json:ro"  // Read-only
          ]
        }
      }
    }
  }
}
```

✅ **Funktioniert:**
- `list` - vollständig
- `status` - vollständig
- `enable`/`disable` - **NUR wenn RW-Mount** (aber gefährlich!)

❌ **Funktioniert NICHT:**
- `install` - braucht Host-Zugriff
- Managed Skills - Verzeichnis nicht verfügbar

## Empfohlene Lösung

### Option 1: Tool auf Host laufen lassen

```json5
{
  agents: {
    list: [
      {
        id: "my-agent",
        sandbox: {
          mode: "non-main"  // Main-Session auf Host
        },
        tools: {
          // skills_manage läuft auf Host
        }
      }
    ]
  }
}
```

### Option 2: Gateway API verwenden

Statt `skills_manage` Tool direkt zu nutzen, Gateway-APIs verwenden:

```typescript
// Statt skills_manage Tool:
// Gateway API calls:
// - gateway.request("skills.status")
// - gateway.request("skills.install")
// - gateway.request("skills.update")
```

Gateway läuft **immer auf Host** und kann auf alle Ressourcen zugreifen.

### Option 3: Sandbox mit speziellen Bind Mounts

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "all",
        workspaceAccess: "rw",
        docker: {
          network: "bridge",  // Für Downloads
          binds: [
            "~/.activi/skills:/managed-skills:ro",  // Managed Skills
            "/usr/local/bin:/host-bin:ro",  // Brew/npm (nur lesen)
            "~/.activi/activi.json:/config.json:rw"  // Config (gefährlich!)
          ]
        }
      }
    }
  }
}
```

⚠️ **Warnung:** RW-Config-Mount erlaubt Sandbox, Config zu ändern (Sicherheitsrisiko!)

## Zusammenfassung

| Feature | Sandbox `workspaceAccess: "none"` | Sandbox `workspaceAccess: "rw"` | Host |
|---------|-----------------------------------|----------------------------------|------|
| `list` | ⚠️ Nur Bundled | ✅ Workspace + Bundled | ✅ Alle |
| `status` | ⚠️ Nur Bundled | ✅ Workspace + Bundled | ✅ Alle |
| `enable` | ❌ Kein Config-Zugriff | ⚠️ Nur mit Config-Mount | ✅ |
| `disable` | ❌ Kein Config-Zugriff | ⚠️ Nur mit Config-Mount | ✅ |
| `install` | ❌ Kein Netzwerk/Host | ❌ Kein Netzwerk/Host | ✅ |
| `uninstall` | ❌ Kein Config-Zugriff | ⚠️ Nur mit Config-Mount | ✅ |

**Empfehlung:** `skills_manage` Tool sollte **nicht** in Sandbox verwendet werden. Nutze stattdessen Gateway-APIs oder lasse das Tool auf Host laufen.
