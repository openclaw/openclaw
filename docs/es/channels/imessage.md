---
summary: "Compatibilidad heredada de iMessage mediante imsg (JSON-RPC sobre stdio). Las nuevas configuraciones deben usar BlueBubbles."
read_when:
  - Configurar compatibilidad con iMessage
  - Depurar envío/recepción de iMessage
title: iMessage
x-i18n:
  source_path: channels/imessage.md
  source_hash: b418a589547d1ef0
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:32:49Z
---

# iMessage (legado: imsg)

> **Recomendado:** Use [BlueBubbles](/channels/bluebubbles) para nuevas configuraciones de iMessage.
>
> El canal `imsg` es una integración heredada de CLI externa y puede eliminarse en una versión futura.

Estado: integración heredada de CLI externa. El Gateway inicia `imsg rpc` (JSON-RPC sobre stdio).

## Configuración rápida (principiante)

1. Asegúrese de que Mensajes haya iniciado sesión en este Mac.
2. Instale `imsg`:
   - `brew install steipete/tap/imsg`
3. Configure OpenClaw con `channels.imessage.cliPath` y `channels.imessage.dbPath`.
4. Inicie el gateway y apruebe cualquier aviso de macOS (Automatización + Acceso total al disco).

Configuración mínima:

```json5
{
  channels: {
    imessage: {
      enabled: true,
      cliPath: "/usr/local/bin/imsg",
      dbPath: "/Users/<you>/Library/Messages/chat.db",
    },
  },
}
```

## Qué es

- Canal de iMessage respaldado por `imsg` en macOS.
- Enrutamiento determinista: las respuestas siempre regresan a iMessage.
- Los mensajes directos comparten la sesión principal del agente; los grupos están aislados (`agent:<agentId>:imessage:group:<chat_id>`).
- Si llega un hilo con múltiples participantes con `is_group=false`, aún puede aislarlo `chat_id` usando `channels.imessage.groups` (consulte “Hilos tipo grupo” más abajo).

## Escrituras de configuración

De forma predeterminada, iMessage puede escribir actualizaciones de configuración activadas por `/config set|unset` (requiere `commands.config: true`).

Desactivar con:

```json5
{
  channels: { imessage: { configWrites: false } },
}
```

## Requisitos

- macOS con Mensajes iniciado sesión.
- Acceso total al disco para OpenClaw + `imsg` (acceso a la base de datos de Mensajes).
- Permiso de Automatización al enviar.
- `channels.imessage.cliPath` puede apuntar a cualquier comando que proxee stdin/stdout (por ejemplo, un script envoltorio que use SSH a otro Mac y ejecute `imsg rpc`).

## Solución de problemas de Privacidad y Seguridad TCC de macOS

Si el envío/recepción falla (por ejemplo, `imsg rpc` sale con código distinto de cero, expira o el gateway parece colgarse), una causa común es un aviso de permisos de macOS que nunca se aprobó.

macOS concede permisos TCC por contexto de app/proceso. Apruebe los avisos en el mismo contexto que ejecuta `imsg` (por ejemplo, Terminal/iTerm, una sesión de LaunchAgent o un proceso iniciado por SSH).

Lista de verificación:

- **Acceso total al disco**: permita el acceso para el proceso que ejecuta OpenClaw (y cualquier envoltorio de shell/SSH que ejecute `imsg`). Esto es necesario para leer la base de datos de Mensajes (`chat.db`).
- **Automatización → Mensajes**: permita que el proceso que ejecuta OpenClaw (y/o su terminal) controle **Messages.app** para envíos salientes.
- **Estado de la CLI de `imsg`**: verifique que `imsg` esté instalado y admita RPC (`imsg rpc --help`).

Consejo: Si OpenClaw se ejecuta sin interfaz (LaunchAgent/systemd/SSH), el aviso de macOS puede ser fácil de pasar por alto. Ejecute un comando interactivo único en una terminal GUI para forzar el aviso y luego reintente:

```bash
imsg chats --limit 1
# or
imsg send <handle> "test"
```

Permisos de carpetas relacionados de macOS (Escritorio/Documentos/Descargas): [/platforms/mac/permissions](/platforms/mac/permissions).

## Configuración (ruta rápida)

1. Asegúrese de que Mensajes haya iniciado sesión en este Mac.
2. Configure iMessage e inicie el gateway.

### Usuario macOS de bot dedicado (para identidad aislada)

Si desea que el bot envíe desde una **identidad de iMessage separada** (y mantener limpios sus Mensajes personales), use un Apple ID dedicado + un usuario macOS dedicado.

1. Cree un Apple ID dedicado (ejemplo: `my-cool-bot@icloud.com`).
   - Apple puede requerir un número de teléfono para verificación / 2FA.
2. Cree un usuario macOS (ejemplo: `openclawhome`) e inicie sesión en él.
3. Abra Mensajes en ese usuario macOS e inicie sesión en iMessage usando el Apple ID del bot.
4. Habilite Inicio de sesión remoto (Ajustes del sistema → General → Compartir → Inicio de sesión remoto).
5. Instale `imsg`:
   - `brew install steipete/tap/imsg`
6. Configure SSH para que `ssh <bot-macos-user>@localhost true` funcione sin contraseña.
7. Apunte `channels.imessage.accounts.bot.cliPath` a un envoltorio SSH que ejecute `imsg` como el usuario del bot.

Nota de primera ejecución: el envío/recepción puede requerir aprobaciones de GUI (Automatización + Acceso total al disco) en el _usuario macOS del bot_. Si `imsg rpc` parece atascado o sale, inicie sesión en ese usuario (Screen Sharing ayuda), ejecute una vez `imsg chats --limit 1` / `imsg send ...`, apruebe los avisos y luego reintente. Consulte [Solución de problemas de Privacidad y Seguridad TCC de macOS](#solución-de-problemas-de-privacidad-y-seguridad-tcc-de-macos).

Ejemplo de envoltorio (`chmod +x`). Reemplace `<bot-macos-user>` con su nombre de usuario real de macOS:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Run an interactive SSH once first to accept host keys:
#   ssh <bot-macos-user>@localhost true
exec /usr/bin/ssh -o BatchMode=yes -o ConnectTimeout=5 -T <bot-macos-user>@localhost \
  "/usr/local/bin/imsg" "$@"
```

Ejemplo de configuración:

```json5
{
  channels: {
    imessage: {
      enabled: true,
      accounts: {
        bot: {
          name: "Bot",
          enabled: true,
          cliPath: "/path/to/imsg-bot",
          dbPath: "/Users/<bot-macos-user>/Library/Messages/chat.db",
        },
      },
    },
  },
}
```

Para configuraciones de una sola cuenta, use opciones planas (`channels.imessage.cliPath`, `channels.imessage.dbPath`) en lugar del mapa `accounts`.

### Variante remota/SSH (opcional)

Si desea iMessage en otro Mac, configure `channels.imessage.cliPath` para que apunte a un envoltorio que ejecute `imsg` en el host macOS remoto por SSH. OpenClaw solo necesita stdio.

Ejemplo de envoltorio:

```bash
#!/usr/bin/env bash
exec ssh -T gateway-host imsg "$@"
```

**Adjuntos remotos:** Cuando `cliPath` apunta a un host remoto vía SSH, las rutas de adjuntos en la base de datos de Mensajes hacen referencia a archivos en la máquina remota. OpenClaw puede obtenerlos automáticamente por SCP configurando `channels.imessage.remoteHost`:

```json5
{
  channels: {
    imessage: {
      cliPath: "~/imsg-ssh", // SSH wrapper to remote Mac
      remoteHost: "user@gateway-host", // for SCP file transfer
      includeAttachments: true,
    },
  },
}
```

Si `remoteHost` no está configurado, OpenClaw intenta detectarlo automáticamente analizando el comando SSH en su script envoltorio. Se recomienda la configuración explícita por confiabilidad.

#### Mac remoto vía Tailscale (ejemplo)

Si el Gateway se ejecuta en un host/VM Linux pero iMessage debe ejecutarse en un Mac, Tailscale es el puente más sencillo: el Gateway se comunica con el Mac a través de la tailnet, ejecuta `imsg` por SSH y recupera los adjuntos por SCP.

Arquitectura:

```
┌──────────────────────────────┐          SSH (imsg rpc)          ┌──────────────────────────┐
│ Gateway host (Linux/VM)      │──────────────────────────────────▶│ Mac with Messages + imsg │
│ - openclaw gateway           │          SCP (attachments)        │ - Messages signed in     │
│ - channels.imessage.cliPath  │◀──────────────────────────────────│ - Remote Login enabled   │
└──────────────────────────────┘                                   └──────────────────────────┘
              ▲
              │ Tailscale tailnet (hostname or 100.x.y.z)
              ▼
        user@gateway-host
```

Ejemplo concreto de configuración (hostname de Tailscale):

```json5
{
  channels: {
    imessage: {
      enabled: true,
      cliPath: "~/.openclaw/scripts/imsg-ssh",
      remoteHost: "bot@mac-mini.tailnet-1234.ts.net",
      includeAttachments: true,
      dbPath: "/Users/bot/Library/Messages/chat.db",
    },
  },
}
```

Ejemplo de envoltorio (`~/.openclaw/scripts/imsg-ssh`):

```bash
#!/usr/bin/env bash
exec ssh -T bot@mac-mini.tailnet-1234.ts.net imsg "$@"
```

Notas:

- Asegúrese de que el Mac haya iniciado sesión en Mensajes y que Inicio de sesión remoto esté habilitado.
- Use claves SSH para que `ssh bot@mac-mini.tailnet-1234.ts.net` funcione sin avisos.
- `remoteHost` debe coincidir con el destino SSH para que SCP pueda obtener los adjuntos.

Compatibilidad con múltiples cuentas: use `channels.imessage.accounts` con configuración por cuenta y `name` opcional. Consulte [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) para el patrón compartido. No confirme `~/.openclaw/openclaw.json` (a menudo contiene tokens).

## Control de acceso (mensajes directos + grupos)

Mensajes directos:

- Predeterminado: `channels.imessage.dmPolicy = "pairing"`.
- Los remitentes desconocidos reciben un código de emparejamiento; los mensajes se ignoran hasta su aprobación (los códigos expiran después de 1 hora).
- Apruebe mediante:
  - `openclaw pairing list imessage`
  - `openclaw pairing approve imessage <CODE>`
- El emparejamiento es el intercambio de tokens predeterminado para mensajes directos de iMessage. Detalles: [Emparejamiento](/channels/pairing)

Grupos:

- `channels.imessage.groupPolicy = open | allowlist | disabled`.
- `channels.imessage.groupAllowFrom` controla quién puede activar en grupos cuando `allowlist` está configurado.
- El control por menciones usa `agents.list[].groupChat.mentionPatterns` (o `messages.groupChat.mentionPatterns`) porque iMessage no tiene metadatos nativos de menciones.
- Anulación multiagente: configure patrones por agente en `agents.list[].groupChat.mentionPatterns`.

## Cómo funciona (comportamiento)

- `imsg` transmite eventos de mensajes; el gateway los normaliza en el sobre compartido del canal.
- Las respuestas siempre se enrutan de vuelta al mismo id de chat o identificador.

## Hilos tipo grupo (`is_group=false`)

Algunos hilos de iMessage pueden tener múltiples participantes pero aun así llegar con `is_group=false` según cómo Mensajes almacena el identificador del chat.

Si configura explícitamente un `chat_id` bajo `channels.imessage.groups`, OpenClaw trata ese hilo como un “grupo” para:

- aislamiento de sesión (clave de sesión `agent:<agentId>:imessage:group:<chat_id>` separada)
- comportamiento de lista de permitidos de grupo / control por menciones

Ejemplo:

```json5
{
  channels: {
    imessage: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15555550123"],
      groups: {
        "42": { requireMention: false },
      },
    },
  },
}
```

Esto es útil cuando desea una personalidad/modelo aislado para un hilo específico (consulte [Enrutamiento multiagente](/concepts/multi-agent)). Para aislamiento del sistema de archivos, consulte [Sandboxing](/gateway/sandboxing).

## Medios + límites

- Ingesta opcional de adjuntos mediante `channels.imessage.includeAttachments`.
- Límite de medios mediante `channels.imessage.mediaMaxMb`.

## Límites

- El texto saliente se fragmenta a `channels.imessage.textChunkLimit` (predeterminado 4000).
- Fragmentación opcional por saltos de línea: configure `channels.imessage.chunkMode="newline"` para dividir en líneas en blanco (límites de párrafo) antes de la fragmentación por longitud.
- Las cargas de medios están limitadas por `channels.imessage.mediaMaxMb` (predeterminado 16).

## Direccionamiento / destinos de entrega

Prefiera `chat_id` para un enrutamiento estable:

- `chat_id:123` (preferido)
- `chat_guid:...`
- `chat_identifier:...`
- identificadores directos: `imessage:+1555` / `sms:+1555` / `user@example.com`

Listar chats:

```
imsg chats --limit 20
```

## Referencia de configuración (iMessage)

Configuración completa: [Configuración](/gateway/configuration)

Opciones del proveedor:

- `channels.imessage.enabled`: habilitar/deshabilitar el inicio del canal.
- `channels.imessage.cliPath`: ruta a `imsg`.
- `channels.imessage.dbPath`: ruta de la base de datos de Mensajes.
- `channels.imessage.remoteHost`: host SSH para la transferencia de adjuntos por SCP cuando `cliPath` apunta a un Mac remoto (p. ej., `user@gateway-host`). Se detecta automáticamente desde el envoltorio SSH si no se configura.
- `channels.imessage.service`: `imessage | sms | auto`.
- `channels.imessage.region`: región de SMS.
- `channels.imessage.dmPolicy`: `pairing | allowlist | open | disabled` (predeterminado: emparejamiento).
- `channels.imessage.allowFrom`: lista de permitidos de mensajes directos (identificadores, correos electrónicos, números E.164 o `chat_id:*`). `open` requiere `"*"`. iMessage no tiene nombres de usuario; use identificadores o destinos de chat.
- `channels.imessage.groupPolicy`: `open | allowlist | disabled` (predeterminado: lista de permitidos).
- `channels.imessage.groupAllowFrom`: lista de permitidos de remitentes de grupo.
- `channels.imessage.historyLimit` / `channels.imessage.accounts.*.historyLimit`: máximo de mensajes de grupo a incluir como contexto (0 deshabilita).
- `channels.imessage.dmHistoryLimit`: límite de historial de mensajes directos en turnos de usuario. Anulaciones por usuario: `channels.imessage.dms["<handle>"].historyLimit`.
- `channels.imessage.groups`: valores predeterminados por grupo + lista de permitidos (use `"*"` para valores predeterminados globales).
- `channels.imessage.includeAttachments`: ingerir adjuntos en el contexto.
- `channels.imessage.mediaMaxMb`: límite de medios entrantes/salientes (MB).
- `channels.imessage.textChunkLimit`: tamaño de fragmento saliente (caracteres).
- `channels.imessage.chunkMode`: `length` (predeterminado) o `newline` para dividir en líneas en blanco (límites de párrafo) antes de la fragmentación por longitud.

Opciones globales relacionadas:

- `agents.list[].groupChat.mentionPatterns` (o `messages.groupChat.mentionPatterns`).
- `messages.responsePrefix`.
