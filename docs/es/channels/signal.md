---
summary: "Soporte de Signal mediante signal-cli (JSON-RPC + SSE), configuración y modelo de número"
read_when:
  - Configuración del soporte de Signal
  - Depuración de envío/recepción de Signal
title: "Signal"
---

# Signal (signal-cli)

Estado: integración externa por CLI. El Gateway se comunica con `signal-cli` mediante HTTP JSON-RPC + SSE.

## Configuración rápida (principiante)

1. Use un **número de Signal separado** para el bot (recomendado).
2. Instale `signal-cli` (se requiere Java).
3. Vincule el dispositivo del bot e inicie el daemon:
   - `signal-cli link -n "OpenClaw"`
4. Configure OpenClaw e inicie el Gateway.

Configuración mínima:

```json5
{
  channels: {
    signal: {
      enabled: true,
      account: "+15551234567",
      cliPath: "signal-cli",
      dmPolicy: "pairing",
      allowFrom: ["+15557654321"],
    },
  },
}
```

## Qué es

- Canal de Signal mediante `signal-cli` (no libsignal embebido).
- Enrutamiento determinista: las respuestas siempre regresan a Signal.
- Los mensajes directos comparten la sesión principal del agente; los grupos están aislados (`agent:<agentId>:signal:group:<groupId>`).

## Escrituras de configuración

De forma predeterminada, Signal puede escribir actualizaciones de configuración activadas por `/config set|unset` (requiere `commands.config: true`).

Deshabilite con:

```json5
{
  channels: { signal: { configWrites: false } },
}
```

## El modelo de número (importante)

- El Gateway se conecta a un **dispositivo de Signal** (la cuenta `signal-cli`).
- Si ejecuta el bot en **su cuenta personal de Signal**, ignorará sus propios mensajes (protección contra bucles).
- Para “yo le escribo al bot y responde”, use un **número de bot separado**.

## Configuración (ruta rápida)

1. Instale `signal-cli` (se requiere Java).
2. Vincule una cuenta de bot:
   - `signal-cli link -n "OpenClaw"` y luego escanee el QR en Signal.
3. Configure Signal e inicie el Gateway.

Ejemplo:

```json5
{
  channels: {
    signal: {
      enabled: true,
      account: "+15551234567",
      cliPath: "signal-cli",
      dmPolicy: "pairing",
      allowFrom: ["+15557654321"],
    },
  },
}
```

Soporte de múltiples cuentas: use `channels.signal.accounts` con configuración por cuenta y `name` opcional. Consulte [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) para el patrón compartido.

## Modo de daemon externo (httpUrl)

Si desea administrar `signal-cli` por su cuenta (arranques fríos lentos de JVM, inicialización de contenedores o CPUs compartidas), ejecute el daemon por separado y apunte OpenClaw a él:

```json5
{
  channels: {
    signal: {
      httpUrl: "http://127.0.0.1:8080",
      autoStart: false,
    },
  },
}
```

Esto omite el autoarranque y la espera de inicio dentro de OpenClaw. Para arranques lentos cuando se autoarranca, configure `channels.signal.startupTimeoutMs`.

## Control de acceso (mensajes directos + grupos)

DMs:

- Predeterminado: `channels.signal.dmPolicy = "pairing"`.
- Los remitentes desconocidos reciben un código de emparejamiento; los mensajes se ignoran hasta que se aprueben (los códigos expiran tras 1 hora).
- Apruebe mediante:
  - `openclaw pairing list signal`
  - `openclaw pairing approve signal <CODE>`
- El emparejamiento es el intercambio de tokens predeterminado para mensajes directos de Signal. Detalles: [Pairing](/channels/pairing)
- Los remitentes solo con UUID (de `sourceUuid`) se almacenan como `uuid:<id>` en `channels.signal.allowFrom`.

Grupos:

- `channels.signal.groupPolicy = open | allowlist | disabled`.
- `channels.signal.groupAllowFrom` controla quién puede activar en grupos cuando se establece `allowlist`.

## Cómo funciona (comportamiento)

- `signal-cli` se ejecuta como daemon; el Gateway lee eventos vía SSE.
- Los mensajes entrantes se normalizan en el sobre de canal compartido.
- Las respuestas siempre se enrutan de vuelta al mismo número o grupo.

## Medios + límites

- El texto saliente se divide en bloques de `channels.signal.textChunkLimit` (predeterminado 4000).
- División opcional por nuevas líneas: configure `channels.signal.chunkMode="newline"` para dividir en líneas en blanco (límites de párrafo) antes de la división por longitud.
- Adjuntos compatibles (base64 obtenido desde `signal-cli`).
- Límite de medios predeterminado: `channels.signal.mediaMaxMb` (predeterminado 8).
- Use `channels.signal.ignoreAttachments` para omitir la descarga de medios.
- El contexto del historial de grupos usa `channels.signal.historyLimit` (o `channels.signal.accounts.*.historyLimit`), con respaldo a `messages.groupChat.historyLimit`. Configure `0` para deshabilitar (predeterminado 50).

## Indicadores de escritura + acuses de lectura

- **Indicadores de escritura**: OpenClaw envía señales de escritura mediante `signal-cli sendTyping` y las actualiza mientras se ejecuta una respuesta.
- **Acuses de lectura**: cuando `channels.signal.sendReadReceipts` es true, OpenClaw reenvía acuses de lectura para mensajes directos permitidos.
- signal-cli no expone acuses de lectura para grupos.

## Reacciones (herramienta de mensajes)

- Use `message action=react` con `channel=signal`.
- Objetivos: E.164 del remitente o UUID (use `uuid:<id>` del resultado de emparejamiento; el UUID sin formato también funciona).
- `messageId` es la marca de tiempo de Signal del mensaje al que está reaccionando.
- Las reacciones en grupos requieren `targetAuthor` o `targetAuthorUuid`.

Ejemplos:

```
message action=react channel=signal target=uuid:123e4567-e89b-12d3-a456-426614174000 messageId=1737630212345 emoji=🔥
message action=react channel=signal target=+15551234567 messageId=1737630212345 emoji=🔥 remove=true
message action=react channel=signal target=signal:group:<groupId> targetAuthor=uuid:<sender-uuid> messageId=1737630212345 emoji=✅
```

Configuración:

- `channels.signal.actions.reactions`: habilitar/deshabilitar acciones de reacción (predeterminado true).
- `channels.signal.reactionLevel`: `off | ack | minimal | extensive`.
  - `off`/`ack` deshabilita las reacciones del agente (la herramienta de mensajes `react` generará error).
  - `minimal`/`extensive` habilita las reacciones del agente y establece el nivel de guía.
- Anulaciones por cuenta: `channels.signal.accounts.<id>.actions.reactions`, `channels.signal.accounts.<id>.reactionLevel`.

## Destinos de entrega (CLI/cron)

- Mensajes directos: `signal:+15551234567` (o E.164 simple).
- Mensajes directos por UUID: `uuid:<id>` (o UUID sin formato).
- Grupos: `signal:group:<groupId>`.
- Nombres de usuario: `username:<name>` (si su cuenta de Signal lo admite).

## Solución de problemas

Ejecute primero esta secuencia:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Luego confirme el estado de emparejamiento de mensajes directos si es necesario:

```bash
openclaw pairing list signal
```

Fallos comunes:

- El daemon es accesible pero no hay respuestas: verifique la configuración de la cuenta/daemon (`httpUrl`, `account`) y el modo de recepción.
- Mensajes directos ignorados: el remitente está pendiente de aprobación de emparejamiento.
- Mensajes de grupo ignorados: el bloqueo por remitente/mención del grupo impide la entrega.

Para el flujo de triaje: [/channels/troubleshooting](/channels/troubleshooting).

## Referencia de configuración (Signal)

Configuración completa: [Configuration](/gateway/configuration)

Opciones del proveedor:

- `channels.signal.enabled`: habilitar/deshabilitar el inicio del canal.
- `channels.signal.account`: E.164 para la cuenta del bot.
- `channels.signal.cliPath`: ruta a `signal-cli`.
- `channels.signal.httpUrl`: URL completa del daemon (anula host/puerto).
- `channels.signal.httpHost`, `channels.signal.httpPort`: enlace del daemon (predeterminado 127.0.0.1:8080).
- `channels.signal.autoStart`: autoarranque del daemon (predeterminado true si `httpUrl` no está configurado).
- `channels.signal.startupTimeoutMs`: tiempo de espera de inicio en ms (límite 120000).
- `channels.signal.receiveMode`: `on-start | manual`.
- `channels.signal.ignoreAttachments`: omitir descargas de adjuntos.
- `channels.signal.ignoreStories`: ignorar historias del daemon.
- `channels.signal.sendReadReceipts`: reenviar acuses de lectura.
- `channels.signal.dmPolicy`: `pairing | allowlist | open | disabled` (predeterminado: emparejamiento).
- `channels.signal.allowFrom`: lista de permitidos de mensajes directos (E.164 o `uuid:<id>`). `open` requiere `"*"`. Signal no tiene nombres de usuario; use IDs de teléfono/UUID.
- `channels.signal.groupPolicy`: `open | allowlist | disabled` (predeterminado: lista de permitidos).
- `channels.signal.groupAllowFrom`: lista de permitidos de remitentes de grupo.
- `channels.signal.historyLimit`: máximo de mensajes de grupo a incluir como contexto (0 deshabilita).
- `channels.signal.dmHistoryLimit`: límite de historial de mensajes directos en turnos de usuario. Anulaciones por usuario: `channels.signal.dms["<phone_or_uuid>"].historyLimit`.
- `channels.signal.textChunkLimit`: tamaño de bloque de salida (caracteres).
- `channels.signal.chunkMode`: `length` (predeterminado) o `newline` para dividir en líneas en blanco (límites de párrafo) antes de la división por longitud.
- `channels.signal.mediaMaxMb`: límite de medios entrantes/salientes (MB).

Opciones globales relacionadas:

- `agents.list[].groupChat.mentionPatterns` (Signal no admite menciones nativas).
- `messages.groupChat.mentionPatterns` (respaldo global).
- `messages.responsePrefix`.
