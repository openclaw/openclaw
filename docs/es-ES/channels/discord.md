---
summary: "Estado de soporte de bot de Discord, capacidades y configuración"
read_when:
  - Trabajando en características del canal de Discord
title: "Discord"
---

# Discord (API de Bot)

Estado: listo para DMs y canales de servidor a través del gateway oficial de Discord.

<CardGroup cols={3}>
  <Card title="Emparejamiento" icon="link" href="/es-ES/channels/pairing">
    Los DMs de Discord tienen modo de emparejamiento predeterminado.
  </Card>
  <Card title="Comandos de barra" icon="terminal" href="/es-ES/tools/slash-commands">
    Comportamiento de comandos nativos y catálogo de comandos.
  </Card>
  <Card title="Solución de problemas de canales" icon="wrench" href="/es-ES/channels/troubleshooting">
    Diagnósticos entre canales y flujo de reparación.
  </Card>
</CardGroup>

## Configuración rápida

<Steps>
  <Step title="Crear un bot de Discord y habilitar intents">
    Crea una aplicación en el Portal de Desarrolladores de Discord, agrega un bot, luego habilita:

    - **Message Content Intent**
    - **Server Members Intent** (requerido para listas de permitidos de roles y enrutamiento basado en roles; recomendado para coincidencia de lista de permitidos de nombre a ID)

  </Step>

  <Step title="Configurar token">

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: "YOUR_BOT_TOKEN",
    },
  },
}
```

    Alternativa de entorno para la cuenta predeterminada:

```bash
DISCORD_BOT_TOKEN=...
```

  </Step>

  <Step title="Invitar el bot e iniciar gateway">
    Invita el bot a tu servidor con permisos de mensajes.

```bash
openclaw gateway
```

  </Step>

  <Step title="Aprobar primer emparejamiento DM">

```bash
openclaw pairing list discord
openclaw pairing approve discord <CODE>
```

    Los códigos de emparejamiento expiran después de 1 hora.

  </Step>
</Steps>

<Note>
La resolución de tokens es consciente de la cuenta. Los valores de token de configuración ganan sobre la alternativa de entorno. `DISCORD_BOT_TOKEN` solo se usa para la cuenta predeterminada.
</Note>

## Modelo de tiempo de ejecución

- El gateway posee la conexión de Discord.
- El enrutamiento de respuestas es determinístico: las respuestas entrantes de Discord regresan a Discord.
- De forma predeterminada (`session.dmScope=main`), los chats directos comparten la sesión principal del agente (`agent:main:main`).
- Los canales de servidor están aislados con claves de sesión (`agent:<agentId>:discord:channel:<channelId>`).
- Los DMs de grupo se ignoran de forma predeterminada (`channels.discord.dm.groupEnabled=false`).
- Los comandos de barra nativos se ejecutan en sesiones de comando aisladas (`agent:<agentId>:discord:slash:<userId>`), mientras aún llevan `CommandTargetSessionKey` a la sesión de conversación enrutada.

## Componentes interactivos

OpenClaw admite contenedores de componentes v2 de Discord para mensajes de agentes. Usa la herramienta de mensajes con una carga útil de `components`. Los resultados de interacción se enrutan de vuelta al agente como mensajes entrantes normales y siguen la configuración existente de `replyToMode` de Discord.

Bloques compatibles:

- `text`, `section`, `separator`, `actions`, `media-gallery`, `file`
- Las filas de acción permiten hasta 5 botones o un solo menú de selección
- Tipos de selección: `string`, `user`, `role`, `mentionable`, `channel`

De forma predeterminada, los componentes son de un solo uso. Establece `components.reusable=true` para permitir que los botones, selecciones y formularios se usen múltiples veces hasta que expiren.

Para restringir quién puede hacer clic en un botón, establece `allowedUsers` en ese botón (IDs de usuario de Discord, etiquetas o `*`). Cuando está configurado, los usuarios no coincidentes reciben una denegación efímera.

Archivos adjuntos:

- Los bloques `file` deben apuntar a una referencia de adjunto (`attachment://<filename>`)
- Proporciona el adjunto a través de `media`/`path`/`filePath` (archivo único); usa `media-gallery` para múltiples archivos
- Usa `filename` para anular el nombre de carga cuando debe coincidir con la referencia de adjunto

Formularios modales:

- Agrega `components.modal` con hasta 5 campos
- Tipos de campo: `text`, `checkbox`, `radio`, `select`, `role-select`, `user-select`
- OpenClaw agrega un botón de activación automáticamente

Ejemplo:

```json5
{
  channel: "discord",
  action: "send",
  to: "channel:123456789012345678",
  message: "Optional fallback text",
  components: {
    reusable: true,
    text: "Choose a path",
    blocks: [
      {
        type: "actions",
        buttons: [
          {
            label: "Approve",
            style: "success",
            allowedUsers: ["123456789012345678"],
          },
          { label: "Decline", style: "danger" },
        ],
      },
      {
        type: "actions",
        select: {
          type: "string",
          placeholder: "Pick an option",
          options: [
            { label: "Option A", value: "a" },
            { label: "Option B", value: "b" },
          ],
        },
      },
    ],
    modal: {
      title: "Details",
      triggerLabel: "Open form",
      fields: [
        { type: "text", label: "Requester" },
        {
          type: "select",
          label: "Priority",
          options: [
            { label: "Low", value: "low" },
            { label: "High", value: "high" },
          ],
        },
      ],
    },
  },
}
```

## Control de acceso y enrutamiento

<Tabs>
  <Tab title="Política DM">
    `channels.discord.dmPolicy` controla el acceso DM (heredado: `channels.discord.dm.policy`):

    - `pairing` (predeterminado)
    - `allowlist`
    - `open` (requiere que `channels.discord.allowFrom` incluya `"*"`; heredado: `channels.discord.dm.allowFrom`)
    - `disabled`

    Si la política DM no es abierta, los usuarios desconocidos se bloquean (o se les solicita emparejamiento en modo `pairing`).

    Formato de objetivo DM para entrega:

    - `user:<id>`
    - mención `<@id>`

    Los IDs numéricos simples son ambiguos y se rechazan a menos que se proporcione un tipo de objetivo de usuario/canal explícito.

  </Tab>

  <Tab title="Política de servidor">
    El manejo de servidores está controlado por `channels.discord.groupPolicy`:

    - `open`
    - `allowlist`
    - `disabled`

    La línea base segura cuando existe `channels.discord` es `allowlist`.

    Comportamiento de `allowlist`:

    - el servidor debe coincidir con `channels.discord.guilds` (se prefiere `id`, se acepta slug)
    - listas de permitidos de remitente opcionales: `users` (IDs o nombres) y `roles` (solo IDs de rol); si alguno está configurado, los remitentes se permiten cuando coinciden con `users` O `roles`
    - si un servidor tiene `channels` configurados, los canales no listados se niegan
    - si un servidor no tiene bloque `channels`, todos los canales en ese servidor de lista de permitidos están permitidos

    Ejemplo:

```json5
{
  channels: {
    discord: {
      groupPolicy: "allowlist",
      guilds: {
        "123456789012345678": {
          requireMention: true,
          users: ["987654321098765432"],
          roles: ["123456789012345678"],
          channels: {
            general: { allow: true },
            help: { allow: true, requireMention: true },
          },
        },
      },
    },
  },
}
```

    Si solo estableces `DISCORD_BOT_TOKEN` y no creas un bloque `channels.discord`, la alternativa en tiempo de ejecución es `groupPolicy="open"` (con una advertencia en los logs).

  </Tab>

  <Tab title="Menciones y DMs de grupo">
    Los mensajes de servidor tienen bloqueo de mención de forma predeterminada.

    La detección de menciones incluye:

    - mención explícita del bot
    - patrones de mención configurados (`agents.list[].groupChat.mentionPatterns`, alternativa `messages.groupChat.mentionPatterns`)
    - comportamiento implícito de respuesta al bot en casos compatibles

    `requireMention` se configura por servidor/canal (`channels.discord.guilds...`).

    DMs de grupo:

    - predeterminado: ignorado (`dm.groupEnabled=false`)
    - lista de permitidos opcional a través de `dm.groupChannels` (IDs de canal o slugs)

  </Tab>
</Tabs>

### Enrutamiento de agente basado en roles

Usa `bindings[].match.roles` para enrutar miembros de servidores de Discord a diferentes agentes por ID de rol. Los enlaces basados en roles aceptan solo IDs de rol y se evalúan después de enlaces peer o parent-peer y antes de enlaces solo de servidor. Si un enlace también establece otros campos de coincidencia (por ejemplo `peer` + `guildId` + `roles`), todos los campos configurados deben coincidir.

```json5
{
  bindings: [
    {
      agentId: "opus",
      match: {
        channel: "discord",
        guildId: "123456789012345678",
        roles: ["111111111111111111"],
      },
    },
    {
      agentId: "sonnet",
      match: {
        channel: "discord",
        guildId: "123456789012345678",
      },
    },
  ],
}
```

## Configuración del Portal de Desarrolladores

<AccordionGroup>
  <Accordion title="Crear aplicación y bot">

    1. Portal de Desarrolladores de Discord -> **Applications** -> **New Application**
    2. **Bot** -> **Add Bot**
    3. Copiar token del bot

  </Accordion>

  <Accordion title="Intents privilegiados">
    En **Bot -> Privileged Gateway Intents**, habilita:

    - Message Content Intent
    - Server Members Intent (recomendado)

    El intent de presencia es opcional y solo se requiere si deseas recibir actualizaciones de presencia. Establecer la presencia del bot (`setPresence`) no requiere habilitar actualizaciones de presencia para miembros.

  </Accordion>

  <Accordion title="Alcances OAuth y permisos de línea base">
    Generador de URL OAuth:

    - alcances: `bot`, `applications.commands`

    Permisos de línea base típicos:

    - View Channels
    - Send Messages
    - Read Message History
    - Embed Links
    - Attach Files
    - Add Reactions (opcional)

    Evita `Administrator` a menos que se necesite explícitamente.

  </Accordion>

  <Accordion title="Copiar IDs">
    Habilita el Modo de Desarrollador de Discord, luego copia:

    - ID de servidor
    - ID de canal
    - ID de usuario

    Prefiere IDs numéricos en la configuración de OpenClaw para auditorías y sondeos confiables.

  </Accordion>
</AccordionGroup>

## Comandos nativos y autenticación de comandos

- `commands.native` tiene como valor predeterminado `"auto"` y está habilitado para Discord.
- Anulación por canal: `channels.discord.commands.native`.
- `commands.native=false` borra explícitamente comandos nativos de Discord previamente registrados.
- La autenticación de comandos nativos usa las mismas listas de permitidos/políticas de Discord que el manejo normal de mensajes.
- Los comandos aún pueden ser visibles en la interfaz de usuario de Discord para usuarios que no están autorizados; la ejecución aún aplica la autenticación de OpenClaw y devuelve "not authorized".

Ver [Comandos de barra](/es-ES/tools/slash-commands) para catálogo de comandos y comportamiento.

## Detalles de características

<AccordionGroup>
  <Accordion title="Etiquetas de respuesta y respuestas nativas">
    Discord admite etiquetas de respuesta en la salida del agente:

    - `[[reply_to_current]]`
    - `[[reply_to:<id>]]`

    Controlado por `channels.discord.replyToMode`:

    - `off` (predeterminado)
    - `first`
    - `all`

    Nota: `off` deshabilita el hilo de respuesta implícito. Las etiquetas explícitas `[[reply_to_*]]` todavía se respetan.

    Los IDs de mensaje se muestran en contexto/historial para que los agentes puedan dirigirse a mensajes específicos.

  </Accordion>

  <Accordion title="Historial, contexto y comportamiento de hilos">
    Contexto de historial de servidor:

    - `channels.discord.historyLimit` predeterminado `20`
    - alternativa: `messages.groupChat.historyLimit`
    - `0` deshabilita

    Controles de historial DM:

    - `channels.discord.dmHistoryLimit`
    - `channels.discord.dms["<user_id>"].historyLimit`

    Comportamiento de hilos:

    - Los hilos de Discord se enrutan como sesiones de canal
    - los metadatos del hilo padre se pueden usar para vinculación de sesión padre
    - la configuración de hilo hereda la configuración del canal padre a menos que exista una entrada específica de hilo

    Los temas de canal se inyectan como contexto **no confiable** (no como prompt del sistema).

  </Accordion>

  <Accordion title="Notificaciones de reacción">
    Modo de notificación de reacción por servidor:

    - `off`
    - `own` (predeterminado)
    - `all`
    - `allowlist` (usa `guilds.<id>.users`)

    Los eventos de reacción se convierten en eventos del sistema y se adjuntan a la sesión de Discord enrutada.

  </Accordion>

  <Accordion title="Reacciones de confirmación">
    `ackReaction` envía un emoji de confirmación mientras OpenClaw está procesando un mensaje entrante.

    Orden de resolución:

    - `channels.discord.accounts.<accountId>.ackReaction`
    - `channels.discord.ackReaction`
    - `messages.ackReaction`
    - alternativa de emoji de identidad del agente (`agents.list[].identity.emoji`, sino "👀")

    Notas:

    - Discord acepta emoji unicode o nombres de emoji personalizados.
    - Usa `""` para deshabilitar la reacción para un canal o cuenta.

  </Accordion>

  <Accordion title="Escrituras de configuración">
    Las escrituras de configuración iniciadas por el canal están habilitadas de forma predeterminada.

    Esto afecta los flujos de `/config set|unset` (cuando las características de comando están habilitadas).

    Deshabilitar:

```json5
{
  channels: {
    discord: {
      configWrites: false,
    },
  },
}
```

  </Accordion>

  <Accordion title="Proxy de gateway">
    Enruta el tráfico WebSocket del gateway de Discord y las búsquedas REST de inicio (ID de aplicación + resolución de lista de permitidos) a través de un proxy HTTP(S) con `channels.discord.proxy`.

```json5
{
  channels: {
    discord: {
      proxy: "http://proxy.example:8080",
    },
  },
}
```

    Anulación por cuenta:

```json5
{
  channels: {
    discord: {
      accounts: {
        primary: {
          proxy: "http://proxy.example:8080",
        },
      },
    },
  },
}
```

  </Accordion>

  <Accordion title="Soporte de PluralKit">
    Habilita la resolución de PluralKit para mapear mensajes proxy a la identidad del miembro del sistema:

```json5
{
  channels: {
    discord: {
      pluralkit: {
        enabled: true,
        token: "pk_live_...", // opcional; necesario para sistemas privados
      },
    },
  },
}
```

    Notas:

    - las listas de permitidos pueden usar `pk:<memberId>`
    - los nombres para mostrar de miembros se emparejan por nombre/slug
    - las búsquedas usan el ID de mensaje original y están restringidas por ventana de tiempo
    - si la búsqueda falla, los mensajes proxy se tratan como mensajes de bot y se descartan a menos que `allowBots=true`

  </Accordion>

  <Accordion title="Configuración de presencia">
    Las actualizaciones de presencia se aplican solo cuando estableces un campo de estado o actividad.

    Ejemplo solo de estado:

```json5
{
  channels: {
    discord: {
      status: "idle",
    },
  },
}
```

    Ejemplo de actividad (el estado personalizado es el tipo de actividad predeterminado):

```json5
{
  channels: {
    discord: {
      activity: "Focus time",
      activityType: 4,
    },
  },
}
```

    Ejemplo de streaming:

```json5
{
  channels: {
    discord: {
      activity: "Live coding",
      activityType: 1,
      activityUrl: "https://twitch.tv/openclaw",
    },
  },
}
```

    Mapa de tipo de actividad:

    - 0: Playing
    - 1: Streaming (requiere `activityUrl`)
    - 2: Listening
    - 3: Watching
    - 4: Custom (usa el texto de actividad como el estado state; emoji es opcional)
    - 5: Competing

  </Accordion>

  <Accordion title="Aprobaciones de exec en Discord">
    Discord admite aprobaciones de exec basadas en botones en DMs y opcionalmente puede publicar prompts de aprobación en el canal de origen.

    Ruta de configuración:

    - `channels.discord.execApprovals.enabled`
    - `channels.discord.execApprovals.approvers`
    - `channels.discord.execApprovals.target` (`dm` | `channel` | `both`, predeterminado: `dm`)
    - `agentFilter`, `sessionFilter`, `cleanupAfterResolve`

    Cuando `target` es `channel` o `both`, el prompt de aprobación es visible en el canal. Solo los aprobadores configurados pueden usar los botones; otros usuarios reciben una denegación efímera. Los prompts de aprobación incluyen el texto del comando, así que solo habilita la entrega de canal en canales confiables. Si el ID de canal no se puede derivar de la clave de sesión, OpenClaw recurre a la entrega DM.

    Si las aprobaciones fallan con IDs de aprobación desconocidos, verifica la lista de aprobadores y la habilitación de características.

    Documentación relacionada: [Aprobaciones de exec](/es-ES/tools/exec-approvals)

  </Accordion>
</AccordionGroup>

## Herramientas y puertas de acción

Las acciones de mensaje de Discord incluyen mensajería, administración de canal, moderación, presencia y acciones de metadatos.

Ejemplos principales:

- mensajería: `sendMessage`, `readMessages`, `editMessage`, `deleteMessage`, `threadReply`
- reacciones: `react`, `reactions`, `emojiList`
- moderación: `timeout`, `kick`, `ban`
- presencia: `setPresence`

Las puertas de acción viven bajo `channels.discord.actions.*`.

Comportamiento de puerta predeterminado:

| Grupo de acción                                                                                                                                                          | Predeterminado |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------- |
| reactions, messages, threads, pins, polls, search, memberInfo, roleInfo, channelInfo, channels, voiceStatus, events, stickers, emojiUploads, stickerUploads, permissions | habilitado     |
| roles                                                                                                                                                                    | deshabilitado  |
| moderation                                                                                                                                                               | deshabilitado  |
| presence                                                                                                                                                                 | deshabilitado  |

## UI de componentes v2

OpenClaw usa componentes v2 de Discord para aprobaciones de exec y marcadores de contexto cruzado. Las acciones de mensaje de Discord también pueden aceptar `components` para UI personalizada (avanzado; requiere instancias de componentes de Carbon), mientras que los `embeds` heredados permanecen disponibles pero no se recomiendan.

- `channels.discord.ui.components.accentColor` establece el color de acento usado por los contenedores de componentes de Discord (hex).
- Establece por cuenta con `channels.discord.accounts.<id>.ui.components.accentColor`.
- Los `embeds` se ignoran cuando los componentes v2 están presentes.

Ejemplo:

```json5
{
  channels: {
    discord: {
      ui: {
        components: {
          accentColor: "#5865F2",
        },
      },
    },
  },
}
```

## Mensajes de voz

Los mensajes de voz de Discord muestran una vista previa de forma de onda y requieren audio OGG/Opus más metadatos. OpenClaw genera la forma de onda automáticamente, pero necesita `ffmpeg` y `ffprobe` disponibles en el host del gateway para inspeccionar y convertir archivos de audio.

Requisitos y restricciones:

- Proporciona una **ruta de archivo local** (las URLs se rechazan).
- Omite el contenido de texto (Discord no permite texto + mensaje de voz en la misma carga útil).
- Se acepta cualquier formato de audio; OpenClaw convierte a OGG/Opus cuando es necesario.

Ejemplo:

```bash
message(action="send", channel="discord", target="channel:123", path="/path/to/audio.mp3", asVoice=true)
```

## Solución de problemas

<AccordionGroup>
  <Accordion title="Usó intents no permitidos o el bot no ve mensajes de servidor">

    - habilita Message Content Intent
    - habilita Server Members Intent cuando dependes de la resolución de usuario/miembro
    - reinicia el gateway después de cambiar intents

  </Accordion>

  <Accordion title="Mensajes de servidor bloqueados inesperadamente">

    - verifica `groupPolicy`
    - verifica lista de permitidos de servidor bajo `channels.discord.guilds`
    - si existe el mapa de `channels` del servidor, solo los canales listados están permitidos
    - verifica comportamiento de `requireMention` y patrones de mención

    Verificaciones útiles:

```bash
openclaw doctor
openclaw channels status --probe
openclaw logs --follow
```

  </Accordion>

  <Accordion title="Requiere mención falso pero aún bloqueado">
    Causas comunes:

    - `groupPolicy="allowlist"` sin lista de permitidos de servidor/canal coincidente
    - `requireMention` configurado en el lugar equivocado (debe estar bajo `channels.discord.guilds` o entrada de canal)
    - remitente bloqueado por lista de permitidos de `users` del servidor/canal

  </Accordion>

  <Accordion title="Desajustes de auditoría de permisos">
    Las verificaciones de permisos de `channels status --probe` solo funcionan para IDs de canal numéricos.

    Si usas claves slug, la coincidencia en tiempo de ejecución aún puede funcionar, pero el sondeo no puede verificar completamente los permisos.

  </Accordion>

  <Accordion title="Problemas de DM y emparejamiento">

    - DM deshabilitado: `channels.discord.dm.enabled=false`
    - Política DM deshabilitada: `channels.discord.dmPolicy="disabled"` (heredado: `channels.discord.dm.policy`)
    - esperando aprobación de emparejamiento en modo `pairing`

  </Accordion>

  <Accordion title="Bucles de bot a bot">
    De forma predeterminada, los mensajes creados por bots se ignoran.

    Si estableces `channels.discord.allowBots=true`, usa reglas estrictas de mención y lista de permitidos para evitar comportamiento de bucle.

  </Accordion>
</AccordionGroup>

## Punteros de referencia de configuración

Referencia principal:

- [Referencia de configuración - Discord](/es-ES/gateway/configuration-reference#discord)

Campos de Discord de alta señal:

- inicio/autenticación: `enabled`, `token`, `accounts.*`, `allowBots`
- política: `groupPolicy`, `dm.*`, `guilds.*`, `guilds.*.channels.*`
- comando: `commands.native`, `commands.useAccessGroups`, `configWrites`
- respuesta/historial: `replyToMode`, `historyLimit`, `dmHistoryLimit`, `dms.*.historyLimit`
- entrega: `textChunkLimit`, `chunkMode`, `maxLinesPerMessage`
- medios/reintento: `mediaMaxMb`, `retry`
- acciones: `actions.*`
- presencia: `activity`, `status`, `activityType`, `activityUrl`
- UI: `ui.components.accentColor`
- características: `pluralkit`, `execApprovals`, `intents`, `agentComponents`, `heartbeat`, `responsePrefix`

## Seguridad y operaciones

- Trata los tokens de bot como secretos (`DISCORD_BOT_TOKEN` preferido en entornos supervisados).
- Otorga permisos de Discord de menor privilegio.
- Si el despliegue/estado de comandos está obsoleto, reinicia el gateway y vuelve a verificar con `openclaw channels status --probe`.

## Relacionado

- [Emparejamiento](/es-ES/channels/pairing)
- [Enrutamiento de canales](/es-ES/channels/channel-routing)
- [Solución de problemas](/es-ES/channels/troubleshooting)
- [Comandos de barra](/es-ES/tools/slash-commands)
