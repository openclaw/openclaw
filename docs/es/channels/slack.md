---
summary: "Configuración de Slack para modo socket o webhook HTTP"
read_when: "Configurar Slack o depurar el modo socket/HTTP de Slack"
title: "Slack"
---

# Slack

## Modo socket (predeterminado)

### Configuración rápida (principiante)

1. Cree una app de Slack y habilite **Socket Mode**.
2. Cree un **App Token** (`xapp-...`) y un **Bot Token** (`xoxb-...`).
3. Configure los tokens para OpenClaw e inicie el Gateway.

Configuración mínima:

```json5
{
  channels: {
    slack: {
      enabled: true,
      appToken: "xapp-...",
      botToken: "xoxb-...",
    },
  },
}
```

### Configuración

1. Cree una app de Slack (From scratch) en [https://api.slack.com/apps](https://api.slack.com/apps).
2. **Socket Mode** → actívelo. Luego vaya a **Basic Information** → **App-Level Tokens** → **Generate Token and Scopes** con el alcance `connections:write`. Copie el **App Token** (`xapp-...`).
3. **OAuth & Permissions** → agregue los alcances del bot (use el manifiesto de abajo). Haga clic en **Install to Workspace**. Copie el **Bot User OAuth Token** (`xoxb-...`).
4. Opcional: **OAuth & Permissions** → agregue **User Token Scopes** (vea la lista de solo lectura abajo). Reinstale la app y copie el **User OAuth Token** (`xoxp-...`).
5. **Event Subscriptions** → habilite eventos y suscríbase a:
   - `message.*` (incluye ediciones/eliminaciones/difusiones de hilos)
   - `app_mention`
   - `reaction_added`, `reaction_removed`
   - `member_joined_channel`, `member_left_channel`
   - `channel_rename`
   - `pin_added`, `pin_removed`
6. Invite al bot a los canales que desea que lea.
7. Slash Commands → cree `/openclaw` si usa `channels.slack.slashCommand`. Si habilita comandos nativos, agregue un comando slash por cada comando integrado (los mismos nombres que `/help`). De forma predeterminada, los nativos están desactivados para Slack a menos que configure `channels.slack.commands.native: true` (el valor global `commands.native` es `"auto"`, lo que deja Slack desactivado).
8. App Home → habilite la **Messages Tab** para que los usuarios puedan enviar mensajes directos al bot.

Use el manifiesto de abajo para que los alcances y eventos se mantengan sincronizados.

Soporte multi‑cuenta: use `channels.slack.accounts` con tokens por cuenta y `name` opcional. Vea [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) para el patrón compartido.

### Configuración de OpenClaw (modo socket)

Configure los tokens mediante variables de entorno (recomendado):

- `SLACK_APP_TOKEN=xapp-...`
- `SLACK_BOT_TOKEN=xoxb-...`

O mediante la configuración:

```json5
{
  channels: {
    slack: {
      enabled: true,
      appToken: "xapp-...",
      botToken: "xoxb-...",
    },
  },
}
```

### Token de usuario (opcional)

OpenClaw puede usar un token de usuario de Slack (`xoxp-...`) para operaciones de lectura (historial,
pines, reacciones, emoji, información de miembros). De forma predeterminada, esto permanece en solo lectura: las lecturas
prefieren el token de usuario cuando está presente, y las escrituras siguen usando el token del bot a menos
que usted lo habilite explícitamente. Incluso con `userTokenReadOnly: false`, el token del bot
sigue siendo preferido para escrituras cuando está disponible.

Los tokens de usuario se configuran en el archivo de configuración (no hay soporte por variables de entorno). Para
multi‑cuenta, configure `channels.slack.accounts.<id>.userToken`.

Ejemplo con tokens de bot + app + usuario:

```json5
{
  channels: {
    slack: {
      enabled: true,
      appToken: "xapp-...",
      botToken: "xoxb-...",
      userToken: "xoxp-...",
    },
  },
}
```

Ejemplo con userTokenReadOnly configurado explícitamente (permitir escrituras con token de usuario):

```json5
{
  channels: {
    slack: {
      enabled: true,
      appToken: "xapp-...",
      botToken: "xoxb-...",
      userToken: "xoxp-...",
      userTokenReadOnly: false,
    },
  },
}
```

#### Uso de tokens

- Las operaciones de lectura (historial, lista de reacciones, lista de pines, lista de emoji, información de miembros,
  búsqueda) prefieren el token de usuario cuando está configurado; de lo contrario, el token del bot.
- Las operaciones de escritura (enviar/editar/eliminar mensajes, agregar/quitar reacciones, fijar/desfijar,
  cargas de archivos) usan el token del bot de forma predeterminada. Si `userTokenReadOnly: false` y
  no hay token de bot disponible, OpenClaw recurre al token de usuario.

### Contexto de historial

- `channels.slack.historyLimit` (o `channels.slack.accounts.*.historyLimit`) controla cuántos mensajes recientes del canal/grupo se incluyen en el prompt.
- Vuelve a `messages.groupChat.historyLimit`. Configure `0` para deshabilitar (predeterminado 50).

## Modo HTTP (Events API)

Use el modo de webhook HTTP cuando su Gateway sea accesible por Slack a través de HTTPS (típico en despliegues de servidor).
El modo HTTP usa Events API + Interactivity + Slash Commands con una URL de solicitud compartida.

### Configuración (modo HTTP)

1. Cree una app de Slack y **deshabilite Socket Mode** (opcional si solo usa HTTP).
2. **Basic Information** → copie el **Signing Secret**.
3. **OAuth & Permissions** → instale la app y copie el **Bot User OAuth Token** (`xoxb-...`).
4. **Event Subscriptions** → habilite eventos y configure la **Request URL** a la ruta del webhook del Gateway (predeterminado `/slack/events`).
5. **Interactivity & Shortcuts** → habilite y configure la misma **Request URL**.
6. **Slash Commands** → configure la misma **Request URL** para su(s) comando(s).

Ejemplo de URL de solicitud:
`https://gateway-host/slack/events`

### Configuración de OpenClaw (mínima)

```json5
{
  channels: {
    slack: {
      enabled: true,
      mode: "http",
      botToken: "xoxb-...",
      signingSecret: "your-signing-secret",
      webhookPath: "/slack/events",
    },
  },
}
```

Modo HTTP multi‑cuenta: configure `channels.slack.accounts.<id>.mode = "http"` y proporcione un
`webhookPath` único por cuenta para que cada app de Slack apunte a su propia URL.

### Manifiesto (opcional)

Use este manifiesto de app de Slack para crear la app rápidamente (ajuste el nombre/comando si lo desea). Incluya los
alcances de usuario si planea configurar un token de usuario.

```json
{
  "display_information": {
    "name": "OpenClaw",
    "description": "Slack connector for OpenClaw"
  },
  "features": {
    "bot_user": {
      "display_name": "OpenClaw",
      "always_online": false
    },
    "app_home": {
      "messages_tab_enabled": true,
      "messages_tab_read_only_enabled": false
    },
    "slash_commands": [
      {
        "command": "/openclaw",
        "description": "Send a message to OpenClaw",
        "should_escape": false
      }
    ]
  },
  "oauth_config": {
    "scopes": {
      "bot": [
        "chat:write",
        "channels:history",
        "channels:read",
        "groups:history",
        "groups:read",
        "groups:write",
        "im:history",
        "im:read",
        "im:write",
        "mpim:history",
        "mpim:read",
        "mpim:write",
        "users:read",
        "app_mentions:read",
        "reactions:read",
        "reactions:write",
        "pins:read",
        "pins:write",
        "emoji:read",
        "commands",
        "files:read",
        "files:write"
      ],
      "user": [
        "channels:history",
        "channels:read",
        "groups:history",
        "groups:read",
        "im:history",
        "im:read",
        "mpim:history",
        "mpim:read",
        "users:read",
        "reactions:read",
        "pins:read",
        "emoji:read",
        "search:read"
      ]
    }
  },
  "settings": {
    "socket_mode_enabled": true,
    "event_subscriptions": {
      "bot_events": [
        "app_mention",
        "message.channels",
        "message.groups",
        "message.im",
        "message.mpim",
        "reaction_added",
        "reaction_removed",
        "member_joined_channel",
        "member_left_channel",
        "channel_rename",
        "pin_added",
        "pin_removed"
      ]
    }
  }
}
```

Si habilita comandos nativos, agregue una entrada `slash_commands` por cada comando que quiera exponer (coincidiendo con la lista `/help`). Reemplace con `channels.slack.commands.native`.

## Alcances (actuales vs opcionales)

La API de Conversaciones de Slack está tipada por conversación: solo necesita los alcances para los
tipos de conversación que realmente use (channels, groups, im, mpim). Vea
[https://docs.slack.dev/apis/web-api/using-the-conversations-api/](https://docs.slack.dev/apis/web-api/using-the-conversations-api/) para una visión general.

### Alcances del token del bot (requeridos)

- `chat:write` (enviar/actualizar/eliminar mensajes mediante `chat.postMessage`)
  [https://docs.slack.dev/reference/methods/chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage)
- `im:write` (abrir mensajes directos mediante `conversations.open` para DMs de usuario)
  [https://docs.slack.dev/reference/methods/conversations.open](https://docs.slack.dev/reference/methods/conversations.open)
- `channels:history`, `groups:history`, `im:history`, `mpim:history`
  [https://docs.slack.dev/reference/methods/conversations.history](https://docs.slack.dev/reference/methods/conversations.history)
- `channels:read`, `groups:read`, `im:read`, `mpim:read`
  [https://docs.slack.dev/reference/methods/conversations.info](https://docs.slack.dev/reference/methods/conversations.info)
- `users:read` (búsqueda de usuarios)
  [https://docs.slack.dev/reference/methods/users.info](https://docs.slack.dev/reference/methods/users.info)
- `reactions:read`, `reactions:write` (`reactions.get` / `reactions.add`)
  [https://docs.slack.dev/reference/methods/reactions.get](https://docs.slack.dev/reference/methods/reactions.get)
  [https://docs.slack.dev/reference/methods/reactions.add](https://docs.slack.dev/reference/methods/reactions.add)
- `pins:read`, `pins:write` (`pins.list` / `pins.add` / `pins.remove`)
  [https://docs.slack.dev/reference/scopes/pins.read](https://docs.slack.dev/reference/scopes/pins.read)
  [https://docs.slack.dev/reference/scopes/pins.write](https://docs.slack.dev/reference/scopes/pins.write)
- `emoji:read` (`emoji.list`)
  [https://docs.slack.dev/reference/scopes/emoji.read](https://docs.slack.dev/reference/scopes/emoji.read)
- `files:write` (cargas mediante `files.uploadV2`)
  [https://docs.slack.dev/messaging/working-with-files/#upload](https://docs.slack.dev/messaging/working-with-files/#upload)

### Alcances del token de usuario (opcional, solo lectura por defecto)

Agregue estos en **User Token Scopes** si configura `channels.slack.userToken`.

- `channels:history`, `groups:history`, `im:history`, `mpim:history`
- `channels:read`, `groups:read`, `im:read`, `mpim:read`
- `users:read`
- `reactions:read`
- `pins:read`
- `emoji:read`
- `search:read`

### No necesarios hoy (pero probables en el futuro)

- `mpim:write` (solo si agregamos apertura de DM grupal/inicio de DM mediante `conversations.open`)
- `groups:write` (solo si agregamos gestión de canales privados: crear/renombrar/invitar/archivar)
- `chat:write.public` (solo si queremos publicar en canales en los que el bot no está)
  [https://docs.slack.dev/reference/scopes/chat.write.public](https://docs.slack.dev/reference/scopes/chat.write.public)
- `users:read.email` (solo si necesitamos campos de correo electrónico de `users.info`)
  [https://docs.slack.dev/changelog/2017-04-narrowing-email-access](https://docs.slack.dev/changelog/2017-04-narrowing-email-access)
- `files:read` (solo si comenzamos a listar/leer metadatos de archivos)

## Configuración

Slack usa solo Socket Mode (sin servidor de webhook HTTP). Proporcione ambos tokens:

```json
{
  "slack": {
    "enabled": true,
    "botToken": "xoxb-...",
    "appToken": "xapp-...",
    "groupPolicy": "allowlist",
    "dm": {
      "enabled": true,
      "policy": "pairing",
      "allowFrom": ["U123", "U456", "*"],
      "groupEnabled": false,
      "groupChannels": ["G123"],
      "replyToMode": "all"
    },
    "channels": {
      "C123": { "allow": true, "requireMention": true },
      "#general": {
        "allow": true,
        "requireMention": true,
        "users": ["U123"],
        "skills": ["search", "docs"],
        "systemPrompt": "Keep answers short."
      }
    },
    "reactionNotifications": "own",
    "reactionAllowlist": ["U123"],
    "replyToMode": "off",
    "actions": {
      "reactions": true,
      "messages": true,
      "pins": true,
      "memberInfo": true,
      "emojiList": true
    },
    "slashCommand": {
      "enabled": true,
      "name": "openclaw",
      "sessionPrefix": "slack:slash",
      "ephemeral": true
    },
    "textChunkLimit": 4000,
    "mediaMaxMb": 20
  }
}
```

Los tokens también se pueden proporcionar mediante variables de entorno:

- `SLACK_BOT_TOKEN`
- `SLACK_APP_TOKEN`

Las reacciones de acuse (ack) se controlan globalmente mediante `messages.ackReaction` +
`messages.ackReactionScope`. Use `messages.removeAckAfterReply` para limpiar la
reacción de acuse después de que el bot responda.

## Límites

- El texto saliente se fragmenta en `channels.slack.textChunkLimit` (predeterminado 4000).
- Fragmentación opcional por salto de línea: configure `channels.slack.chunkMode="newline"` para dividir en líneas en blanco (límites de párrafo) antes de fragmentar por longitud.
- Las cargas de medios están limitadas por `channels.slack.mediaMaxMb` (predeterminado 20).

## Enhebrado de respuestas

De forma predeterminada, OpenClaw responde en el canal principal. Use `channels.slack.replyToMode` para controlar el enhebrado automático:

| Modo    | Comportamiento                                                                                                                                                                                                                         |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `off`   | **Predeterminado.** Responder en el canal principal. Solo enhebra si el mensaje desencadenante ya estaba en un hilo.                                                                   |
| `first` | La primera respuesta va al hilo (bajo el mensaje desencadenante), las respuestas posteriores van al canal principal. Útil para mantener el contexto visible evitando saturar hilos. |
| `all`   | Todas las respuestas van al hilo. Mantiene las conversaciones contenidas pero puede reducir la visibilidad.                                                                                            |

El modo se aplica tanto a las auto‑respuestas como a las llamadas de herramientas del agente (`slack sendMessage`).

### Enhebrado por tipo de chat

Puede configurar un comportamiento de enhebrado diferente por tipo de chat configurando `channels.slack.replyToModeByChatType`:

```json5
{
  channels: {
    slack: {
      replyToMode: "off", // default for channels
      replyToModeByChatType: {
        direct: "all", // DMs always thread
        group: "first", // group DMs/MPIM thread first reply
      },
    },
  },
}
```

Tipos de chat compatibles:

- `direct`: DMs 1:1 (Slack `im`)
- `group`: DMs grupales / MPIMs (Slack `mpim`)
- `channel`: canales estándar (públicos/privados)

Precedencia:

1. `replyToModeByChatType.<chatType>`
2. `replyToMode`
3. Predeterminado del proveedor (`off`)

El legado `channels.slack.dm.replyToMode` aún se acepta como respaldo para `direct` cuando no hay una anulación por tipo de chat.

Ejemplos:

Enhebrar solo DMs:

```json5
{
  channels: {
    slack: {
      replyToMode: "off",
      replyToModeByChatType: { direct: "all" },
    },
  },
}
```

Enhebrar DMs grupales pero mantener canales en la raíz:

```json5
{
  channels: {
    slack: {
      replyToMode: "off",
      replyToModeByChatType: { group: "first" },
    },
  },
}
```

Hacer que los canales usen hilos y mantener DMs en la raíz:

```json5
{
  channels: {
    slack: {
      replyToMode: "first",
      replyToModeByChatType: { direct: "off", group: "off" },
    },
  },
}
```

### Etiquetas manuales de enhebrado

Para un control más fino, use estas etiquetas en las respuestas del agente:

- `[[reply_to_current]]` — responder al mensaje desencadenante (iniciar/continuar hilo).
- `[[reply_to:<id>]]` — responder a un id de mensaje específico.

## Sesiones + enrutamiento

- Los DMs comparten la sesión `main` (como WhatsApp/Telegram).
- Los canales se asignan a sesiones `agent:<agentId>:slack:channel:<channelId>`.
- Los slash commands usan sesiones `agent:<agentId>:slack:slash:<userId>` (prefijo configurable mediante `channels.slack.slashCommand.sessionPrefix`).
- Si Slack no proporciona `channel_type`, OpenClaw lo infiere a partir del prefijo del ID del canal (`D`, `C`, `G`) y usa `channel` de forma predeterminada para mantener estables las claves de sesión.
- El registro de comandos nativos usa `commands.native` (predeterminado global `"auto"` → Slack desactivado) y puede anularse por espacio de trabajo con `channels.slack.commands.native`. Los comandos de texto requieren mensajes `/...` independientes y pueden deshabilitarse con `commands.text: false`. Los slash commands de Slack se gestionan en la app de Slack y no se eliminan automáticamente. Use `commands.useAccessGroups: false` para omitir comprobaciones de grupos de acceso para comandos.
- Lista completa de comandos + configuración: [Slash commands](/tools/slash-commands)

## Seguridad de DMs (emparejamiento)

- Predeterminado: `channels.slack.dm.policy="pairing"` — los remitentes de DM desconocidos reciben un código de emparejamiento (expira después de 1 hora).
- Aprobar mediante: `openclaw pairing approve slack <code>`.
- Para permitir a cualquiera: configure `channels.slack.dm.policy="open"` y `channels.slack.dm.allowFrom=["*"]`.
- `channels.slack.dm.allowFrom` acepta IDs de usuario, @handles o correos electrónicos (resueltos al iniciar cuando los tokens lo permiten). El asistente acepta nombres de usuario y los resuelve a ids durante la configuración cuando los tokens lo permiten.

## Política de grupos

- `channels.slack.groupPolicy` controla el manejo de canales (`open|disabled|allowlist`).
- `allowlist` requiere que los canales estén listados en `channels.slack.channels`.
- Si solo configura `SLACK_BOT_TOKEN`/`SLACK_APP_TOKEN` y nunca crea una sección `channels.slack`,
  el tiempo de ejecución establece `groupPolicy` en `open` de forma predeterminada. Agregue `channels.slack.groupPolicy`,
  `channels.defaults.groupPolicy` o una lista de permitidos de canales para reforzarlo.
- El asistente de configuración acepta nombres `#channel` y los resuelve a IDs cuando es posible
  (públicos + privados); si existen múltiples coincidencias, prefiere el canal activo.
- Al iniciar, OpenClaw resuelve nombres de canal/usuario en listas de permitidos a IDs (cuando los tokens lo permiten)
  y registra el mapeo; las entradas no resueltas se mantienen tal como se escribieron.
- Para permitir **ningún canal**, configure `channels.slack.groupPolicy: "disabled"` (o mantenga una lista de permitidos vacía).

Opciones de canal (`channels.slack.channels.<id>` o `channels.slack.channels.<name>`):

- `allow`: permitir/denegar el canal cuando `groupPolicy="allowlist"`.
- `requireMention`: control por mención para el canal.
- `tools`: anulaciones opcionales de política de herramientas por canal (`allow`/`deny`/`alsoAllow`).
- `toolsBySender`: anulaciones opcionales de política de herramientas por remitente dentro del canal (las claves son ids de remitente/@handles/correos; se admite el comodín `"*"`).
- `allowBots`: permitir mensajes creados por el bot en este canal (predeterminado: false).
- `users`: lista de permitidos de usuarios opcional por canal.
- `skills`: filtro de skills (omitir = todas las skills, vacío = ninguna).
- `systemPrompt`: prompt de sistema adicional para el canal (combinado con el tema/propósito).
- `enabled`: configure `false` para deshabilitar el canal.

## Destinos de entrega

Úselos con envíos por cron/CLI:

- `user:<id>` para DMs
- `channel:<id>` para canales

## Acciones de herramientas

Las acciones de herramientas de Slack pueden controlarse con `channels.slack.actions.*`:

| Grupo de acciones | Predeterminado | Notas                          |
| ----------------- | -------------- | ------------------------------ |
| reactions         | habilitado     | Reaccionar + listar reacciones |
| messages          | habilitado     | Leer/enviar/editar/eliminar    |
| pins              | habilitado     | Fijar/desfijar/listar          |
| memberInfo        | habilitado     | Información de miembros        |
| emojiList         | habilitado     | Lista de emoji personalizados  |

## Notas de seguridad

- Las escrituras usan por defecto el token del bot para que las acciones que cambian el estado queden dentro de los
  permisos e identidad del bot de la app.
- Configurar `userTokenReadOnly: false` permite usar el token de usuario para operaciones de
  escritura cuando no hay token de bot disponible, lo que significa que las acciones se ejecutan con el
  acceso del usuario que instaló la app. Trate el token de usuario como altamente privilegiado y mantenga
  estrictos los controles de acciones y listas de permitidos.
- Si habilita escrituras con token de usuario, asegúrese de que el token de usuario incluya los alcances de escritura
  esperados (`chat:write`, `reactions:write`, `pins:write`,
  `files:write`) o esas operaciones fallarán.

## Solución de problemas

Ejecute primero esta escalera:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Luego confirme el estado de emparejamiento de DMs si es necesario:

```bash
openclaw pairing list slack
```

Fallas comunes:

- Conectado pero sin respuestas en canales: el canal está bloqueado por `groupPolicy` o no está en la lista de permitidos `channels.slack.channels`.
- DMs ignorados: el remitente no está aprobado cuando `channels.slack.dm.policy="pairing"`.
- Errores de API (`missing_scope`, `not_in_channel`, fallas de autenticación): los tokens de bot/app o los alcances de Slack están incompletos.

Para el flujo de triaje: [/channels/troubleshooting](/channels/troubleshooting).

## Notas

- El control por mención se gestiona mediante `channels.slack.channels` (configure `requireMention` en `true`); `agents.list[].groupChat.mentionPatterns` (o `messages.groupChat.mentionPatterns`) también cuentan como menciones.
- Anulación multi‑agente: configure patrones por agente en `agents.list[].groupChat.mentionPatterns`.
- Las notificaciones de reacciones siguen `channels.slack.reactionNotifications` (use `reactionAllowlist` con el modo `allowlist`).
- Los mensajes creados por el bot se ignoran por defecto; habilite mediante `channels.slack.allowBots` o `channels.slack.channels.<id>.allowBots`.
- Advertencia: si permite respuestas a otros bots (`channels.slack.allowBots=true` o `channels.slack.channels.<id>.allowBots=true`), evite bucles de respuestas entre bots con listas de permitidos `requireMention`, `channels.slack.channels.<id>.users` y/o eliminando guardas en `AGENTS.md` y `SOUL.md`.
- Para la herramienta de Slack, la semántica de eliminación de reacciones está en [/tools/reactions](/tools/reactions).
- Los adjuntos se descargan al almacén de medios cuando está permitido y por debajo del límite de tamaño.
