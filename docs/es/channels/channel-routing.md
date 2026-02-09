---
summary: "Reglas de enrutamiento por canal (WhatsApp, Telegram, Discord, Slack) y contexto compartido"
read_when:
  - Al cambiar el enrutamiento de canales o el comportamiento de la bandeja de entrada
title: "Enrutamiento de canales"
---

# Canales y enrutamiento

OpenClaw enruta las respuestas **de vuelta al canal de donde provino un mensaje**. El
modelo no elige un canal; el enrutamiento es determinista y está controlado por la
configuración del host.

## Términos clave

- **Canal**: `whatsapp`, `telegram`, `discord`, `slack`, `signal`, `imessage`, `webchat`.
- **AccountId**: instancia de cuenta por canal (cuando es compatible).
- **AgentId**: un espacio de trabajo aislado + almacén de sesiones (“cerebro”).
- **SessionKey**: la clave de agrupación utilizada para almacenar contexto y controlar la concurrencia.

## Formas de claves de sesión (ejemplos)

Los mensajes directos se agrupan en la sesión **principal** del agente:

- `agent:<agentId>:<mainKey>` (predeterminado: `agent:main:main`)

Los grupos y canales permanecen aislados por canal:

- Grupos: `agent:<agentId>:<channel>:group:<id>`
- Canales/salas: `agent:<agentId>:<channel>:channel:<id>`

Hilos:

- Los hilos de Slack/Discord agregan `:thread:<threadId>` a la clave base.
- Los temas de foros de Telegram integran `:topic:<topicId>` en la clave del grupo.

Ejemplos:

- `agent:main:telegram:group:-1001234567890:topic:42`
- `agent:main:discord:channel:123456:thread:987654`

## Reglas de enrutamiento (cómo se elige un agente)

El enrutamiento selecciona **un agente** para cada mensaje entrante:

1. **Coincidencia exacta del par** (`bindings` con `peer.kind` + `peer.id`).
2. **Coincidencia de gremio** (Discord) mediante `guildId`.
3. **Coincidencia de equipo** (Slack) mediante `teamId`.
4. **Coincidencia de cuenta** (`accountId` en el canal).
5. **Coincidencia de canal** (cualquier cuenta en ese canal).
6. **Agente predeterminado** (`agents.list[].default`; de lo contrario, la primera entrada de la lista; con respaldo a `main`).

El agente coincidente determina qué espacio de trabajo y almacén de sesiones se utilizan.

## Grupos de difusión (ejecutar múltiples agentes)

Los grupos de difusión le permiten ejecutar **múltiples agentes** para el mismo par **cuando OpenClaw normalmente respondería** (por ejemplo: en grupos de WhatsApp, después del control por mención/activación).

Configuración:

```json5
{
  broadcast: {
    strategy: "parallel",
    "120363403215116621@g.us": ["alfred", "baerbel"],
    "+15555550123": ["support", "logger"],
  },
}
```

Ver: [Grupos de difusión](/channels/broadcast-groups).

## Descripción general de la configuración

- `agents.list`: definiciones de agentes con nombre (espacio de trabajo, modelo, etc.).
- `bindings`: asigna canales/cuentas/pares entrantes a agentes.

Ejemplo:

```json5
{
  agents: {
    list: [{ id: "support", name: "Support", workspace: "~/.openclaw/workspace-support" }],
  },
  bindings: [
    { match: { channel: "slack", teamId: "T123" }, agentId: "support" },
    { match: { channel: "telegram", peer: { kind: "group", id: "-100123" } }, agentId: "support" },
  ],
}
```

## Almacenamiento de sesiones

Los almacenes de sesiones viven bajo el directorio de estado (predeterminado `~/.openclaw`):

- `~/.openclaw/agents/<agentId>/sessions/sessions.json`
- Las transcripciones JSONL se almacenan junto al almacén

Puede sobrescribir la ruta del almacén mediante la plantilla `session.store` y `{agentId}`.

## Comportamiento de WebChat

WebChat se adjunta al **agente seleccionado** y, de forma predeterminada, a la sesión
principal del agente. Debido a esto, WebChat le permite ver el contexto entre canales
para ese agente en un solo lugar.

## Contexto de respuesta

Las respuestas entrantes incluyen:

- `ReplyToId`, `ReplyToBody` y `ReplyToSender` cuando están disponibles.
- El contexto citado se agrega a `Body` como un bloque `[Replying to ...]`.

Esto es consistente en todos los canales.
