---
title: Skills Tool Sicherheitsvorkehrungen
summary: "Sicherheitsmechanismen für skills_manage Tool mit Gateway-APIs"
read_when: "Du willst das skills_manage Tool sicher konfigurieren"
status: active
---

# Skills Tool Sicherheitsvorkehrungen

## Übersicht

Wenn das `skills_manage` Tool Gateway-APIs nutzt, greifen **mehrere Sicherheitsebenen**:

1. **Gateway-Authentifizierung** (Token/Password)
2. **Operator Scopes** (READ/WRITE/ADMIN)
3. **Rate Limiting** (für kritische Operationen)
4. **Tool Policy** (Agent-Level Allow/Deny)
5. **Owner-Only Tools** (nur für Owner)
6. **Sandbox-Isolation** (falls aktiv)

## 1. Gateway-Authentifizierung

**Schutz:** Verhindert unautorisierte Gateway-Zugriffe.

### Konfiguration

```json5
{
  gateway: {
    auth: {
      mode: "token",  // oder "password", "none"
      token: "dein-langer-zufaelliger-token"  // min. 32 Zeichen
    }
  }
}
```

**Empfehlungen:**
- ✅ **Token-Modus** mit langem Token (min. 32 Zeichen)
- ✅ **Nie** `mode: "none"` bei Netzwerk-Exposition
- ✅ Token regelmäßig rotieren
- ✅ Token nicht in Logs/Code committen

**Für Skills Tool:**
- Gateway-Token wird automatisch aus Config geladen
- Agent muss Gateway-URL kennen (Standard: `ws://127.0.0.1:18789`)
- Remote-Gateway-URLs müssen explizit erlaubt sein

## 2. Operator Scopes

**Schutz:** Begrenzt welche Gateway-Methoden ein Agent aufrufen kann.

### Scope-Hierarchie

| Scope | Beschreibung | Skills-Methoden |
|-------|--------------|-----------------|
| `operator.read` | Nur Lesen | `skills.status`, `skills.bins` |
| `operator.write` | Lesen + Schreiben | - |
| `operator.admin` | Vollzugriff | `skills.install`, `skills.update`, `skills.uninstall` |

### Skills-Methoden Scopes

```typescript
// src/gateway/method-scopes.ts
[READ_SCOPE]: [
  "skills.status",  // ✅ Lesen erlaubt
  // ...
],
[ADMIN_SCOPE]: [
  "skills.install",   // ⚠️ Nur Admin
  "skills.update",    // ⚠️ Nur Admin
  "skills.uninstall", // ⚠️ Nur Admin
  // ...
]
```

**Implikation:**
- `skills.status` → `READ_SCOPE` (weniger restriktiv)
- `skills.install/update/uninstall` → `ADMIN_SCOPE` (sehr restriktiv)

### Agent-Scope-Konfiguration

**Standard:** Agents haben **keine** Gateway-Scopes → Gateway-APIs blockiert

**Erlauben:**

```json5
{
  agents: {
    list: [
      {
        id: "my-agent",
        // Gateway-Scopes für diesen Agent
        gateway: {
          scopes: ["operator.read", "operator.admin"]  // Explizit erlauben
        }
      }
    ]
  }
}
```

**Empfehlung:**
- ✅ **Minimal:** Nur `operator.read` für `skills.status`
- ⚠️ **Vorsichtig:** `operator.admin` nur für vertrauenswürdige Agents
- ❌ **Nie:** Alle Scopes für alle Agents

## 3. Rate Limiting

**Schutz:** Verhindert Missbrauch durch zu viele Anfragen.

### Control-Plane Write Rate Limit

```typescript
// src/gateway/server-methods.ts
const CONTROL_PLANE_WRITE_METHODS = new Set([
  "config.apply",
  "config.patch",
  "update.run",
  // skills.install/update/uninstall sind NICHT rate-limited
]);
```

**Aktuell:** Skills-Methoden sind **nicht** rate-limited.

**Empfehlung für zukünftige Implementierung:**

```typescript
// Vorschlag: Rate Limit für skills.install
const SKILLS_INSTALL_RATE_LIMIT = {
  maxRequests: 5,
  windowMs: 60_000,  // 5 pro Minute
};
```

### Auth Rate Limiting

Gateway-Auth hat bereits Rate Limiting:

```typescript
// src/gateway/auth-rate-limit.ts
// Standard: 5 Fehlversuche → 15min Block
```

**Schutz:** Verhindert Brute-Force auf Gateway-Auth.

## 4. Tool Policy

**Schutz:** Kontrolliert welche Tools ein Agent verwenden kann.

### Tool Allow/Deny

```json5
{
  agents: {
    list: [
      {
        id: "my-agent",
        tools: {
          allow: ["skills_manage"],  // Explizit erlauben
          deny: ["gateway", "exec"],  // Andere Tools blockieren
        }
      }
    ]
  }
}
```

### Tool Profiles

```json5
{
  tools: {
    profile: "messaging",  // Minimal-Profil
    // Oder:
    profile: "minimal",    // Sehr restriktiv
    profile: "coding",     // Mehr Tools
  }
}
```

**Profiles und Skills:**

| Profile | `skills_manage` verfügbar? |
|---------|---------------------------|
| `minimal` | ❌ Nein |
| `messaging` | ⚠️ Optional |
| `coding` | ✅ Ja |
| `full` | ✅ Ja |

### Owner-Only Tools

**Schutz:** Bestimmte Tools nur für Owner.

```typescript
// src/agents/tools/gateway-tool.ts
export function createGatewayTool(...): AnyAgentTool {
  return {
    ownerOnly: true,  // ⚠️ Nur Owner können verwenden
    // ...
  };
}
```

**Empfehlung für `skills_manage`:**

```typescript
// Option 1: Owner-Only (wie gateway Tool)
export function createSkillsTool(...): AnyAgentTool {
  return {
    ownerOnly: true,  // Nur Owner
    // ...
  };
}

// Option 2: Konfigurierbar
export function createSkillsTool(options?: {
  ownerOnly?: boolean;  // Default: true
}): AnyAgentTool {
  return {
    ownerOnly: options?.ownerOnly ?? true,
    // ...
  };
}
```

## 5. Sandbox-Isolation

**Schutz:** Isoliert Tool-Ausführung in Docker-Container.

### Sandbox-Modi

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "all",  // Alle Sessions in Sandbox
        // Oder:
        mode: "non-main",  // Nur non-main Sessions
        // Oder:
        mode: "off",  // Keine Sandbox
      }
    }
  }
}
```

**Für Skills Tool:**
- ✅ Tool nutzt Gateway-APIs → läuft auf Host (nicht in Sandbox)
- ✅ Gateway-APIs sind sandbox-unabhängig
- ⚠️ Aber: Gateway selbst läuft auf Host

### Workspace Access

```json5
{
  agents: {
    defaults: {
      sandbox: {
        workspaceAccess: "none",  // Kein Workspace-Zugriff
        // Oder:
        workspaceAccess: "ro",    // Read-only
        // Oder:
        workspaceAccess: "rw",    // Read-write
      }
    }
  }
}
```

**Für Skills Tool:**
- Mit Gateway-APIs: Workspace-Access irrelevant (Gateway läuft auf Host)
- Alte Implementierung: Braucht `workspaceAccess: "rw"` für Config-Schreibzugriff

## 6. Zusätzliche Sicherheitsvorkehrungen

### Skill-Installation Validierung

**Schutz:** Verhindert Installation von schädlichen Skills.

**Bereits implementiert:**

```typescript
// src/agents/skills-install.ts
// - Skill muss existieren (in workspace/managed/bundled)
// - Install-Spec muss gültig sein
// - Timeout-Limits (max 15min)
```

**Empfehlungen:**

1. **Skill-Quelle validieren:**
   ```typescript
   // Nur Skills aus vertrauenswürdigen Quellen erlauben
   const allowedSources = ["bundled", "managed"];
   if (!allowedSources.includes(skill.source)) {
     throw new Error("Skill source not allowed");
   }
   ```

2. **Install-Befehle validieren:**
   ```typescript
   // Nur bestimmte Install-Methoden erlauben
   const allowedInstallIds = ["brew", "npm"];
   if (!allowedInstallIds.includes(installId)) {
     throw new Error("Install method not allowed");
   }
   ```

### Config-Schreibzugriff

**Schutz:** Verhindert unerlaubte Config-Änderungen.

**Gateway-API `skills.update`:**

```typescript
// src/gateway/server-methods/skills.ts
// - Validiert skillKey
// - Validiert Parameter (enabled, apiKey, env)
// - Schreibt nur skills.entries, nicht gesamte Config
```

**Sicherheit:**
- ✅ Nur `skills.entries` wird geändert
- ✅ Andere Config-Bereiche bleiben unberührt
- ✅ Config-Snapshot-Hash für Validierung

### Audit-Logging

**Schutz:** Nachvollziehbarkeit von Änderungen.

**Empfehlung:**

```typescript
// Gateway-Logs enthalten bereits:
// - Method-Aufruf (skills.install, skills.update, etc.)
// - Agent-ID
// - Timestamp
// - Erfolg/Fehler

// Zusätzlich loggen:
log.info("skills_manage: install", {
  agentId,
  skillName,
  installId,
  success: result.ok,
});
```

## 7. Empfohlene Sicherheitskonfiguration

### Minimal (Sicherste)

```json5
{
  gateway: {
    auth: {
      mode: "token",
      token: "mindestens-32-zeichen-langer-zufaelliger-token"
    },
    bind: "loopback",  // Nur localhost
  },
  agents: {
    list: [
      {
        id: "trusted-agent",
        tools: {
          allow: ["skills_manage"],
        },
        gateway: {
          scopes: ["operator.read"],  // Nur Lesen
        }
      }
    ]
  },
  tools: {
    profile: "minimal",
  }
}
```

### Moderate (Ausgewogen)

```json5
{
  gateway: {
    auth: {
      mode: "token",
      token: "mindestens-32-zeichen-langer-zufaelliger-token"
    },
  },
  agents: {
    list: [
      {
        id: "trusted-agent",
        tools: {
          allow: ["skills_manage"],
        },
        gateway: {
          scopes: ["operator.read", "operator.admin"],  // Lesen + Admin
        }
      }
    ]
  },
  tools: {
    profile: "coding",
  }
}
```

### Permissive (Nur für vertrauenswürdige Umgebungen)

```json5
{
  gateway: {
    auth: {
      mode: "token",
      token: "mindestens-32-zeichen-langer-zufaelliger-token"
    },
  },
  agents: {
    defaults: {
      gateway: {
        scopes: ["operator.read", "operator.admin"],
      }
    }
  },
  tools: {
    profile: "full",
  }
}
```

## 8. Sicherheits-Checkliste

Vor Produktionseinsatz:

- [ ] Gateway-Auth konfiguriert (`gateway.auth.mode: "token"`)
- [ ] Langes Token generiert (min. 32 Zeichen)
- [ ] Gateway nur auf Loopback gebunden (oder mit Auth bei LAN)
- [ ] Agent-Scopes minimal konfiguriert (`operator.read` für Status, `operator.admin` nur wenn nötig)
- [ ] Tool Policy restriktiv (`tools.profile: "minimal"` oder explizite Allow-Liste)
- [ ] `skills_manage` als `ownerOnly: true` markiert (falls implementiert)
- [ ] Sandbox aktiviert für nicht-vertrauenswürdige Agents (`sandbox.mode: "all"`)
- [ ] Audit-Logging aktiviert (`logging.redactSensitive: false` für Debug, `true` für Prod)
- [ ] `activi security audit` ausgeführt und alle kritischen Findings behoben

## 9. Monitoring & Alerts

**Empfohlene Metriken:**

1. **Skills-Installationen:**
   - Anzahl pro Agent/Zeit
   - Erfolgsrate
   - Fehlerrate

2. **Gateway-API-Aufrufe:**
   - Rate pro Agent
   - Scope-Verletzungen
   - Auth-Fehler

3. **Config-Änderungen:**
   - Häufigkeit von `skills.update`
   - Geänderte Skill-Keys

**Alert-Schwellen:**

- ⚠️ Mehr als 10 Skills-Installationen pro Stunde
- ⚠️ Mehr als 5 fehlgeschlagene Auth-Versuche
- ⚠️ Scope-Verletzung (Agent versucht Admin-Methode ohne Admin-Scope)

## Zusammenfassung

**Mehrschichtige Sicherheit:**

1. **Gateway-Auth** → Verhindert unautorisierte Verbindungen
2. **Operator Scopes** → Begrenzt Gateway-Methoden-Zugriff
3. **Tool Policy** → Kontrolliert Tool-Verfügbarkeit
4. **Owner-Only** → Beschränkt kritische Tools auf Owner
5. **Sandbox** → Isoliert Tool-Ausführung (für andere Tools)
6. **Rate Limiting** → Verhindert Missbrauch
7. **Audit-Logging** → Nachvollziehbarkeit

**Empfehlung:** Starte mit minimaler Konfiguration und erweitere schrittweise basierend auf Vertrauen und Anforderungen.
