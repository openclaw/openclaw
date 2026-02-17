---
summary: "Reglas de enrutamiento por canal (WhatsApp, Telegram, Discord, Slack) y contexto compartido"
read_when:
  - Cambiando enrutamiento de canal o comportamiento de bandeja de entrada
title: "Enrutamiento de Canales"
---

# Canales y enrutamiento

OpenClaw enruta las respuestas **de vuelta al canal del que provino un mensaje**. El
modelo no elige un canal; el enrutamiento es determinístico y controlado por la
configuración del host.

## Términos clave

- **Channel**: `whatsapp`, `telegram`, `discord`, `slack`, `signal`, `imessage`, `webchat`.
- **AccountId**: instancia de cuenta por canal (cuando es soportado).
- **AgentId**: un espacio de trabajo aislado + almacén de sesión ("cerebro").
- **SessionKey**: la clave de bucket usada para almacenar contexto y controlar concurrencia.

## Formas de claves de sesión (ejemplos)

Los mensajes directos colapsan a la sesión **principal** del agente:

- `agent:<agentId>:<mainKey>` (por defecto: `agent:main:main`)

Los grupos y canales permanecen aislados por canal:

- Grupos: `agent:<agentId>:<channel>:group:<id>`
- Canales/salas: `agent:<agentId>:<channel>:channel:<id>`

Hilos:

- Los hilos de Slack/Discord agregan `:thread:<threadId>` a la clave base.
- Los tópicos del foro de Telegram embeben `:topic:<topicId>` en la clave de grupo.

Ejemplos:

- `agent:main:telegram:group:-1001234567890:topic:42`
- `agent:main:discord:channel:123456:thread:987654`

## Reglas de enrutamiento (cómo se elige un agente)

El enrutamiento selecciona **un agente** para cada mensaje entrante:

1. **Coincidencia exacta de peer** (`bindings` con `peer.kind` + `peer.id`).
2. **Coincidencia de peer padre** (herencia de hilo).
3. **Coincidencia de Guild + roles** (Discord) mediante `guildId` + `roles`.
4. **Coincidencia de Guild** (Discord) mediante `guildId`.
5. **Coincidencia de Team** (Slack) mediante `teamId`.
6. **Coincidencia de Account** (`accountId` en el canal).
7. **Coincidencia de Channel** (cualquier cuenta en ese canal, `accountId: "*"`).
8. **Agente por defecto** (`agents.list[].default`, sino primera entrada de lista, respaldo a `main`).

Cuando un binding incluye múltiples campos de coincidencia (`peer`, `guildId`, `teamId`, `roles`), **todos los campos proporcionados deben coincidir** para que ese binding aplique.

El agente coincidente determina qué espacio de trabajo y almacén de sesión se usan.

## Grupos de difusión (ejecutar múltiples agentes)

Los grupos de difusión te permiten ejecutar **múltiples agentes** para el mismo peer **cuando OpenClaw normalmente respondería** (por ejemplo: en grupos de WhatsApp, después del control de mención/activación).

Config:

```json5
{
  broadcast: {
    strategy: "parallel",
    "120363403215116621@g.us": ["alfred", "baerbel"],
    "+15555550123": ["support", "logger"],
  },
}
```

Ver: [Grupos de Difusión](/es-ES/channels/broadcast-groups).

## Resumen de configuración

- `agents.list`: definiciones de agentes nombrados (espacio de trabajo, modelo, etc.).
- `bindings`: mapear canales/cuentas/peers entrantes a agentes.

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

Los almacenes de sesión viven bajo el directorio de estado (por defecto `~/.openclaw`):

- `~/.openclaw/agents/<agentId>/sessions/sessions.json`
- Las transcripciones JSONL viven junto al almacén

Puedes sobrescribir la ruta del almacén mediante `session.store` y plantillas `{agentId}`.

## Comportamiento de WebChat

WebChat se adjunta al **agente seleccionado** y por defecto usa la sesión
principal del agente. Debido a esto, WebChat te permite ver contexto entre canales para ese
agente en un solo lugar.

## Contexto de respuesta

Las respuestas entrantes incluyen:

- `ReplyToId`, `ReplyToBody`, y `ReplyToSender` cuando están disponibles.
- El contexto citado se agrega a `Body` como un bloque `[Replying to ...]`.

Esto es consistente entre canales.
