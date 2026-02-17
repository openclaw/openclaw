---
summary: "Soporte de Signal vía signal-cli (JSON-RPC + SSE), rutas de configuración y modelo de números"
read_when:
  - Configurando soporte de Signal
  - Depurando envío/recepción de Signal
title: "Signal"
---

# Signal (signal-cli)

Estado: integración CLI externa. El gateway se comunica con `signal-cli` sobre HTTP JSON-RPC + SSE.

## Requisitos previos

- OpenClaw instalado en tu servidor (flujo Linux probado en Ubuntu 24).
- `signal-cli` disponible en el host donde se ejecuta el gateway.
- Un número de teléfono que pueda recibir un SMS de verificación (para la ruta de registro por SMS).
- Acceso al navegador para el captcha de Signal (`signalcaptchas.org`) durante el registro.

## Configuración rápida (principiantes)

1. Usa un **número de Signal separado** para el bot (recomendado).
2. Instala `signal-cli` (requiere Java si usas la versión JVM).
3. Elige una ruta de configuración:
   - **Ruta A (enlace QR):** `signal-cli link -n "OpenClaw"` y escanea con Signal.
   - **Ruta B (registro SMS):** registra un número dedicado con captcha + verificación SMS.
4. Configura OpenClaw y reinicia el gateway.
5. Envía el primer MD y aprueba el emparejamiento (`openclaw pairing approve signal <CÓDIGO>`).

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

Referencia de campos:

| Campo       | Descripción                                           |
| ----------- | ----------------------------------------------------- |
| `account`   | Número del bot en formato E.164 (`+15551234567`)      |
| `cliPath`   | Ruta a `signal-cli` (`signal-cli` si está en `PATH`)  |
| `dmPolicy`  | Política de acceso MD (`pairing` recomendada)         |
| `allowFrom` | Números de teléfono o valores `uuid:<id>` permitidos para MD |

## Qué es

- Canal Signal vía `signal-cli` (no libsignal embebido).
- Enrutamiento determinista: las respuestas siempre regresan a Signal.
- Los MD comparten la sesión principal del agente; los grupos están aislados (`agent:<agentId>:signal:group:<groupId>`).

## Escrituras de configuración

Por defecto, Signal puede escribir actualizaciones de configuración activadas por `/config set|unset` (requiere `commands.config: true`).

Desactiva con:

```json5
{
  channels: { signal: { configWrites: false } },
}
```

## El modelo de números (importante)

- El gateway se conecta a un **dispositivo Signal** (la cuenta `signal-cli`).
- Si ejecutas el bot en **tu cuenta personal de Signal**, ignorará tus propios mensajes (protección contra bucles).
- Para "yo le escribo al bot y me responde", usa un **número de bot separado**.

## Ruta de configuración A: vincular cuenta Signal existente (QR)

1. Instala `signal-cli` (versión JVM o nativa).
2. Vincula una cuenta de bot:
   - `signal-cli link -n "OpenClaw"` luego escanea el QR en Signal.
3. Configura Signal e inicia el gateway.

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

Soporte multi-cuenta: usa `channels.signal.accounts` con configuración por cuenta y `name` opcional. Ver [`gateway/configuration`](/es-ES/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) para el patrón compartido.

## Ruta de configuración B: registrar número de bot dedicado (SMS, Linux)

Usa esto cuando quieras un número de bot dedicado en lugar de vincular una cuenta de la app Signal existente.

1. Consigue un número que pueda recibir SMS (o verificación por voz para líneas fijas).
   - Usa un número de bot dedicado para evitar conflictos de cuenta/sesión.
2. Instala `signal-cli` en el host del gateway:

```bash
VERSION=$(curl -Ls -o /dev/null -w %{url_effective} https://github.com/AsamK/signal-cli/releases/latest | sed -e 's/^.*\/v//')
curl -L -O "https://github.com/AsamK/signal-cli/releases/download/v${VERSION}/signal-cli-${VERSION}-Linux-native.tar.gz"
sudo tar xf "signal-cli-${VERSION}-Linux-native.tar.gz" -C /opt
sudo ln -sf /opt/signal-cli /usr/local/bin/
signal-cli --version
```

Si usas la versión JVM (`signal-cli-${VERSION}.tar.gz`), instala primero JRE 25+.
Mantén `signal-cli` actualizado; upstream indica que las versiones antiguas pueden fallar cuando cambian las APIs del servidor Signal.

3. Registra y verifica el número:

```bash
signal-cli -a +<NÚMERO_TELÉFONO_BOT> register
```

Si se requiere captcha:

1. Abre `https://signalcaptchas.org/registration/generate.html`.
2. Completa el captcha, copia el target del enlace `signalcaptcha://...` de "Open Signal".
3. Ejecuta desde la misma IP externa que la sesión del navegador cuando sea posible.
4. Ejecuta el registro nuevamente inmediatamente (los tokens captcha expiran rápido):

```bash
signal-cli -a +<NÚMERO_TELÉFONO_BOT> register --captcha '<URL_SIGNALCAPTCHA>'
signal-cli -a +<NÚMERO_TELÉFONO_BOT> verify <CÓDIGO_VERIFICACIÓN>
```

4. Configura OpenClaw, reinicia gateway, verifica canal:

```bash
# Si ejecutas el gateway como un servicio systemd de usuario:
systemctl --user restart openclaw-gateway

# Luego verifica:
openclaw doctor
openclaw channels status --probe
```

5. Empareja tu remitente MD:
   - Envía cualquier mensaje al número del bot.
   - Aprueba el código en el servidor: `openclaw pairing approve signal <CÓDIGO_EMPAREJAMIENTO>`.
   - Guarda el número del bot como contacto en tu teléfono para evitar "Contacto desconocido".

Importante: registrar una cuenta de número de teléfono con `signal-cli` puede desautenticar la sesión principal de la app Signal para ese número. Prefiere un número de bot dedicado, o usa el modo de enlace QR si necesitas mantener tu configuración de app de teléfono existente.

Referencias upstream:

- README de `signal-cli`: `https://github.com/AsamK/signal-cli`
- Flujo de captcha: `https://github.com/AsamK/signal-cli/wiki/Registration-with-captcha`
- Flujo de vinculación: `https://github.com/AsamK/signal-cli/wiki/Linking-other-devices-(Provisioning)`

## Modo daemon externo (httpUrl)

Si quieres administrar `signal-cli` tú mismo (arranques en frío JVM lentos, init de contenedor, o CPUs compartidas), ejecuta el daemon por separado y apunta OpenClaw a él:

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

Esto omite el auto-spawn y la espera de arranque dentro de OpenClaw. Para arranques lentos al auto-generar, establece `channels.signal.startupTimeoutMs`.

## Control de acceso (MD + grupos)

MD:

- Por defecto: `channels.signal.dmPolicy = "pairing"`.
- Remitentes desconocidos reciben un código de emparejamiento; los mensajes se ignoran hasta la aprobación (los códigos expiran después de 1 hora).
- Aprueba vía:
  - `openclaw pairing list signal`
  - `openclaw pairing approve signal <CÓDIGO>`
- El emparejamiento es el intercambio de token por defecto para MD de Signal. Detalles: [Emparejamiento](/es-ES/channels/pairing)
- Remitentes solo-UUID (de `sourceUuid`) se almacenan como `uuid:<id>` en `channels.signal.allowFrom`.

Grupos:

- `channels.signal.groupPolicy = open | allowlist | disabled`.
- `channels.signal.groupAllowFrom` controla quién puede activar en grupos cuando `allowlist` está establecido.

## Cómo funciona (comportamiento)

- `signal-cli` se ejecuta como daemon; el gateway lee eventos vía SSE.
- Los mensajes entrantes se normalizan en el sobre de canal compartido.
- Las respuestas siempre enrutan de vuelta al mismo número o grupo.

## Medios + límites

- El texto saliente se divide en chunks de `channels.signal.textChunkLimit` (por defecto 4000).
- División opcional por saltos de línea: establece `channels.signal.chunkMode="newline"` para dividir en líneas en blanco (límites de párrafo) antes de la división por longitud.
- Adjuntos soportados (base64 obtenido de `signal-cli`).
- Límite de medios por defecto: `channels.signal.mediaMaxMb` (por defecto 8).
- Usa `channels.signal.ignoreAttachments` para omitir la descarga de medios.
- El contexto del historial de grupos usa `channels.signal.historyLimit` (o `channels.signal.accounts.*.historyLimit`), respaldándose en `messages.groupChat.historyLimit`. Establece `0` para desactivar (por defecto 50).

## Indicadores de escritura + confirmaciones de lectura

- **Indicadores de escritura**: OpenClaw envía señales de escritura vía `signal-cli sendTyping` y las refresca mientras una respuesta se está ejecutando.
- **Confirmaciones de lectura**: cuando `channels.signal.sendReadReceipts` es true, OpenClaw reenvía confirmaciones de lectura para MD permitidos.
- Signal-cli no expone confirmaciones de lectura para grupos.

## Reacciones (herramienta message)

- Usa `message action=react` con `channel=signal`.
- Objetivos: E.164 del remitente o UUID (usa `uuid:<id>` de la salida de emparejamiento; UUID sin prefijo también funciona).
- `messageId` es la marca de tiempo Signal del mensaje al que estás reaccionando.
- Las reacciones de grupo requieren `targetAuthor` o `targetAuthorUuid`.

Ejemplos:

```
message action=react channel=signal target=uuid:123e4567-e89b-12d3-a456-426614174000 messageId=1737630212345 emoji=🔥
message action=react channel=signal target=+15551234567 messageId=1737630212345 emoji=🔥 remove=true
message action=react channel=signal target=signal:group:<groupId> targetAuthor=uuid:<sender-uuid> messageId=1737630212345 emoji=✅
```

Configuración:

- `channels.signal.actions.reactions`: habilitar/deshabilitar acciones de reacción (por defecto true).
- `channels.signal.reactionLevel`: `off | ack | minimal | extensive`.
  - `off`/`ack` deshabilita reacciones del agente (message tool `react` dará error).
  - `minimal`/`extensive` habilita reacciones del agente y establece el nivel de guía.
- Sobrescrituras por cuenta: `channels.signal.accounts.<id>.actions.reactions`, `channels.signal.accounts.<id>.reactionLevel`.

## Objetivos de entrega (CLI/cron)

- MD: `signal:+15551234567` (o E.164 simple).
- MD UUID: `uuid:<id>` (o UUID sin prefijo).
- Grupos: `signal:group:<groupId>`.
- Nombres de usuario: `username:<name>` (si tu cuenta Signal lo soporta).

## Solución de problemas

Ejecuta esta escalera primero:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Luego confirma el estado de emparejamiento MD si es necesario:

```bash
openclaw pairing list signal
```

Fallos comunes:

- Daemon alcanzable pero sin respuestas: verifica configuración de cuenta/daemon (`httpUrl`, `account`) y modo de recepción.
- MD ignorados: remitente está pendiente de aprobación de emparejamiento.
- Mensajes de grupo ignorados: el bloqueo de remitente/mención del grupo bloquea la entrega.
- Errores de validación de configuración después de ediciones: ejecuta `openclaw doctor --fix`.
- Signal faltante en diagnósticos: confirma `channels.signal.enabled: true`.

Verificaciones extra:

```bash
openclaw pairing list signal
pgrep -af signal-cli
grep -i "signal" "/tmp/openclaw/openclaw-$(date +%Y-%m-%d).log" | tail -20
```

Para flujo de triaje: [/channels/troubleshooting](/es-ES/channels/troubleshooting).

## Notas de seguridad

- `signal-cli` almacena claves de cuenta localmente (típicamente `~/.local/share/signal-cli/data/`).
- Respalda el estado de la cuenta Signal antes de migración o reconstrucción del servidor.
- Mantén `channels.signal.dmPolicy: "pairing"` a menos que explícitamente quieras acceso MD más amplio.
- La verificación SMS solo se necesita para flujos de registro o recuperación, pero perder control del número/cuenta puede complicar el re-registro.

## Referencia de configuración (Signal)

Configuración completa: [Configuración](/es-ES/gateway/configuration)

Opciones del proveedor:

- `channels.signal.enabled`: habilitar/deshabilitar inicio del canal.
- `channels.signal.account`: E.164 para la cuenta del bot.
- `channels.signal.cliPath`: ruta a `signal-cli`.
- `channels.signal.httpUrl`: URL completa del daemon (sobrescribe host/port).
- `channels.signal.httpHost`, `channels.signal.httpPort`: bind del daemon (por defecto 127.0.0.1:8080).
- `channels.signal.autoStart`: auto-generar daemon (por defecto true si `httpUrl` no está establecido).
- `channels.signal.startupTimeoutMs`: tiempo de espera de arranque en ms (máximo 120000).
- `channels.signal.receiveMode`: `on-start | manual`.
- `channels.signal.ignoreAttachments`: omitir descargas de adjuntos.
- `channels.signal.ignoreStories`: ignorar historias del daemon.
- `channels.signal.sendReadReceipts`: reenviar confirmaciones de lectura.
- `channels.signal.dmPolicy`: `pairing | allowlist | open | disabled` (por defecto: pairing).
- `channels.signal.allowFrom`: lista de permitidos MD (E.164 o `uuid:<id>`). `open` requiere `"*"`. Signal no tiene nombres de usuario; usa IDs de teléfono/UUID.
- `channels.signal.groupPolicy`: `open | allowlist | disabled` (por defecto: allowlist).
- `channels.signal.groupAllowFrom`: lista de permitidos de remitentes de grupo.
- `channels.signal.historyLimit`: máx. mensajes de grupo a incluir como contexto (0 desactiva).
- `channels.signal.dmHistoryLimit`: límite de historial MD en turnos del usuario. Sobrescrituras por usuario: `channels.signal.dms["<phone_or_uuid>"].historyLimit`.
- `channels.signal.textChunkLimit`: tamaño de chunk saliente (caracteres).
- `channels.signal.chunkMode`: `length` (por defecto) o `newline` para dividir en líneas en blanco (límites de párrafo) antes de la división por longitud.
- `channels.signal.mediaMaxMb`: límite de medios entrantes/salientes (MB).

Opciones globales relacionadas:

- `agents.list[].groupChat.mentionPatterns` (Signal no soporta menciones nativas).
- `messages.groupChat.mentionPatterns` (respaldo global).
- `messages.responsePrefix`.
