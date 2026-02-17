---
summary: "Configuración y comportamiento en runtime de Slack (Socket Mode + HTTP Events API)"
read_when:
  - Configurando Slack o depurando modo socket/HTTP de Slack
title: "Slack"
---

# Slack

Estado: listo para producción para MD + canales vía integraciones de app Slack. El modo por defecto es Socket Mode; el modo HTTP Events API también está soportado.

<CardGroup cols={3}>
  <Card title="Emparejamiento" icon="link" href="/es-ES/channels/pairing">
    Los MD de Slack tienen por defecto el modo de emparejamiento.
  </Card>
  <Card title="Comandos slash" icon="terminal" href="/es-ES/tools/slash-commands">
    Comportamiento de comando nativo y catálogo de comandos.
  </Card>
  <Card title="Solución de problemas de canales" icon="wrench" href="/es-ES/channels/troubleshooting">
    Diagnósticos entre canales y guías de reparación.
  </Card>
</CardGroup>

## Configuración rápida

<Tabs>
  <Tab title="Socket Mode (por defecto)">
    <Steps>
      <Step title="Crear app Slack y tokens">
        En configuración de app Slack:

        - habilita **Socket Mode**
        - crea **App Token** (`xapp-...`) con `connections:write`
        - instala la app y copia **Bot Token** (`xoxb-...`)
      </Step>

      <Step title="Configurar OpenClaw">

```json5
{
  channels: {
    slack: {
      enabled: true,
      mode: "socket",
      appToken: "xapp-...",
      botToken: "xoxb-...",
    },
  },
}
```

        Respaldo de env (solo cuenta por defecto):

```bash
SLACK_APP_TOKEN=xapp-...
SLACK_BOT_TOKEN=xoxb-...
```

      </Step>

      <Step title="Suscribir eventos de app">
        Suscribe eventos de bot para:

        - `app_mention`
        - `message.channels`, `message.groups`, `message.im`, `message.mpim`
        - `reaction_added`, `reaction_removed`
        - `member_joined_channel`, `member_left_channel`
        - `channel_rename`
        - `pin_added`, `pin_removed`

        También habilita App Home **Messages Tab** para MD.
      </Step>

      <Step title="Iniciar gateway">

```bash
openclaw gateway
```

      </Step>
    </Steps>

  </Tab>

  <Tab title="Modo HTTP Events API">
    <Steps>
      <Step title="Configurar app Slack para HTTP">

        - establece modo a HTTP (`channels.slack.mode="http"`)
        - copia Slack **Signing Secret**
        - establece Event Subscriptions + Interactivity + Slash command Request URL a la misma ruta webhook (por defecto `/slack/events`)

      </Step>

      <Step title="Configurar OpenClaw modo HTTP">

```json5
{
  channels: {
    slack: {
      enabled: true,
      mode: "http",
      botToken: "xoxb-...",
      signingSecret: "tu-signing-secret",
      webhookPath: "/slack/events",
    },
  },
}
```

      </Step>

      <Step title="Usar rutas webhook únicas para multi-cuenta HTTP">
        El modo HTTP por cuenta está soportado.

        Dale a cada cuenta un `webhookPath` distinto para que los registros no colisionen.
      </Step>
    </Steps>

  </Tab>
</Tabs>

## Modelo de tokens

- `botToken` + `appToken` son requeridos para Socket Mode.
- El modo HTTP requiere `botToken` + `signingSecret`.
- Los tokens de configuración sobrescriben el respaldo env.
- El respaldo env `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN` aplica solo a la cuenta por defecto.
- `userToken` (`xoxp-...`) es solo-configuración (sin respaldo env) y por defecto tiene comportamiento de solo lectura (`userTokenReadOnly: true`).
- Opcional: agrega `chat:write.customize` si quieres que los mensajes salientes usen la identidad del agente activo (`username` e ícono personalizados). `icon_emoji` usa sintaxis `:emoji_name:`.

<Tip>
Para acciones/lecturas de directorio, el token de usuario puede ser preferido cuando está configurado. Para escrituras, el token de bot sigue siendo preferido; las escrituras de token de usuario solo se permiten cuando `userTokenReadOnly: false` y el token de bot no está disponible.
</Tip>

## Control de acceso y enrutamiento

<Tabs>
  <Tab title="Política MD">
    `channels.slack.dmPolicy` controla el acceso MD (legacy: `channels.slack.dm.policy`):

    - `pairing` (por defecto)
    - `allowlist`
    - `open` (requiere que `channels.slack.allowFrom` incluya `"*"`; legacy: `channels.slack.dm.allowFrom`)
    - `disabled`

    Flags MD:

    - `dm.enabled` (por defecto true)
    - `channels.slack.allowFrom` (preferido)
    - `dm.allowFrom` (legacy)
    - `dm.groupEnabled` (MD de grupo por defecto false)
    - `dm.groupChannels` (lista de permitidos MPIM opcional)

    Emparejamiento en MD usa `openclaw pairing approve slack <código>`.

  </Tab>

  <Tab title="Política de canal">
    `channels.slack.groupPolicy` controla el manejo de canales:

    - `open`
    - `allowlist`
    - `disabled`

    La lista de permitidos de canal vive bajo `channels.slack.channels`.

    Nota de runtime: si `channels.slack` está completamente faltante (configuración solo-env) y `channels.defaults.groupPolicy` no está establecido, runtime recurre a `groupPolicy="open"` y registra una advertencia.

    Resolución de nombre/ID:

    - las entradas de lista de permitidos de canal y entradas de lista de permitidos MD se resuelven al inicio cuando el acceso al token lo permite
    - las entradas no resueltas se mantienen como configuradas

  </Tab>

  <Tab title="Menciones y usuarios de canal">
    Los mensajes de canal tienen bloqueo por mención por defecto.

    Fuentes de mención:

    - mención explícita de app (`<@botId>`)
    - patrones regex de mención (`agents.list[].groupChat.mentionPatterns`, respaldo `messages.groupChat.mentionPatterns`)
    - comportamiento implícito de respuesta-al-bot en hilo

    Controles por canal (`channels.slack.channels.<id|name>`):

    - `requireMention`
    - `users` (lista de permitidos)
    - `allowBots`
    - `skills`
    - `systemPrompt`
    - `tools`, `toolsBySender`

  </Tab>
</Tabs>

## Comandos y comportamiento slash

- El modo auto de comando nativo está **desactivado** para Slack (`commands.native: "auto"` no habilita comandos nativos de Slack).
- Habilita manejadores de comando Slack nativos con `channels.slack.commands.native: true` (o global `commands.native: true`).
- Cuando los comandos nativos están habilitados, registra comandos slash coincidentes en Slack (nombres `/<comando>`).
- Si los comandos nativos no están habilitados, puedes ejecutar un solo comando slash configurado vía `channels.slack.slashCommand`.
- Los menús arg nativos ahora adaptan su estrategia de renderizado:
  - hasta 5 opciones: bloques de botones
  - 6-100 opciones: menú select estático
  - más de 100 opciones: select externo con filtrado de opciones asíncrono cuando los manejadores de opciones de interactividad están disponibles
  - si los valores de opciones codificadas exceden los límites de Slack, el flujo recurre a botones
- Para payloads de opciones largas, los menús de argumento de comando Slash usan un diálogo de confirmación antes de despachar un valor seleccionado.

Configuración de comando slash por defecto:

- `enabled: false`
- `name: "openclaw"`
- `sessionPrefix: "slack:slash"`
- `ephemeral: true`

Las sesiones slash usan claves aisladas:

- `agent:<agentId>:slack:slash:<userId>`

y aún enrutan la ejecución de comandos contra la sesión de conversación objetivo (`CommandTargetSessionKey`).

## Threading, sesiones y etiquetas de respuesta

- Los MD enrutan como `direct`; canales como `channel`; MPIMs como `group`.
- Con el `session.dmScope=main` por defecto, los MD de Slack colapsan a la sesión principal del agente.
- Sesiones de canal: `agent:<agentId>:slack:channel:<channelId>`.
- Las respuestas en hilo pueden crear sufijos de sesión de hilo (`:thread:<threadTs>`) cuando sea aplicable.
- `channels.slack.thread.historyScope` por defecto es `thread`; `thread.inheritParent` por defecto es `false`.
- `channels.slack.thread.initialHistoryLimit` controla cuántos mensajes de hilo existentes se obtienen cuando inicia una nueva sesión de hilo (por defecto `20`; establece `0` para desactivar).

Controles de threading de respuesta:

- `channels.slack.replyToMode`: `off|first|all` (por defecto `off`)
- `channels.slack.replyToModeByChatType`: por `direct|group|channel`
- respaldo legacy para chats directos: `channels.slack.dm.replyToMode`

Etiquetas de respuesta manual están soportadas:

- `[[reply_to_current]]`
- `[[reply_to:<id>]]`

Nota: `replyToMode="off"` deshabilita threading de respuesta implícito. Las etiquetas explícitas `[[reply_to_*]]` aún se respetan.

## Medios, división en chunks y entrega

<AccordionGroup>
  <Accordion title="Adjuntos entrantes">
    Los adjuntos de archivo de Slack se descargan desde URLs privadas alojadas en Slack (flujo de solicitud autenticado por token) y se escriben en el almacén de medios cuando la obtención tiene éxito y los límites de tamaño lo permiten.

    El límite de tamaño entrante en runtime por defecto es `20MB` a menos que se sobrescriba por `channels.slack.mediaMaxMb`.

  </Accordion>

  <Accordion title="Texto y archivos salientes">
    - los chunks de texto usan `channels.slack.textChunkLimit` (por defecto 4000)
    - `channels.slack.chunkMode="newline"` habilita división por párrafo primero
    - los envíos de archivo usan APIs de carga de Slack y pueden incluir respuestas en hilo (`thread_ts`)
    - el límite de medios salientes sigue `channels.slack.mediaMaxMb` cuando está configurado; de lo contrario los envíos de canal usan valores por defecto MIME-kind del pipeline de medios
  </Accordion>

  <Accordion title="Objetivos de entrega">
    Objetivos explícitos preferidos:

    - `user:<id>` para MD
    - `channel:<id>` para canales

    Los MD de Slack se abren vía APIs de conversación de Slack al enviar a objetivos de usuario.

  </Accordion>
</AccordionGroup>

## Acciones y puertas

Las acciones de Slack están controladas por `channels.slack.actions.*`.

Grupos de acción disponibles en tooling Slack actual:

| Grupo      | Por defecto |
| ---------- | ----------- |
| messages   | habilitado  |
| reactions  | habilitado  |
| pins       | habilitado  |
| memberInfo | habilitado  |
| emojiList  | habilitado  |

## Eventos y comportamiento operacional

- Las ediciones/eliminaciones de mensajes/broadcasts de hilo se mapean en eventos del sistema.
- Los eventos de agregar/eliminar reacción se mapean en eventos del sistema.
- Los eventos de unión/salida de miembro, canal creado/renombrado y agregar/eliminar pin se mapean en eventos del sistema.
- `channel_id_changed` puede migrar claves de configuración de canal cuando `configWrites` está habilitado.
- Los metadatos de tema/propósito del canal se tratan como contexto no confiable y se pueden inyectar en el contexto de enrutamiento.
- Las acciones de bloque e interacciones modales emiten eventos estructurados del sistema `Slack interaction: ...` con campos de payload ricos:
  - acciones de bloque: valores seleccionados, etiquetas, valores de picker y metadatos `workflow_*`
  - eventos modales `view_submission` y `view_closed` con metadatos de canal enrutados y entradas de formulario

## Reacciones ack

`ackReaction` envía un emoji de reconocimiento mientras OpenClaw está procesando un mensaje entrante.

Orden de resolución:

- `channels.slack.accounts.<accountId>.ackReaction`
- `channels.slack.ackReaction`
- `messages.ackReaction`
- respaldo de emoji de identidad del agente (`agents.list[].identity.emoji`, sino "👀")

Notas:

- Slack espera shortcodes (por ejemplo `"eyes"`).
- Usa `""` para deshabilitar la reacción para un canal o cuenta.

## Manifiesto y checklist de scopes

<AccordionGroup>
  <Accordion title="Ejemplo de manifiesto de app Slack">

```json
{
  "display_information": {
    "name": "OpenClaw",
    "description": "Conector Slack para OpenClaw"
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
        "description": "Enviar un mensaje a OpenClaw",
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
        "im:history",
        "mpim:history",
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

  </Accordion>

  <Accordion title="Scopes de token de usuario opcionales (operaciones de lectura)">
    Si configuras `channels.slack.userToken`, los scopes típicos de lectura son:

    - `channels:history`, `groups:history`, `im:history`, `mpim:history`
    - `channels:read`, `groups:read`, `im:read`, `mpim:read`
    - `users:read`
    - `reactions:read`
    - `pins:read`
    - `emoji:read`
    - `search:read` (si dependes de lecturas de búsqueda de Slack)

  </Accordion>
</AccordionGroup>

## Solución de problemas

<AccordionGroup>
  <Accordion title="Sin respuestas en canales">
    Verifica, en orden:

    - `groupPolicy`
    - lista de permitidos de canal (`channels.slack.channels`)
    - `requireMention`
    - lista de permitidos de `users` por canal

    Comandos útiles:

```bash
openclaw channels status --probe
openclaw logs --follow
openclaw doctor
```

  </Accordion>

  <Accordion title="Mensajes MD ignorados">
    Verifica:

    - `channels.slack.dm.enabled`
    - `channels.slack.dmPolicy` (o legacy `channels.slack.dm.policy`)
    - aprobaciones de emparejamiento / entradas de lista de permitidos

```bash
openclaw pairing list slack
```

  </Accordion>

  <Accordion title="Socket mode no conecta">
    Valida tokens de bot + app y habilitación de Socket Mode en configuración de app Slack.
  </Accordion>

  <Accordion title="Modo HTTP no recibe eventos">
    Valida:

    - signing secret
    - ruta webhook
    - URLs de solicitud de Slack (Eventos + Interactividad + Comandos Slash)
    - `webhookPath` único por cuenta HTTP

  </Accordion>

  <Accordion title="Comandos nativos/slash no se disparan">
    Verifica si pretendías:

    - modo de comando nativo (`channels.slack.commands.native: true`) con comandos slash coincidentes registrados en Slack
    - o modo de comando slash único (`channels.slack.slashCommand.enabled: true`)

    También verifica `commands.useAccessGroups` y listas de permitidos de canal/usuario.

  </Accordion>
</AccordionGroup>

## Referencias de configuración

Referencia principal:

- [Referencia de configuración - Slack](/es-ES/gateway/configuration-reference#slack)

  Campos Slack de alta señal:
  - modo/auth: `mode`, `botToken`, `appToken`, `signingSecret`, `webhookPath`, `accounts.*`
  - acceso MD: `dm.enabled`, `dmPolicy`, `allowFrom` (legacy: `dm.policy`, `dm.allowFrom`), `dm.groupEnabled`, `dm.groupChannels`
  - acceso de canal: `groupPolicy`, `channels.*`, `channels.*.users`, `channels.*.requireMention`
  - threading/historial: `replyToMode`, `replyToModeByChatType`, `thread.*`, `historyLimit`, `dmHistoryLimit`, `dms.*.historyLimit`
  - entrega: `textChunkLimit`, `chunkMode`, `mediaMaxMb`
  - ops/características: `configWrites`, `commands.native`, `slashCommand.*`, `actions.*`, `userToken`, `userTokenReadOnly`

## Relacionado

- [Emparejamiento](/es-ES/channels/pairing)
- [Enrutamiento de canales](/es-ES/channels/channel-routing)
- [Solución de problemas](/es-ES/channels/troubleshooting)
- [Configuración](/es-ES/gateway/configuration)
- [Comandos slash](/es-ES/tools/slash-commands)
