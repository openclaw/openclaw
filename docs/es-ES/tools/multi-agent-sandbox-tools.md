---
summary: "Sandbox por agente + restricciones de herramientas, precedencia y ejemplos"
title: Sandbox Multi-Agente y Herramientas
read_when: "Quieres sandboxing por agente o políticas de allow/deny de herramientas por agente en un gateway multi-agente."
status: active
---

# Configuración de Sandbox Multi-Agente y Herramientas

## Descripción General

Cada agente en una configuración multi-agente ahora puede tener su propio:

- **Configuración de sandbox** (`agents.list[].sandbox` anula `agents.defaults.sandbox`)
- **Restricciones de herramientas** (`tools.allow` / `tools.deny`, más `agents.list[].tools`)

Esto te permite ejecutar múltiples agentes con diferentes perfiles de seguridad:

- Asistente personal con acceso completo
- Agentes de familia/trabajo con herramientas restringidas
- Agentes de cara al público en sandboxes

`setupCommand` pertenece bajo `sandbox.docker` (global o por agente) y se ejecuta una vez cuando se crea el contenedor.

La autenticación es por agente: cada agente lee desde su propio almacén de autenticación `agentDir` en:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

Las credenciales **no** se comparten entre agentes. Nunca reutilices `agentDir` entre agentes. Si quieres compartir credenciales, copia `auth-profiles.json` en el `agentDir` del otro agente.

Para cómo se comporta el sandboxing en tiempo de ejecución, ver [Sandboxing](/gateway/sandboxing).
Para depurar "¿por qué está bloqueado esto?", ver [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) y `openclaw sandbox explain`.

---

## Ejemplos de Configuración

### Ejemplo 1: Agente Personal + Familiar Restringido

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "default": true,
        "name": "Asistente Personal",
        "workspace": "~/.openclaw/workspace",
        "sandbox": { "mode": "off" }
      },
      {
        "id": "family",
        "name": "Bot Familiar",
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

**Resultado:**

- Agente `main`: Se ejecuta en el host, acceso completo a herramientas
- Agente `family`: Se ejecuta en Docker (un contenedor por agente), solo herramienta `read`

---

### Ejemplo 2: Agente de Trabajo con Sandbox Compartido

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

### Ejemplo 2b: Perfil de codificación global + agente solo de mensajería

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

**Resultado:**

- los agentes predeterminados obtienen herramientas de codificación
- el agente `support` es solo de mensajería (+ herramienta Slack)

---

### Ejemplo 3: Diferentes Modos de Sandbox por Agente

```json
{
  "agents": {
    "defaults": {
      "sandbox": {
        "mode": "non-main", // Predeterminado global
        "scope": "session"
      }
    },
    "list": [
      {
        "id": "main",
        "workspace": "~/.openclaw/workspace",
        "sandbox": {
          "mode": "off" // Anular: main nunca en sandbox
        }
      },
      {
        "id": "public",
        "workspace": "~/.openclaw/workspace-public",
        "sandbox": {
          "mode": "all", // Anular: public siempre en sandbox
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

## Precedencia de Configuración

Cuando existen configuraciones globales (`agents.defaults.*`) y específicas del agente (`agents.list[].*`):

### Configuración de Sandbox

Las configuraciones específicas del agente anulan las globales:

```
agents.list[].sandbox.mode > agents.defaults.sandbox.mode
agents.list[].sandbox.scope > agents.defaults.sandbox.scope
agents.list[].sandbox.workspaceRoot > agents.defaults.sandbox.workspaceRoot
agents.list[].sandbox.workspaceAccess > agents.defaults.sandbox.workspaceAccess
agents.list[].sandbox.docker.* > agents.defaults.sandbox.docker.*
agents.list[].sandbox.browser.* > agents.defaults.sandbox.browser.*
agents.list[].sandbox.prune.* > agents.defaults.sandbox.prune.*
```

**Notas:**

- `agents.list[].sandbox.{docker,browser,prune}.*` anula `agents.defaults.sandbox.{docker,browser,prune}.*` para ese agente (ignorado cuando el alcance del sandbox se resuelve a `"shared"`).

### Restricciones de Herramientas

El orden de filtrado es:

1. **Perfil de herramienta** (`tools.profile` o `agents.list[].tools.profile`)
2. **Perfil de herramienta del proveedor** (`tools.byProvider[provider].profile` o `agents.list[].tools.byProvider[provider].profile`)
3. **Política de herramienta global** (`tools.allow` / `tools.deny`)
4. **Política de herramienta del proveedor** (`tools.byProvider[provider].allow/deny`)
5. **Política de herramienta específica del agente** (`agents.list[].tools.allow/deny`)
6. **Política del proveedor del agente** (`agents.list[].tools.byProvider[provider].allow/deny`)
7. **Política de herramienta del sandbox** (`tools.sandbox.tools` o `agents.list[].tools.sandbox.tools`)
8. **Política de herramienta del subagente** (`tools.subagents.tools`, si aplica)

Cada nivel puede restringir más las herramientas, pero no puede otorgar de vuelta herramientas denegadas de niveles anteriores.
Si se establece `agents.list[].tools.sandbox.tools`, reemplaza `tools.sandbox.tools` para ese agente.
Si se establece `agents.list[].tools.profile`, anula `tools.profile` para ese agente.
Las claves de herramienta del proveedor aceptan ya sea `provider` (ej. `google-antigravity`) o `provider/model` (ej. `openai/gpt-5.2`).

### Grupos de herramientas (atajos)

Las políticas de herramientas (global, agente, sandbox) soportan entradas `group:*` que se expanden a múltiples herramientas concretas:

- `group:runtime`: `exec`, `bash`, `process`
- `group:fs`: `read`, `write`, `edit`, `apply_patch`
- `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory`: `memory_search`, `memory_get`
- `group:ui`: `browser`, `canvas`
- `group:automation`: `cron`, `gateway`
- `group:messaging`: `message`
- `group:nodes`: `nodes`
- `group:openclaw`: todas las herramientas incorporadas de OpenClaw (excluye plugins de proveedores)

### Modo Elevado

`tools.elevated` es la línea base global (lista blanca basada en remitente). `agents.list[].tools.elevated` puede restringir más el modo elevado para agentes específicos (ambos deben permitir).

Patrones de mitigación:

- Denegar `exec` para agentes no confiables (`agents.list[].tools.deny: ["exec"]`)
- Evitar agregar a la lista blanca remitentes que enrutan a agentes restringidos
- Deshabilitar el modo elevado globalmente (`tools.elevated.enabled: false`) si solo quieres ejecución en sandbox
- Deshabilitar el modo elevado por agente (`agents.list[].tools.elevated.enabled: false`) para perfiles sensibles

---

## Migración desde Agente Único

**Antes (agente único):**

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

**Después (multi-agente con diferentes perfiles):**

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

Las configuraciones `agent.*` heredadas son migradas por `openclaw doctor`; prefiere `agents.defaults` + `agents.list` en adelante.

---

## Ejemplos de Restricción de Herramientas

### Agente Solo Lectura

```json
{
  "tools": {
    "allow": ["read"],
    "deny": ["exec", "write", "edit", "apply_patch", "process"]
  }
}
```

### Agente de Ejecución Segura (sin modificaciones de archivos)

```json
{
  "tools": {
    "allow": ["read", "exec", "process"],
    "deny": ["write", "edit", "apply_patch", "browser", "gateway"]
  }
}
```

### Agente Solo de Comunicación

```json
{
  "tools": {
    "sessions": { "visibility": "tree" },
    "allow": ["sessions_list", "sessions_send", "sessions_history", "session_status"],
    "deny": ["exec", "write", "edit", "apply_patch", "read", "browser"]
  }
}
```

---

## Trampa Común: "non-main"

`agents.defaults.sandbox.mode: "non-main"` se basa en `session.mainKey` (predeterminado `"main"`), no en el id del agente. Las sesiones de grupo/canal siempre obtienen sus propias claves, por lo que se tratan como no-main y estarán en sandbox. Si quieres que un agente nunca esté en sandbox, establece `agents.list[].sandbox.mode: "off"`.

---

## Pruebas

Después de configurar sandbox multi-agente y herramientas:

1. **Verificar resolución de agente:**

   ```exec
   openclaw agents list --bindings
   ```

2. **Verificar contenedores sandbox:**

   ```exec
   docker ps --filter "name=openclaw-sbx-"
   ```

3. **Probar restricciones de herramientas:**
   - Envía un mensaje que requiera herramientas restringidas
   - Verifica que el agente no pueda usar herramientas denegadas

4. **Monitorear logs:**

   ```exec
   tail -f "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/logs/gateway.log" | grep -E "routing|sandbox|tools"
   ```

---

## Solución de Problemas

### Agente no en sandbox a pesar de `mode: "all"`

- Verifica si hay un `agents.defaults.sandbox.mode` global que lo anule
- La configuración específica del agente tiene precedencia, así que establece `agents.list[].sandbox.mode: "all"`

### Herramientas aún disponibles a pesar de la lista de denegación

- Verifica el orden de filtrado de herramientas: global → agente → sandbox → subagente
- Cada nivel solo puede restringir más, no otorgar de vuelta
- Verifica con logs: `[tools] filtering tools for agent:${agentId}`

### Contenedor no aislado por agente

- Establece `scope: "agent"` en la configuración de sandbox específica del agente
- El predeterminado es `"session"` que crea un contenedor por sesión

---

## Ver También

- [Enrutamiento Multi-Agente](/concepts/multi-agent)
- [Configuración de Sandbox](/gateway/configuration#agentsdefaults-sandbox)
- [Gestión de Sesiones](/concepts/session)
