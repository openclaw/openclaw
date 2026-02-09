---
summary: "Difunda un mensaje de WhatsApp a múltiples agentes"
read_when:
  - Configuración de grupos de difusión
  - Depuración de respuestas de múltiples agentes en WhatsApp
status: experimental
title: "Grupos de difusión"
---

# Grupos de difusión

**Estado:** Experimental  
**Versión:** Añadido en 2026.1.9

## Descripción general

Los Grupos de difusión permiten que múltiples agentes procesen y respondan al mismo mensaje de forma simultánea. Esto le permite crear equipos de agentes especializados que trabajan juntos en un único grupo de WhatsApp o mensaje directo (DM), todo usando un solo número de teléfono.

Alcance actual: **solo WhatsApp** (canal web).

Los grupos de difusión se evalúan después de las listas de permitidos del canal y las reglas de activación de grupos. En grupos de WhatsApp, esto significa que las difusiones ocurren cuando OpenClaw normalmente respondería (por ejemplo: al mencionar, según la configuración del grupo).

## Casos de uso

### 1. Equipos de agentes especializados

Despliegue múltiples agentes con responsabilidades atómicas y enfocadas:

```
Group: "Development Team"
Agents:
  - CodeReviewer (reviews code snippets)
  - DocumentationBot (generates docs)
  - SecurityAuditor (checks for vulnerabilities)
  - TestGenerator (suggests test cases)
```

Cada agente procesa el mismo mensaje y aporta su perspectiva especializada.

### 2. Soporte multilingüe

```
Group: "International Support"
Agents:
  - Agent_EN (responds in English)
  - Agent_DE (responds in German)
  - Agent_ES (responds in Spanish)
```

### 3. Flujos de trabajo de aseguramiento de calidad

```
Group: "Customer Support"
Agents:
  - SupportAgent (provides answer)
  - QAAgent (reviews quality, only responds if issues found)
```

### 4. Automatización de tareas

```
Group: "Project Management"
Agents:
  - TaskTracker (updates task database)
  - TimeLogger (logs time spent)
  - ReportGenerator (creates summaries)
```

## Configuración

### Configuración básica

Agregue una sección de nivel superior `broadcast` (junto a `bindings`). Las claves son IDs de pares de WhatsApp:

- chats grupales: JID del grupo (p. ej., `120363403215116621@g.us`)
- DMs: número telefónico E.164 (p. ej., `+15551234567`)

```json
{
  "broadcast": {
    "120363403215116621@g.us": ["alfred", "baerbel", "assistant3"]
  }
}
```

**Resultado:** Cuando OpenClaw respondería en este chat, ejecutará los tres agentes.

### Estrategia de procesamiento

Controle cómo los agentes procesan los mensajes:

#### Paralelo (predeterminado)

Todos los agentes procesan simultáneamente:

```json
{
  "broadcast": {
    "strategy": "parallel",
    "120363403215116621@g.us": ["alfred", "baerbel"]
  }
}
```

#### Secuencial

Los agentes procesan en orden (uno espera a que el anterior termine):

```json
{
  "broadcast": {
    "strategy": "sequential",
    "120363403215116621@g.us": ["alfred", "baerbel"]
  }
}
```

### Ejemplo completo

```json
{
  "agents": {
    "list": [
      {
        "id": "code-reviewer",
        "name": "Code Reviewer",
        "workspace": "/path/to/code-reviewer",
        "sandbox": { "mode": "all" }
      },
      {
        "id": "security-auditor",
        "name": "Security Auditor",
        "workspace": "/path/to/security-auditor",
        "sandbox": { "mode": "all" }
      },
      {
        "id": "docs-generator",
        "name": "Documentation Generator",
        "workspace": "/path/to/docs-generator",
        "sandbox": { "mode": "all" }
      }
    ]
  },
  "broadcast": {
    "strategy": "parallel",
    "120363403215116621@g.us": ["code-reviewer", "security-auditor", "docs-generator"],
    "120363424282127706@g.us": ["support-en", "support-de"],
    "+15555550123": ["assistant", "logger"]
  }
}
```

## Cómo funciona

### Flujo de mensajes

1. **Mensaje entrante** llega a un grupo de WhatsApp
2. **Verificación de difusión**: el sistema comprueba si el ID del par está en `broadcast`
3. **Si está en la lista de difusión**:
   - Todos los agentes listados procesan el mensaje
   - Cada agente tiene su propia clave de sesión y contexto aislado
   - Los agentes procesan en paralelo (predeterminado) o de forma secuencial
4. **Si no está en la lista de difusión**:
   - Se aplica el enrutamiento normal (primer enlace coincidente)

Nota: los grupos de difusión no eluden las listas de permitidos del canal ni las reglas de activación de grupos (menciones/comandos/etc.). Solo cambian _qué agentes se ejecutan_ cuando un mensaje es elegible para procesamiento.

### Aislamiento de sesiones

Cada agente en un grupo de difusión mantiene completamente separado:

- **Claves de sesión** (`agent:alfred:whatsapp:group:120363...` vs `agent:baerbel:whatsapp:group:120363...`)
- **Historial de conversación** (el agente no ve los mensajes de otros agentes)
- **Espacio de trabajo** (sandboxes separadas si están configuradas)
- **Acceso a herramientas** (listas de permitir/denegar diferentes)
- **Memoria/contexto** (IDENTITY.md, SOUL.md, etc. separados)
- **Búfer de contexto del grupo** (mensajes recientes del grupo usados como contexto) se comparte por par, por lo que todos los agentes de difusión ven el mismo contexto cuando se activan

Esto permite que cada agente tenga:

- Diferentes personalidades
- Diferente acceso a herramientas (p. ej., solo lectura vs. lectura-escritura)
- Diferentes modelos (p. ej., opus vs. sonnet)
- Diferentes Skills instaladas

### Ejemplo: sesiones aisladas

En el grupo `120363403215116621@g.us` con los agentes `["alfred", "baerbel"]`:

**Contexto de Alfred:**

```
Session: agent:alfred:whatsapp:group:120363403215116621@g.us
History: [user message, alfred's previous responses]
Workspace: /Users/pascal/openclaw-alfred/
Tools: read, write, exec
```

**Contexto de Bärbel:**

```
Session: agent:baerbel:whatsapp:group:120363403215116621@g.us
History: [user message, baerbel's previous responses]
Workspace: /Users/pascal/openclaw-baerbel/
Tools: read only
```

## Buenas prácticas

### 1. Mantenga a los agentes enfocados

Diseñe cada agente con una responsabilidad única y clara:

```json
{
  "broadcast": {
    "DEV_GROUP": ["formatter", "linter", "tester"]
  }
}
```

✅ **Bueno:** Cada agente tiene un solo trabajo  
❌ **Malo:** Un agente genérico “dev-helper”

### 2. Use nombres descriptivos

Haga claro qué hace cada agente:

```json
{
  "agents": {
    "security-scanner": { "name": "Security Scanner" },
    "code-formatter": { "name": "Code Formatter" },
    "test-generator": { "name": "Test Generator" }
  }
}
```

### 3. Configure diferentes accesos a herramientas

Otorgue a los agentes solo las herramientas que necesitan:

```json
{
  "agents": {
    "reviewer": {
      "tools": { "allow": ["read", "exec"] } // Read-only
    },
    "fixer": {
      "tools": { "allow": ["read", "write", "edit", "exec"] } // Read-write
    }
  }
}
```

### 4. Supervise el rendimiento

Con muchos agentes, considere:

- Usar `"strategy": "parallel"` (predeterminado) para mayor velocidad
- Limitar los grupos de difusión a 5–10 agentes
- Usar modelos más rápidos para agentes más simples

### 5. Maneje las fallas con elegancia

Los agentes fallan de forma independiente. El error de un agente no bloquea a los demás:

```
Message → [Agent A ✓, Agent B ✗ error, Agent C ✓]
Result: Agent A and C respond, Agent B logs error
```

## Compatibilidad

### Proveedores

Los grupos de difusión actualmente funcionan con:

- ✅ WhatsApp (implementado)
- 🚧 Telegram (planificado)
- 🚧 Discord (planificado)
- 🚧 Slack (planificado)

### Enrutamiento

Los grupos de difusión funcionan junto con el enrutamiento existente:

```json
{
  "bindings": [
    {
      "match": { "channel": "whatsapp", "peer": { "kind": "group", "id": "GROUP_A" } },
      "agentId": "alfred"
    }
  ],
  "broadcast": {
    "GROUP_B": ["agent1", "agent2"]
  }
}
```

- `GROUP_A`: solo responde alfred (enrutamiento normal)
- `GROUP_B`: responden agent1 Y agent2 (difusión)

**Precedencia:** `broadcast` tiene prioridad sobre `bindings`.

## Solución de problemas

### Los agentes no responden

**Verifique:**

1. Los IDs de agentes existen en `agents.list`
2. El formato del ID del par es correcto (p. ej., `120363403215116621@g.us`)
3. Los agentes no están en listas de denegación

**Depurar:**

```bash
tail -f ~/.openclaw/logs/gateway.log | grep broadcast
```

### Solo responde un agente

**Causa:** El ID del par podría estar en `bindings` pero no en `broadcast`.

**Solución:** Agréguelo a la configuración de difusión o elimínelo de los enlaces.

### Problemas de rendimiento

**Si es lento con muchos agentes:**

- Reduzca el número de agentes por grupo
- Use modelos más ligeros (sonnet en lugar de opus)
- Revise el tiempo de inicio del sandbox

## Ejemplos

### Ejemplo 1: Equipo de revisión de código

```json
{
  "broadcast": {
    "strategy": "parallel",
    "120363403215116621@g.us": [
      "code-formatter",
      "security-scanner",
      "test-coverage",
      "docs-checker"
    ]
  },
  "agents": {
    "list": [
      {
        "id": "code-formatter",
        "workspace": "~/agents/formatter",
        "tools": { "allow": ["read", "write"] }
      },
      {
        "id": "security-scanner",
        "workspace": "~/agents/security",
        "tools": { "allow": ["read", "exec"] }
      },
      {
        "id": "test-coverage",
        "workspace": "~/agents/testing",
        "tools": { "allow": ["read", "exec"] }
      },
      { "id": "docs-checker", "workspace": "~/agents/docs", "tools": { "allow": ["read"] } }
    ]
  }
}
```

**El usuario envía:** fragmento de código  
**Respuestas:**

- code-formatter: "Corregí la indentación y agregué sugerencias de tipo"
- security-scanner: "⚠️ Vulnerabilidad de inyección SQL en la línea 12"
- test-coverage: "La cobertura es del 45 %, faltan pruebas para casos de error"
- docs-checker: "Falta el docstring para la función `process_data`"

### Ejemplo 2: Soporte multilingüe

```json
{
  "broadcast": {
    "strategy": "sequential",
    "+15555550123": ["detect-language", "translator-en", "translator-de"]
  },
  "agents": {
    "list": [
      { "id": "detect-language", "workspace": "~/agents/lang-detect" },
      { "id": "translator-en", "workspace": "~/agents/translate-en" },
      { "id": "translator-de", "workspace": "~/agents/translate-de" }
    ]
  }
}
```

## Referencia de la API

### Esquema de configuración

```typescript
interface OpenClawConfig {
  broadcast?: {
    strategy?: "parallel" | "sequential";
    [peerId: string]: string[];
  };
}
```

### Campos

- `strategy` (opcional): Cómo procesar los agentes
  - `"parallel"` (predeterminado): Todos los agentes procesan simultáneamente
  - `"sequential"`: Los agentes procesan en el orden del arreglo
- `[peerId]`: JID de grupo de WhatsApp, número E.164 u otro ID de par
  - Valor: Arreglo de IDs de agentes que deben procesar mensajes

## Limitaciones

1. de agentes:\*\* No hay un límite estricto, pero 10+ agentes pueden ser lentos
2. **Contexto compartido:** Los agentes no ven las respuestas de otros agentes (por diseño)
3. **Orden de mensajes:** Las respuestas en paralelo pueden llegar en cualquier orden
4. **Límites de tasa:** Todos los agentes cuentan para los límites de tasa de WhatsApp

## Mejoras futuras

Funciones planificadas:

- [ ] Modo de contexto compartido (los agentes ven las respuestas de otros)
- [ ] Coordinación de agentes (los agentes pueden señalizarse entre sí)
- [ ] Selección dinámica de agentes (elegir agentes según el contenido del mensaje)
- [ ] Prioridades de agentes (algunos agentes responden antes que otros)

## Ver también

- [Configuración multiagente](/tools/multi-agent-sandbox-tools)
- [Configuración de enrutamiento](/channels/channel-routing)
- [Gestión de sesiones](/concepts/sessions)
