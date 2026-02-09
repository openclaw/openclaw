---
summary: "iMessage vía el servidor macOS de BlueBubbles (envío/recepción REST, escritura, reacciones, emparejamiento, acciones avanzadas)."
read_when:
  - Configuración del canal BlueBubbles
  - Solución de problemas de emparejamiento de webhooks
  - Configuración de iMessage en macOS
title: "BlueBubbles"
---

# BlueBubbles (macOS REST)

Estado: plugin incluido que se comunica con el servidor macOS de BlueBubbles mediante HTTP. **Recomendado para la integración con iMessage** debido a su API más rica y una configuración más sencilla en comparación con el canal imsg heredado.

## Descripción general

- Se ejecuta en macOS mediante la aplicación auxiliar de BlueBubbles ([bluebubbles.app](https://bluebubbles.app)).
- Recomendado/probado: macOS Sequoia (15). macOS Tahoe (26) funciona; la edición está actualmente rota en Tahoe y las actualizaciones del icono de grupo pueden informar éxito pero no sincronizarse.
- OpenClaw se comunica con él a través de su API REST (`GET /api/v1/ping`, `POST /message/text`, `POST /chat/:id/*`).
- Los mensajes entrantes llegan vía webhooks; las respuestas salientes, indicadores de escritura, confirmaciones de lectura y tapbacks son llamadas REST.
- Los adjuntos y stickers se ingieren como medios entrantes (y se exponen al agente cuando es posible).
- El emparejamiento/lista de permitidos funciona de la misma manera que otros canales (`/channels/pairing`, etc.) con `channels.bluebubbles.allowFrom` + códigos de emparejamiento.
- Las reacciones se exponen como eventos del sistema, igual que en Slack/Telegram, para que los agentes puedan “mencionarlas” antes de responder.
- Funciones avanzadas: editar, anular envío, hilos de respuesta, efectos de mensaje, gestión de grupos.

## Inicio rápido

1. Instale el servidor de BlueBubbles en su Mac (siga las instrucciones en [bluebubbles.app/install](https://bluebubbles.app/install)).

2. En la configuración de BlueBubbles, habilite la API web y establezca una contraseña.

3. Ejecute `openclaw onboard` y seleccione BlueBubbles, o configure manualmente:

   ```json5
   {
     channels: {
       bluebubbles: {
         enabled: true,
         serverUrl: "http://192.168.1.100:1234",
         password: "example-password",
         webhookPath: "/bluebubbles-webhook",
       },
     },
   }
   ```

4. Apunte los webhooks de BlueBubbles a su Gateway (ejemplo: `https://your-gateway-host:3000/bluebubbles-webhook?password=<password>`).

5. Inicie el Gateway; registrará el manejador de webhooks y comenzará el emparejamiento.

## Mantener Messages.app activo (VM / configuraciones sin interfaz)

Algunas configuraciones de macOS en VM / siempre encendidas pueden provocar que Messages.app quede “inactivo” (los eventos entrantes se detienen hasta que la app se abre o pasa a primer plano). Una solución sencilla es **estimular Messages cada 5 minutos** usando un AppleScript + LaunchAgent.

### 1. Guardar el AppleScript

Guardar esto como:

- `~/Scripts/poke-messages.scpt`

Script de ejemplo (no interactivo; no roba el foco):

```applescript
try
  tell application "Messages"
    if not running then
      launch
    end if

    -- Touch the scripting interface to keep the process responsive.
    set _chatCount to (count of chats)
  end tell
on error
  -- Ignore transient failures (first-run prompts, locked session, etc).
end try
```

### 2. Instalar un LaunchAgent

Guardar esto como:

- `~/Library/LaunchAgents/com.user.poke-messages.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.user.poke-messages</string>

    <key>ProgramArguments</key>
    <array>
      <string>/bin/bash</string>
      <string>-lc</string>
      <string>/usr/bin/osascript &quot;$HOME/Scripts/poke-messages.scpt&quot;</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>StartInterval</key>
    <integer>300</integer>

    <key>StandardOutPath</key>
    <string>/tmp/poke-messages.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/poke-messages.err</string>
  </dict>
</plist>
```

Notas:

- Esto se ejecuta **cada 300 segundos** y **al iniciar sesión**.
- La primera ejecución puede activar avisos de **Automatización** de macOS (`osascript` → Messages). Apruébelos en la misma sesión de usuario que ejecuta el LaunchAgent.

Cargarlo:

```bash
launchctl unload ~/Library/LaunchAgents/com.user.poke-messages.plist 2>/dev/null || true
launchctl load ~/Library/LaunchAgents/com.user.poke-messages.plist
```

## Embarque

BlueBubbles está disponible en el asistente de configuración interactivo:

```
openclaw onboard
```

El asistente solicita:

- **URL del servidor** (obligatorio): dirección del servidor BlueBubbles (p. ej., `http://192.168.1.100:1234`)
- **Contraseña** (obligatoria): contraseña de la API desde la configuración del servidor BlueBubbles
- **Ruta del webhook** (opcional): valor predeterminado `/bluebubbles-webhook`
- **Política de mensajes directos**: emparejamiento, lista de permitidos, abierto o deshabilitado
- **Lista de permitidos**: números de teléfono, correos electrónicos o destinos de chat

También puede agregar BlueBubbles vía CLI:

```
openclaw channels add bluebubbles --http-url http://192.168.1.100:1234 --password <password>
```

## Control de acceso (mensajes directos + grupos)

DMs:

- Predeterminado: `channels.bluebubbles.dmPolicy = "pairing"`.
- Los remitentes desconocidos reciben un código de emparejamiento; los mensajes se ignoran hasta que se aprueban (los códigos expiran después de 1 hora).
- Aprobar vía:
  - `openclaw pairing list bluebubbles`
  - `openclaw pairing approve bluebubbles <CODE>`
- El emparejamiento es el intercambio de tokens predeterminado. Detalles: [Pairing](/channels/pairing)

Grupos:

- `channels.bluebubbles.groupPolicy = open | allowlist | disabled` (predeterminado: `allowlist`).
- `channels.bluebubbles.groupAllowFrom` controla quién puede activar en grupos cuando `allowlist` está configurado.

### Filtrado por mención (grupos)

BlueBubbles admite filtrado por mención para chats grupales, coincidiendo con el comportamiento de iMessage/WhatsApp:

- Usa `agents.list[].groupChat.mentionPatterns` (o `messages.groupChat.mentionPatterns`) para detectar menciones.
- Cuando `requireMention` está habilitado para un grupo, el agente solo responde cuando se le menciona.
- Los comandos de control de remitentes autorizados omiten el filtrado por mención.

Configuración por grupo:

```json5
{
  channels: {
    bluebubbles: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15555550123"],
      groups: {
        "*": { requireMention: true }, // default for all groups
        "iMessage;-;chat123": { requireMention: false }, // override for specific group
      },
    },
  },
}
```

### Compuerta de comandos

- Los comandos de control (p. ej., `/config`, `/model`) requieren autorización.
- Usa `allowFrom` y `groupAllowFrom` para determinar la autorización de comandos.
- Los remitentes autorizados pueden ejecutar comandos de control incluso sin mencionar en grupos.

## Escritura + confirmaciones de lectura

- **Indicadores de escritura**: se envían automáticamente antes y durante la generación de la respuesta.
- **Confirmaciones de lectura**: controladas por `channels.bluebubbles.sendReadReceipts` (predeterminado: `true`).
- **Indicadores de escritura**: OpenClaw envía eventos de inicio de escritura; BlueBubbles limpia la escritura automáticamente al enviar o por tiempo de espera (la detención manual vía DELETE no es fiable).

```json5
{
  channels: {
    bluebubbles: {
      sendReadReceipts: false, // disable read receipts
    },
  },
}
```

## Acciones avanzadas

BlueBubbles admite acciones avanzadas de mensajes cuando se habilitan en la configuración:

```json5
{
  channels: {
    bluebubbles: {
      actions: {
        reactions: true, // tapbacks (default: true)
        edit: true, // edit sent messages (macOS 13+, broken on macOS 26 Tahoe)
        unsend: true, // unsend messages (macOS 13+)
        reply: true, // reply threading by message GUID
        sendWithEffect: true, // message effects (slam, loud, etc.)
        renameGroup: true, // rename group chats
        setGroupIcon: true, // set group chat icon/photo (flaky on macOS 26 Tahoe)
        addParticipant: true, // add participants to groups
        removeParticipant: true, // remove participants from groups
        leaveGroup: true, // leave group chats
        sendAttachment: true, // send attachments/media
      },
    },
  },
}
```

Acciones disponibles:

- **react**: agregar/quitar reacciones tapback (`messageId`, `emoji`, `remove`)
- **edit**: editar un mensaje enviado (`messageId`, `text`)
- **unsend**: anular el envío de un mensaje (`messageId`)
- **reply**: responder a un mensaje específico (`messageId`, `text`, `to`)
- **sendWithEffect**: enviar con efecto de iMessage (`text`, `to`, `effectId`)
- **renameGroup**: renombrar un chat grupal (`chatGuid`, `displayName`)
- **setGroupIcon**: establecer el icono/foto de un chat grupal (`chatGuid`, `media`) — inestable en macOS 26 Tahoe (la API puede devolver éxito pero el icono no se sincroniza).
- **addParticipant**: agregar a alguien a un grupo (`chatGuid`, `address`)
- **removeParticipant**: quitar a alguien de un grupo (`chatGuid`, `address`)
- **leaveGroup**: salir de un chat grupal (`chatGuid`)
- **sendAttachment**: enviar medios/archivos (`to`, `buffer`, `filename`, `asVoice`)
  - Notas de voz: configure `asVoice: true` con audio **MP3** o **CAF** para enviar como mensaje de voz de iMessage. BlueBubbles convierte MP3 → CAF al enviar notas de voz.

### IDs de mensajes (corto vs completo)

OpenClaw puede exponer IDs de mensajes _cortos_ (p. ej., `1`, `2`) para ahorrar tokens.

- `MessageSid` / `ReplyToId` pueden ser IDs cortos.
- `MessageSidFull` / `ReplyToIdFull` contienen los IDs completos del proveedor.
- Los IDs cortos están en memoria; pueden expirar al reiniciar o por expulsión de caché.
- Las acciones aceptan `messageId` cortos o completos, pero los IDs cortos fallarán si ya no están disponibles.

Use IDs completos para automatizaciones y almacenamiento duraderos:

- Plantillas: `{{MessageSidFull}}`, `{{ReplyToIdFull}}`
- Contexto: `MessageSidFull` / `ReplyToIdFull` en cargas útiles entrantes

Consulte [Configuration](/gateway/configuration) para variables de plantillas.

## Streaming por bloques

Controle si las respuestas se envían como un solo mensaje o se transmiten en bloques:

```json5
{
  channels: {
    bluebubbles: {
      blockStreaming: true, // enable block streaming (off by default)
    },
  },
}
```

## Medios + límites

- Los adjuntos entrantes se descargan y almacenan en la caché de medios.
- Límite de medios vía `channels.bluebubbles.mediaMaxMb` (predeterminado: 8 MB).
- El texto saliente se fragmenta a `channels.bluebubbles.textChunkLimit` (predeterminado: 4000 caracteres).

## Referencia de configuración

Configuración completa: [Configuration](/gateway/configuration)

Opciones del proveedor:

- `channels.bluebubbles.enabled`: habilitar/deshabilitar el canal.
- `channels.bluebubbles.serverUrl`: URL base de la API REST de BlueBubbles.
- `channels.bluebubbles.password`: contraseña de la API.
- `channels.bluebubbles.webhookPath`: ruta del endpoint del webhook (predeterminado: `/bluebubbles-webhook`).
- `channels.bluebubbles.dmPolicy`: `pairing | allowlist | open | disabled` (predeterminado: `pairing`).
- `channels.bluebubbles.allowFrom`: lista de permitidos de mensajes directos (identificadores, correos, números E.164, `chat_id:*`, `chat_guid:*`).
- `channels.bluebubbles.groupPolicy`: `open | allowlist | disabled` (predeterminado: `allowlist`).
- `channels.bluebubbles.groupAllowFrom`: lista de permitidos de remitentes de grupo.
- `channels.bluebubbles.groups`: configuración por grupo (`requireMention`, etc.).
- `channels.bluebubbles.sendReadReceipts`: enviar confirmaciones de lectura (predeterminado: `true`).
- `channels.bluebubbles.blockStreaming`: habilitar streaming por bloques (predeterminado: `false`; requerido para respuestas en streaming).
- `channels.bluebubbles.textChunkLimit`: tamaño del fragmento saliente en caracteres (predeterminado: 4000).
- `channels.bluebubbles.chunkMode`: `length` (predeterminado) divide solo al exceder `textChunkLimit`; `newline` divide en líneas en blanco (límites de párrafo) antes de fragmentar por longitud.
- `channels.bluebubbles.mediaMaxMb`: límite de medios entrantes en MB (predeterminado: 8).
- `channels.bluebubbles.historyLimit`: máximo de mensajes de grupo para contexto (0 deshabilita).
- `channels.bluebubbles.dmHistoryLimit`: límite de historial de mensajes directos.
- `channels.bluebubbles.actions`: habilitar/deshabilitar acciones específicas.
- `channels.bluebubbles.accounts`: configuración multi-cuenta.

Opciones globales relacionadas:

- `agents.list[].groupChat.mentionPatterns` (o `messages.groupChat.mentionPatterns`).
- `messages.responsePrefix`.

## Direccionamiento / destinos de entrega

Prefiera `chat_guid` para un enrutamiento estable:

- `chat_guid:iMessage;-;+15555550123` (preferido para grupos)
- `chat_id:123`
- `chat_identifier:...`
- Identificadores directos: `+15555550123`, `user@example.com`
  - Si un identificador directo no tiene un chat de mensajes directos existente, OpenClaw creará uno vía `POST /api/v1/chat/new`. Esto requiere que la API privada de BlueBubbles esté habilitada.

## Seguridad

- Las solicitudes de webhook se autentican comparando los parámetros de consulta o encabezados `guid`/`password` contra `channels.bluebubbles.password`. También se aceptan solicitudes desde `localhost`.
- Mantenga la contraseña de la API y el endpoint del webhook en secreto (trátelos como credenciales).
- La confianza en localhost significa que un proxy inverso en el mismo host puede omitir involuntariamente la contraseña. Si hace proxy del Gateway, exija autenticación en el proxy y configure `gateway.trustedProxies`. Consulte [Gateway security](/gateway/security#reverse-proxy-configuration).
- Habilite HTTPS + reglas de firewall en el servidor BlueBubbles si lo expone fuera de su LAN.

## Solución de problemas

- Si los eventos de escritura/lectura dejan de funcionar, revise los registros de webhooks de BlueBubbles y verifique que la ruta del Gateway coincida con `channels.bluebubbles.webhookPath`.
- Los códigos de emparejamiento expiran después de una hora; use `openclaw pairing list bluebubbles` y `openclaw pairing approve bluebubbles <code>`.
- Las reacciones requieren la API privada de BlueBubbles (`POST /api/v1/message/react`); asegúrese de que la versión del servidor la exponga.
- Editar/anular envío requiere macOS 13+ y una versión compatible del servidor BlueBubbles. En macOS 26 (Tahoe), la edición está actualmente rota debido a cambios en la API privada.
- Las actualizaciones del icono de grupo pueden ser inestables en macOS 26 (Tahoe): la API puede devolver éxito pero el nuevo icono no se sincroniza.
- OpenClaw oculta automáticamente acciones conocidas como rotas según la versión de macOS del servidor BlueBubbles. Si editar aún aparece en macOS 26 (Tahoe), desactívelo manualmente con `channels.bluebubbles.actions.edit=false`.
- Para información de estado/salud: `openclaw status --all` o `openclaw status --deep`.

Para una referencia general del flujo de trabajo de canales, consulte [Channels](/channels) y la guía de [Plugins](/tools/plugin).
