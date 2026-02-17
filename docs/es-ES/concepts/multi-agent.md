---
summary: "Enrutamiento multi-agente: agentes aislados, cuentas de canal y bindings"
title: Enrutamiento Multi-Agente
read_when: "Quieres múltiples agentes aislados (espacios de trabajo + autenticación) en un proceso gateway."
status: active
---

# Enrutamiento Multi-Agente

Objetivo: múltiples agentes _aislados_ (espacio de trabajo separado + `agentDir` + sesiones), más múltiples cuentas de canal (ej. dos WhatsApps) en un Gateway en ejecución. La entrada se enruta a un agente vía bindings.

## ¿Qué es "un agente"?

Un **agente** es un cerebro completamente delimitado con su propio:

- **Espacio de trabajo** (archivos, AGENTS.md/SOUL.md/USER.md, notas locales, reglas de persona).
- **Directorio de estado** (`agentDir`) para perfiles de autenticación, registro de modelos y configuración por agente.
- **Almacén de sesión** (historial de chat + estado de enrutamiento) bajo `~/.openclaw/agents/<agentId>/sessions`.

Los perfiles de autenticación son **por agente**. Cada agente lee desde su propio:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

Las credenciales del agente principal **no** se comparten automáticamente. Nunca reutilices `agentDir`
entre agentes (causa colisiones de autenticación/sesión). Si quieres compartir credenciales,
copia `auth-profiles.json` en el `agentDir` del otro agente.

Las habilidades son por agente vía la carpeta `skills/` de cada espacio de trabajo, con habilidades compartidas
disponibles desde `~/.openclaw/skills`. Consulta [Habilidades: por agente vs compartidas](/es-ES/tools/skills#per-agent-vs-shared-skills).

El Gateway puede alojar **un agente** (predeterminado) o **muchos agentes** lado a lado.

**Nota sobre espacio de trabajo:** el espacio de trabajo de cada agente es el **cwd predeterminado**, no un sandbox
duro. Las rutas relativas se resuelven dentro del espacio de trabajo, pero las rutas absolutas pueden
alcanzar otras ubicaciones del host a menos que el sandboxing esté habilitado. Consulta
[Sandboxing](/es-ES/gateway/sandboxing).

## Rutas (mapa rápido)

- Config: `~/.openclaw/openclaw.json` (o `OPENCLAW_CONFIG_PATH`)
- Directorio de estado: `~/.openclaw` (o `OPENCLAW_STATE_DIR`)
- Espacio de trabajo: `~/.openclaw/workspace` (o `~/.openclaw/workspace-<agentId>`)
- Directorio de agente: `~/.openclaw/agents/<agentId>/agent` (o `agents.list[].agentDir`)
- Sesiones: `~/.openclaw/agents/<agentId>/sessions`

### Modo de agente único (predeterminado)

Si no haces nada, OpenClaw ejecuta un único agente:

- `agentId` por defecto es **`main`**.
- Las sesiones se identifican como `agent:main:<mainKey>`.
- El espacio de trabajo por defecto es `~/.openclaw/workspace` (o `~/.openclaw/workspace-<profile>` cuando `OPENCLAW_PROFILE` está configurado).
- El estado por defecto es `~/.openclaw/agents/main/agent`.

## Helper de agente

Usa el asistente de agente para agregar un nuevo agente aislado:

```bash
openclaw agents add work
```

Luego agrega `bindings` (o deja que el asistente lo haga) para enrutar mensajes entrantes.

Verifica con:

```bash
openclaw agents list --bindings
```

## Múltiples agentes = múltiples personas, múltiples personalidades

Con **múltiples agentes**, cada `agentId` se convierte en una **persona completamente aislada**:

- **Diferentes números de teléfono/cuentas** (por `accountId` de canal).
- **Diferentes personalidades** (archivos de espacio de trabajo por agente como `AGENTS.md` y `SOUL.md`).
- **Autenticación + sesiones separadas** (sin comunicación cruzada a menos que se habilite explícitamente).

Esto permite que **múltiples personas** compartan un servidor Gateway mientras mantienen sus "cerebros" de IA y datos aislados.

## Un número de WhatsApp, múltiples personas (división de DM)

Puedes enrutar **diferentes DMs de WhatsApp** a diferentes agentes mientras te mantienes en **una cuenta de WhatsApp**. Coincide con el remitente E.164 (como `+15551234567`) con `peer.kind: "direct"`. Las respuestas aún provienen del mismo número de WhatsApp (sin identidad de remitente por agente).

Detalle importante: los chats directos colapsan a la **clave de sesión principal** del agente, por lo que el verdadero aislamiento requiere **un agente por persona**.

Ejemplo:

```json5
{
  agents: {
    list: [
      { id: "alex", workspace: "~/.openclaw/workspace-alex" },
      { id: "mia", workspace: "~/.openclaw/workspace-mia" },
    ],
  },
  bindings: [
    {
      agentId: "alex",
      match: { channel: "whatsapp", peer: { kind: "direct", id: "+15551230001" } },
    },
    {
      agentId: "mia",
      match: { channel: "whatsapp", peer: { kind: "direct", id: "+15551230002" } },
    },
  ],
  channels: {
    whatsapp: {
      dmPolicy: "allowlist",
      allowFrom: ["+15551230001", "+15551230002"],
    },
  },
}
```

Notas:

- El control de acceso a DM es **global por cuenta de WhatsApp** (emparejamiento/lista de permitidos), no por agente.
- Para grupos compartidos, vincula el grupo a un agente o usa [Grupos de transmisión](/es-ES/channels/broadcast-groups).

## Reglas de enrutamiento (cómo los mensajes eligen un agente)

Los bindings son **determinísticos** y **el más específico gana**:

1. Coincidencia de `peer` (id exacto de DM/grupo/canal)
2. Coincidencia de `parentPeer` (herencia de hilo)
3. `guildId + roles` (enrutamiento de roles de Discord)
4. `guildId` (Discord)
5. `teamId` (Slack)
6. Coincidencia de `accountId` para un canal
7. Coincidencia a nivel de canal (`accountId: "*"`)
8. Fallback a agente predeterminado (`agents.list[].default`, si no primera entrada de lista, predeterminado: `main`)

Si un binding establece múltiples campos de coincidencia (por ejemplo `peer` + `guildId`), todos los campos especificados son requeridos (semántica `AND`).

## Múltiples cuentas / números de teléfono

Los canales que soportan **múltiples cuentas** (ej. WhatsApp) usan `accountId` para identificar
cada inicio de sesión. Cada `accountId` puede ser enrutado a un agente diferente, por lo que un servidor puede alojar
múltiples números de teléfono sin mezclar sesiones.

## Conceptos

- `agentId`: un "cerebro" (espacio de trabajo, autenticación por agente, almacén de sesión por agente).
- `accountId`: una instancia de cuenta de canal (ej. cuenta de WhatsApp `"personal"` vs `"biz"`).
- `binding`: enruta mensajes entrantes a un `agentId` por `(channel, accountId, peer)` y opcionalmente ids de guild/team.
- Los chats directos colapsan a `agent:<agentId>:<mainKey>` ("main" por agente; `session.mainKey`).

## Ejemplo: dos WhatsApps → dos agentes

`~/.openclaw/openclaw.json` (JSON5):

```js
{
  agents: {
    list: [
      {
        id: "home",
        default: true,
        name: "Home",
        workspace: "~/.openclaw/workspace-home",
        agentDir: "~/.openclaw/agents/home/agent",
      },
      {
        id: "work",
        name: "Work",
        workspace: "~/.openclaw/workspace-work",
        agentDir: "~/.openclaw/agents/work/agent",
      },
    ],
  },

  // Enrutamiento determinístico: primera coincidencia gana (más específico primero).
  bindings: [
    { agentId: "home", match: { channel: "whatsapp", accountId: "personal" } },
    { agentId: "work", match: { channel: "whatsapp", accountId: "biz" } },

    // Sobrescritura opcional por peer (ejemplo: enviar un grupo específico al agente de trabajo).
    {
      agentId: "work",
      match: {
        channel: "whatsapp",
        accountId: "personal",
        peer: { kind: "group", id: "1203630...@g.us" },
      },
    },
  ],

  // Desactivado por defecto: la mensajería agente-a-agente debe habilitarse explícitamente + lista de permitidos.
  tools: {
    agentToAgent: {
      enabled: false,
      allow: ["home", "work"],
    },
  },

  channels: {
    whatsapp: {
      accounts: {
        personal: {
          // Sobrescritura opcional. Predeterminado: ~/.openclaw/credentials/whatsapp/personal
          // authDir: "~/.openclaw/credentials/whatsapp/personal",
        },
        biz: {
          // Sobrescritura opcional. Predeterminado: ~/.openclaw/credentials/whatsapp/biz
          // authDir: "~/.openclaw/credentials/whatsapp/biz",
        },
      },
    },
  },
}
```

## Ejemplo: chat diario de WhatsApp + trabajo profundo de Telegram

Divide por canal: enruta WhatsApp a un agente rápido cotidiano y Telegram a un agente Opus.

```json5
{
  agents: {
    list: [
      {
        id: "chat",
        name: "Everyday",
        workspace: "~/.openclaw/workspace-chat",
        model: "anthropic/claude-sonnet-4-5",
      },
      {
        id: "opus",
        name: "Deep Work",
        workspace: "~/.openclaw/workspace-opus",
        model: "anthropic/claude-opus-4-6",
      },
    ],
  },
  bindings: [
    { agentId: "chat", match: { channel: "whatsapp" } },
    { agentId: "opus", match: { channel: "telegram" } },
  ],
}
```

Notas:

- Si tienes múltiples cuentas para un canal, agrega `accountId` al binding (por ejemplo `{ channel: "whatsapp", accountId: "personal" }`).
- Para enrutar un único DM/grupo a Opus mientras mantienes el resto en chat, agrega un binding `match.peer` para ese peer; las coincidencias de peer siempre ganan sobre reglas a nivel de canal.

## Ejemplo: mismo canal, un peer a Opus

Mantén WhatsApp en el agente rápido, pero enruta un DM a Opus:

```json5
{
  agents: {
    list: [
      {
        id: "chat",
        name: "Everyday",
        workspace: "~/.openclaw/workspace-chat",
        model: "anthropic/claude-sonnet-4-5",
      },
      {
        id: "opus",
        name: "Deep Work",
        workspace: "~/.openclaw/workspace-opus",
        model: "anthropic/claude-opus-4-6",
      },
    ],
  },
  bindings: [
    {
      agentId: "opus",
      match: { channel: "whatsapp", peer: { kind: "direct", id: "+15551234567" } },
    },
    { agentId: "chat", match: { channel: "whatsapp" } },
  ],
}
```

Los bindings de peer siempre ganan, así que mantenlos encima de la regla a nivel de canal.

## Agente familiar vinculado a un grupo de WhatsApp

Vincula un agente familiar dedicado a un único grupo de WhatsApp, con control de menciones
y una política de herramientas más estricta:

```json5
{
  agents: {
    list: [
      {
        id: "family",
        name: "Family",
        workspace: "~/.openclaw/workspace-family",
        identity: { name: "Family Bot" },
        groupChat: {
          mentionPatterns: ["@family", "@familybot", "@Family Bot"],
        },
        sandbox: {
          mode: "all",
          scope: "agent",
        },
        tools: {
          allow: [
            "exec",
            "read",
            "sessions_list",
            "sessions_history",
            "sessions_send",
            "sessions_spawn",
            "session_status",
          ],
          deny: ["write", "edit", "apply_patch", "browser", "canvas", "nodes", "cron"],
        },
      },
    ],
  },
  bindings: [
    {
      agentId: "family",
      match: {
        channel: "whatsapp",
        peer: { kind: "group", id: "120363999999999999@g.us" },
      },
    },
  ],
}
```

Notas:

- Las listas de permitir/denegar de herramientas son **herramientas**, no habilidades. Si una habilidad necesita ejecutar un
  binario, asegúrate de que `exec` esté permitido y el binario exista en el sandbox.
- Para control más estricto, establece `agents.list[].groupChat.mentionPatterns` y mantén
  listas de permitidos de grupo habilitadas para el canal.

## Configuración de Sandbox y Herramientas por Agente

A partir de v2026.1.6, cada agente puede tener su propio sandbox y restricciones de herramientas:

```js
{
  agents: {
    list: [
      {
        id: "personal",
        workspace: "~/.openclaw/workspace-personal",
        sandbox: {
          mode: "off",  // Sin sandbox para agente personal
        },
        // Sin restricciones de herramientas - todas las herramientas disponibles
      },
      {
        id: "family",
        workspace: "~/.openclaw/workspace-family",
        sandbox: {
          mode: "all",     // Siempre en sandbox
          scope: "agent",  // Un contenedor por agente
          docker: {
            // Configuración opcional única después de creación de contenedor
            setupCommand: "apt-get update && apt-get install -y git curl",
          },
        },
        tools: {
          allow: ["read"],                    // Solo herramienta read
          deny: ["exec", "write", "edit", "apply_patch"],    // Denegar otras
        },
      },
    ],
  },
}
```

Nota: `setupCommand` vive bajo `sandbox.docker` y se ejecuta una vez en la creación del contenedor.
Las sobrescrituras por agente de `sandbox.docker.*` se ignoran cuando el scope resuelto es `"shared"`.

**Beneficios:**

- **Aislamiento de seguridad**: Restringe herramientas para agentes no confiables
- **Control de recursos**: Sandbox de agentes específicos mientras mantienes otros en el host
- **Políticas flexibles**: Diferentes permisos por agente

Nota: `tools.elevated` es **global** y basado en remitente; no es configurable por agente.
Si necesitas límites por agente, usa `agents.list[].tools` para denegar `exec`.
Para targeting de grupo, usa `agents.list[].groupChat.mentionPatterns` para que las @menciones mapeen limpiamente al agente deseado.

Consulta [Sandbox y Herramientas Multi-Agente](/es-ES/tools/multi-agent-sandbox-tools) para ejemplos detallados.
