---
summary: "iMessage vía servidor macOS BlueBubbles (REST envío/recepción, escritura, reacciones, emparejamiento, acciones avanzadas)."
read_when:
  - Configurando canal BlueBubbles
  - Solucionando problemas de emparejamiento webhook
  - Configurando iMessage en macOS
title: "BlueBubbles"
---

# BlueBubbles (macOS REST)

Estado: plugin incluido que se comunica con el servidor macOS BlueBubbles sobre HTTP. **Recomendado para integración iMessage** debido a su API más rica y configuración más fácil comparado con el canal imsg legacy.

## Descripción general

- Se ejecuta en macOS vía la app helper BlueBubbles ([bluebubbles.app](https://bluebubbles.app)).
- Recomendado/probado: macOS Sequoia (15). macOS Tahoe (26) funciona; edición está actualmente rota en Tahoe, y actualizaciones de ícono de grupo pueden reportar éxito pero no sincronizar.
- OpenClaw se comunica con él a través de su API REST (`GET /api/v1/ping`, `POST /message/text`, `POST /chat/:id/*`).
- Los mensajes entrantes llegan vía webhooks; respuestas salientes, indicadores de escritura, confirmaciones de lectura y tapbacks son llamadas REST.
- Adjuntos y stickers se ingestan como medios entrantes (y se exponen al agente cuando es posible).
- Emparejamiento/lista de permitidos funciona de la misma manera que otros canales (`/channels/pairing` etc) con `channels.bluebubbles.allowFrom` + códigos de emparejamiento.
- Las reacciones se exponen como eventos del sistema igual que Slack/Telegram para que los agentes puedan "mencionarlas" antes de responder.
- Características avanzadas: editar, desenviar, hilos de respuesta, efectos de mensaje, gestión de grupos.

## Inicio rápido

1. Instala el servidor BlueBubbles en tu Mac (sigue las instrucciones en [bluebubbles.app/install](https://bluebubbles.app/install)).
2. En la configuración de BlueBubbles, habilita la API web y establece una contraseña.
3. Ejecuta `openclaw onboard` y selecciona BlueBubbles, o configura manualmente:

   ```json5
   {
     channels: {
       bluebubbles: {
         enabled: true,
         serverUrl: "http://192.168.1.100:1234",
         password: "ejemplo-contraseña",
         webhookPath: "/bluebubbles-webhook",
       },
     },
   }
   ```

4. Apunta los webhooks de BlueBubbles a tu gateway (ejemplo: `https://tu-host-gateway:3000/bluebubbles-webhook?password=<contraseña>`).
5. Inicia el gateway; registrará el manejador de webhook e iniciará el emparejamiento.

Nota de seguridad:

- Siempre establece una contraseña de webhook. Si expones el gateway a través de un proxy inverso (Tailscale Serve/Funnel, nginx, Cloudflare Tunnel, ngrok), el proxy puede conectarse al gateway sobre loopback. El manejador webhook de BlueBubbles trata las solicitudes con encabezados de reenvío como proxeadas y no aceptará webhooks sin contraseña.

## Mantener Messages.app vivo (configuraciones VM / headless)

Algunas configuraciones VM macOS / siempre-on pueden terminar con Messages.app quedando "inactivo" (eventos entrantes se detienen hasta que la app se abre/pasa a primer plano). Una solución simple es **hacer poke a Messages cada 5 minutos** usando un AppleScript + LaunchAgent.

### 1) Guarda el AppleScript

Guarda esto como:

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

### 2) Instala un LaunchAgent

Guarda esto como:

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
- La primera ejecución puede activar prompts de **Automatización** macOS (`osascript` → Messages). Apruébalos en la misma sesión de usuario que ejecuta el LaunchAgent.

Cárgalo:

```bash
launchctl unload ~/Library/LaunchAgents/com.user.poke-messages.plist 2>/dev/null || true
launchctl load ~/Library/LaunchAgents/com.user.poke-messages.plist
```

## Onboarding

BlueBubbles está disponible en el asistente de configuración interactivo:

```
openclaw onboard
```

El asistente solicita:

- **URL del servidor** (requerida): dirección del servidor BlueBubbles (ej., `http://192.168.1.100:1234`)
- **Contraseña** (requerida): contraseña API de configuración del servidor BlueBubbles
- **Ruta webhook** (opcional): por defecto `/bluebubbles-webhook`
- **Política MD**: pairing, allowlist, open, o disabled
- **Lista de permitidos**: números de teléfono, emails, u objetivos de chat

También puedes agregar BlueBubbles vía CLI:

```
openclaw channels add bluebubbles --http-url http://192.168.1.100:1234 --password <contraseña>
```

## Control de acceso (MD + grupos)

MD:

- Por defecto: `channels.bluebubbles.dmPolicy = "pairing"`.
- Remitentes desconocidos reciben un código de emparejamiento; los mensajes se ignoran hasta la aprobación (los códigos expiran después de 1 hora).
- Aprueba vía:
  - `openclaw pairing list bluebubbles`
  - `openclaw pairing approve bluebubbles <CÓDIGO>`
- El emparejamiento es el intercambio de token por defecto. Detalles: [Emparejamiento](/es-ES/channels/pairing)

Grupos:

- `channels.bluebubbles.groupPolicy = open | allowlist | disabled` (por defecto: `allowlist`).
- `channels.bluebubbles.groupAllowFrom` controla quién puede activar en grupos cuando `allowlist` está establecido.

### Bloqueo por mención (grupos)

BlueBubbles soporta bloqueo por mención para chats de grupo, coincidiendo con el comportamiento iMessage/WhatsApp:

- Usa `agents.list[].groupChat.mentionPatterns` (o `messages.groupChat.mentionPatterns`) para detectar menciones.
- Cuando `requireMention` está habilitado para un grupo, el agente solo responde cuando es mencionado.
- Comandos de control de remitentes autorizados omiten el bloqueo por mención.

Configuración por grupo:

```json5
{
  channels: {
    bluebubbles: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15555550123"],
      groups: {
        "*": { requireMention: true }, // predeterminado para todos los grupos
        "iMessage;-;chat123": { requireMention: false }, // sobrescribir para grupo específico
      },
    },
  },
}
```

### Bloqueo de comandos

- Los comandos de control (ej., `/config`, `/model`) requieren autorización.
- Usa `allowFrom` y `groupAllowFrom` para determinar autorización de comandos.
- Remitentes autorizados pueden ejecutar comandos de control incluso sin mencionar en grupos.

## Indicadores de escritura + confirmaciones de lectura

- **Indicadores de escritura**: enviados automáticamente antes y durante la generación de respuesta.
- **Confirmaciones de lectura**: controladas por `channels.bluebubbles.sendReadReceipts` (por defecto: `true`).
- **Indicadores de escritura**: OpenClaw envía eventos de inicio de escritura; BlueBubbles limpia la escritura automáticamente al enviar o por timeout (detención manual vía DELETE no es confiable).

```json5
{
  channels: {
    bluebubbles: {
      sendReadReceipts: false, // deshabilitar confirmaciones de lectura
    },
  },
}
```

## Acciones avanzadas

BlueBubbles soporta acciones de mensaje avanzadas cuando están habilitadas en configuración:

```json5
{
  channels: {
    bluebubbles: {
      actions: {
        reactions: true, // tapbacks (por defecto: true)
        edit: true, // editar mensajes enviados (macOS 13+, roto en macOS 26 Tahoe)
        unsend: true, // desenviar mensajes (macOS 13+)
        reply: true, // hilos de respuesta por GUID de mensaje
        sendWithEffect: true, // efectos de mensaje (slam, loud, etc.)
        renameGroup: true, // renombrar chats de grupo
        setGroupIcon: true, // establecer ícono/foto de chat de grupo (inestable en macOS 26 Tahoe)
        addParticipant: true, // agregar participantes a grupos
        removeParticipant: true, // eliminar participantes de grupos
        leaveGroup: true, // salir de chats de grupo
        sendAttachment: true, // enviar adjuntos/medios
      },
    },
  },
}
```

Acciones disponibles:

- **react**: Agregar/eliminar reacciones tapback (`messageId`, `emoji`, `remove`)
- **edit**: Editar un mensaje enviado (`messageId`, `text`)
- **unsend**: Desenviar un mensaje (`messageId`)
- **reply**: Responder a un mensaje específico (`messageId`, `text`, `to`)
- **sendWithEffect**: Enviar con efecto iMessage (`text`, `to`, `effectId`)
- **renameGroup**: Renombrar un chat de grupo (`chatGuid`, `displayName`)
- **setGroupIcon**: Establecer ícono/foto de un chat de grupo (`chatGuid`, `media`) — inestable en macOS 26 Tahoe (la API puede devolver éxito pero el ícono no sincroniza).
- **addParticipant**: Agregar alguien a un grupo (`chatGuid`, `address`)
- **removeParticipant**: Eliminar alguien de un grupo (`chatGuid`, `address`)
- **leaveGroup**: Salir de un chat de grupo (`chatGuid`)
- **sendAttachment**: Enviar medios/archivos (`to`, `buffer`, `filename`, `asVoice`)
  - Memos de voz: establece `asVoice: true` con audio **MP3** o **CAF** para enviar como mensaje de voz iMessage. BlueBubbles convierte MP3 → CAF al enviar memos de voz.

### IDs de mensaje (cortos vs completos)

OpenClaw puede exponer IDs de mensaje _cortos_ (ej., `1`, `2`) para ahorrar tokens.

- `MessageSid` / `ReplyToId` pueden ser IDs cortos.
- `MessageSidFull` / `ReplyToIdFull` contienen los IDs completos del proveedor.
- Los IDs cortos están en memoria; pueden expirar al reiniciar o por evicción de caché.
- Las acciones aceptan `messageId` corto o completo, pero los IDs cortos darán error si ya no están disponibles.

Usa IDs completos para automatizaciones durables y almacenamiento:

- Plantillas: `{{MessageSidFull}}`, `{{ReplyToIdFull}}`
- Contexto: `MessageSidFull` / `ReplyToIdFull` en payloads entrantes

Ver [Configuración](/es-ES/gateway/configuration) para variables de plantilla.

## Streaming por bloques

Controla si las respuestas se envían como un solo mensaje o en streaming por bloques:

```json5
{
  channels: {
    bluebubbles: {
      blockStreaming: true, // habilitar streaming por bloques (desactivado por defecto)
    },
  },
}
```

## Medios + límites

- Los adjuntos entrantes se descargan y almacenan en la caché de medios.
- Límite de medios vía `channels.bluebubbles.mediaMaxMb` (por defecto: 8 MB).
- El texto saliente se divide en chunks de `channels.bluebubbles.textChunkLimit` (por defecto: 4000 caracteres).

## Referencia de configuración

Configuración completa: [Configuración](/es-ES/gateway/configuration)

Opciones del proveedor:

- `channels.bluebubbles.enabled`: habilitar/deshabilitar el canal.
- `channels.bluebubbles.serverUrl`: URL base de la API REST BlueBubbles.
- `channels.bluebubbles.password`: contraseña API.
- `channels.bluebubbles.webhookPath`: ruta del endpoint webhook (por defecto: `/bluebubbles-webhook`).
- `channels.bluebubbles.dmPolicy`: `pairing | allowlist | open | disabled` (por defecto: `pairing`).
- `channels.bluebubbles.allowFrom`: lista de permitidos MD (handles, emails, números E.164, `chat_id:*`, `chat_guid:*`).
- `channels.bluebubbles.groupPolicy`: `open | allowlist | disabled` (por defecto: `allowlist`).
- `channels.bluebubbles.groupAllowFrom`: lista de permitidos de remitentes de grupo.
- `channels.bluebubbles.groups`: configuración por grupo (`requireMention`, etc.).
- `channels.bluebubbles.sendReadReceipts`: enviar confirmaciones de lectura (por defecto: `true`).
- `channels.bluebubbles.blockStreaming`: habilitar streaming por bloques (por defecto: `false`; requerido para respuestas en streaming).
- `channels.bluebubbles.textChunkLimit`: tamaño de chunk saliente en caracteres (por defecto: 4000).
- `channels.bluebubbles.chunkMode`: `length` (por defecto) divide solo al exceder `textChunkLimit`; `newline` divide en líneas en blanco (límites de párrafo) antes de la división por longitud.
- `channels.bluebubbles.mediaMaxMb`: límite de medios entrantes en MB (por defecto: 8).
- `channels.bluebubbles.mediaLocalRoots`: lista de permitidos explícita de directorios locales absolutos permitidos para rutas de medios locales salientes. Los envíos de ruta local se deniegan por defecto a menos que esto esté configurado. Sobrescritura por cuenta: `channels.bluebubbles.accounts.<accountId>.mediaLocalRoots`.
- `channels.bluebubbles.historyLimit`: máx. mensajes de grupo para contexto (0 desactiva).
- `channels.bluebubbles.dmHistoryLimit`: límite de historial MD.
- `channels.bluebubbles.actions`: habilitar/deshabilitar acciones específicas.
- `channels.bluebubbles.accounts`: configuración multi-cuenta.

Opciones globales relacionadas:

- `agents.list[].groupChat.mentionPatterns` (o `messages.groupChat.mentionPatterns`).
- `messages.responsePrefix`.

## Direccionamiento / objetivos de entrega

Prefiere `chat_guid` para enrutamiento estable:

- `chat_guid:iMessage;-;+15555550123` (preferido para grupos)
- `chat_id:123`
- `chat_identifier:...`
- Handles directos: `+15555550123`, `user@example.com`
  - Si un handle directo no tiene un chat MD existente, OpenClaw creará uno vía `POST /api/v1/chat/new`. Esto requiere que la API Privada BlueBubbles esté habilitada.

## Seguridad

- Las solicitudes webhook se autentican comparando los parámetros o encabezados de consulta `guid`/`password` contra `channels.bluebubbles.password`. Las solicitudes desde `localhost` también se aceptan.
- Mantén la contraseña API y el endpoint webhook en secreto (trátalos como credenciales).
- La confianza en localhost significa que un proxy inverso del mismo host puede inadvertidamente omitir la contraseña. Si proxeas el gateway, requiere autenticación en el proxy y configura `gateway.trustedProxies`. Ver [Seguridad del Gateway](/es-ES/gateway/security#reverse-proxy-configuration).
- Habilita HTTPS + reglas de firewall en el servidor BlueBubbles si lo expones fuera de tu LAN.

## Solución de problemas

- Si los eventos de escritura/lectura dejan de funcionar, verifica los logs de webhook de BlueBubbles y confirma que la ruta del gateway coincide con `channels.bluebubbles.webhookPath`.
- Los códigos de emparejamiento expiran después de una hora; usa `openclaw pairing list bluebubbles` y `openclaw pairing approve bluebubbles <código>`.
- Las reacciones requieren la API privada BlueBubbles (`POST /api/v1/message/react`); asegúrate de que la versión del servidor la exponga.
- Editar/desenviar requiere macOS 13+ y una versión compatible del servidor BlueBubbles. En macOS 26 (Tahoe), edición está actualmente rota debido a cambios en la API privada.
- Las actualizaciones de ícono de grupo pueden ser inestables en macOS 26 (Tahoe): la API puede devolver éxito pero el nuevo ícono no sincroniza.
- OpenClaw auto-oculta acciones conocidas como rotas según la versión macOS del servidor BlueBubbles. Si edición aún aparece en macOS 26 (Tahoe), desactívala manualmente con `channels.bluebubbles.actions.edit=false`.
- Para información de estado/salud: `openclaw status --all` o `openclaw status --deep`.

Para referencia general del flujo de trabajo de canales, ver [Canales](/es-ES/channels) y la guía de [Plugins](/es-ES/tools/plugin).
