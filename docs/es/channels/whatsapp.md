---
summary: "Integración de WhatsApp (canal web): inicio de sesión, bandeja de entrada, respuestas, medios y operaciones"
read_when:
  - Al trabajar en el comportamiento del canal WhatsApp/web o el enrutamiento de la bandeja de entrada
title: "WhatsApp"
x-i18n:
  source_path: channels/whatsapp.md
  source_hash: 9f7acdf2c71819ae
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:33:22Z
---

# WhatsApp (canal web)

Estado: WhatsApp Web vía Baileys únicamente. El Gateway es propietario de la(s) sesión(es).

## Configuración rápida (principiante)

1. Use un **número de teléfono separado** si es posible (recomendado).
2. Configure WhatsApp en `~/.openclaw/openclaw.json`.
3. Ejecute `openclaw channels login` para escanear el código QR (Dispositivos vinculados).
4. Inicie el gateway.

Configuración mínima:

```json5
{
  channels: {
    whatsapp: {
      dmPolicy: "allowlist",
      allowFrom: ["+15551234567"],
    },
  },
}
```

## Objetivos

- Múltiples cuentas de WhatsApp (multicuenta) en un solo proceso del Gateway.
- Enrutamiento determinista: las respuestas regresan a WhatsApp, sin enrutamiento por modelo.
- El modelo ve suficiente contexto para comprender respuestas citadas.

## Escrituras de configuración

De forma predeterminada, WhatsApp puede escribir actualizaciones de configuración activadas por `/config set|unset` (requiere `commands.config: true`).

Desactivar con:

```json5
{
  channels: { whatsapp: { configWrites: false } },
}
```

## Arquitectura (quién es dueño de qué)

- **Gateway** es propietario del socket de Baileys y del bucle de bandeja de entrada.
- **CLI / app de macOS** se comunican con el gateway; no usan Baileys directamente.
- **Oyente activo** es obligatorio para envíos salientes; de lo contrario, el envío falla de inmediato.

## Obtener un número de teléfono (dos modos)

WhatsApp requiere un número móvil real para la verificación. Los números VoIP y virtuales suelen estar bloqueados. Hay dos formas compatibles de ejecutar OpenClaw en WhatsApp:

### Número dedicado (recomendado)

Use un **número de teléfono separado** para OpenClaw. Mejor UX, enrutamiento limpio, sin rarezas de autochat. Configuración ideal: **teléfono Android de repuesto/viejo + eSIM**. Déjelo con Wi‑Fi y energía, y vincúlelo vía QR.

**WhatsApp Business:** Puede usar WhatsApp Business en el mismo dispositivo con un número diferente. Ideal para mantener su WhatsApp personal separado: instale WhatsApp Business y registre allí el número de OpenClaw.

**Configuración de ejemplo (número dedicado, lista de permitidos de un solo usuario):**

```json5
{
  channels: {
    whatsapp: {
      dmPolicy: "allowlist",
      allowFrom: ["+15551234567"],
    },
  },
}
```

**Modo de emparejamiento (opcional):**  
Si desea emparejamiento en lugar de lista de permitidos, configure `channels.whatsapp.dmPolicy` en `pairing`. Los remitentes desconocidos reciben un código de emparejamiento; apruebe con:
`openclaw pairing approve whatsapp <code>`

### Número personal (alternativa)

Alternativa rápida: ejecute OpenClaw con **su propio número**. Escríbase a usted mismo (WhatsApp “Mensaje a ti mismo”) para pruebas y evitar enviar spam a contactos. Espere leer códigos de verificación en su teléfono principal durante la configuración y los experimentos. **Debe habilitar el modo autochat.**  
Cuando el asistente pida su número personal de WhatsApp, ingrese el teléfono desde el que enviará mensajes (propietario/remitente), no el número del asistente.

**Configuración de ejemplo (número personal, autochat):**

```json
{
  "whatsapp": {
    "selfChatMode": true,
    "dmPolicy": "allowlist",
    "allowFrom": ["+15551234567"]
  }
}
```

Las respuestas de autochat usan por defecto `[{identity.name}]` cuando se establece (de lo contrario `[openclaw]`)
si `messages.responsePrefix` no está configurado. Establézcalo explícitamente para personalizar o desactivar
el prefijo (use `""` para eliminarlo).

### Consejos para obtener números

- **eSIM local** de su operador móvil del país (lo más confiable)
  - Austria: [hot.at](https://www.hot.at)
  - Reino Unido: [giffgaff](https://www.giffgaff.com) — SIM gratis, sin contrato
- **SIM prepago** — económica, solo necesita recibir un SMS para la verificación

**Evite:** TextNow, Google Voice, la mayoría de los servicios de “SMS gratis” — WhatsApp los bloquea agresivamente.

**Consejo:** El número solo necesita recibir un SMS de verificación. Después, las sesiones de WhatsApp Web persisten vía `creds.json`.

## ¿Por qué no Twilio?

- Las primeras versiones de OpenClaw admitían la integración de WhatsApp Business de Twilio.
- Los números de WhatsApp Business no son adecuados para un asistente personal.
- Meta impone una ventana de respuesta de 24 horas; si no ha respondido en las últimas 24 horas, el número empresarial no puede iniciar mensajes nuevos.
- El uso de alto volumen o “conversacional” activa bloqueos agresivos, porque las cuentas empresariales no están pensadas para enviar decenas de mensajes de asistente personal.
- Resultado: entrega poco confiable y bloqueos frecuentes, por lo que se eliminó el soporte.

## Inicio de sesión + credenciales

- Comando de inicio de sesión: `openclaw channels login` (QR vía Dispositivos vinculados).
- Inicio de sesión multicuenta: `openclaw channels login --account <id>` (`<id>` = `accountId`).
- Cuenta predeterminada (cuando se omite `--account`): `default` si existe; de lo contrario, el primer id de cuenta configurado (ordenado).
- Credenciales almacenadas en `~/.openclaw/credentials/whatsapp/<accountId>/creds.json`.
- Copia de respaldo en `creds.json.bak` (se restaura en caso de corrupción).
- Compatibilidad heredada: instalaciones antiguas almacenaban archivos de Baileys directamente en `~/.openclaw/credentials/`.
- Cerrar sesión: `openclaw channels logout` (o `--account <id>`) elimina el estado de autenticación de WhatsApp (pero conserva el `oauth.json` compartido).
- Socket con sesión cerrada ⇒ error que indica volver a vincular.

## Flujo entrante (DM + grupos)

- Los eventos de WhatsApp provienen de `messages.upsert` (Baileys).
- Los oyentes de la bandeja de entrada se desacoplan al apagar para evitar acumular manejadores de eventos en pruebas/reinicios.
- Se ignoran chats de estado/difusión.
- Los chats directos usan E.164; los grupos usan JID de grupo.
- **Política de DM**: `channels.whatsapp.dmPolicy` controla el acceso a chats directos (predeterminado: `pairing`).
  - Emparejamiento: los remitentes desconocidos reciben un código de emparejamiento (apruebe vía `openclaw pairing approve whatsapp <code>`; los códigos expiran después de 1 hora).
  - Abierto: requiere que `channels.whatsapp.allowFrom` incluya `"*"`.
  - Su número de WhatsApp vinculado es implícitamente confiable, por lo que los mensajes propios omiten las comprobaciones de `channels.whatsapp.dmPolicy` y `channels.whatsapp.allowFrom`.

### Modo número personal (alternativa)

Si ejecuta OpenClaw con su **número personal de WhatsApp**, habilite `channels.whatsapp.selfChatMode` (ver ejemplo arriba).

Comportamiento:

- Los DM salientes nunca activan respuestas de emparejamiento (evita enviar spam a contactos).
- Los remitentes desconocidos entrantes siguen `channels.whatsapp.dmPolicy`.
- El modo autochat (allowFrom incluye su número) evita confirmaciones automáticas de lectura e ignora JID de menciones.
- Se envían confirmaciones de lectura para DM que no son autochat.

## Confirmaciones de lectura

De forma predeterminada, el gateway marca los mensajes entrantes de WhatsApp como leídos (doble check azul) una vez aceptados.

Desactivar globalmente:

```json5
{
  channels: { whatsapp: { sendReadReceipts: false } },
}
```

Desactivar por cuenta:

```json5
{
  channels: {
    whatsapp: {
      accounts: {
        personal: { sendReadReceipts: false },
      },
    },
  },
}
```

Notas:

- El modo autochat siempre omite las confirmaciones de lectura.

## FAQ de WhatsApp: envío de mensajes + emparejamiento

**¿OpenClaw enviará mensajes a contactos aleatorios cuando vincule WhatsApp?**  
No. La política de DM predeterminada es **emparejamiento**, por lo que los remitentes desconocidos solo reciben un código de emparejamiento y su mensaje **no se procesa**. OpenClaw solo responde a chats que recibe o a envíos que usted activa explícitamente (agente/CLI).

**¿Cómo funciona el emparejamiento en WhatsApp?**  
El emparejamiento es una puerta de acceso de DM para remitentes desconocidos:

- El primer DM de un remitente nuevo devuelve un código corto (el mensaje no se procesa).
- Apruebe con: `openclaw pairing approve whatsapp <code>` (liste con `openclaw pairing list whatsapp`).
- Los códigos expiran después de 1 hora; las solicitudes pendientes se limitan a 3 por canal.

**¿Pueden varias personas usar distintas instancias de OpenClaw con un solo número de WhatsApp?**  
Sí, enrute cada remitente a un agente distinto mediante `bindings` (par `kind: "dm"`, remitente E.164 como `+15551234567`). Las respuestas siguen saliendo de la **misma cuenta de WhatsApp**, y los chats directos colapsan a la sesión principal de cada agente, así que use **un agente por persona**. El control de acceso a DM (`dmPolicy`/`allowFrom`) es global por cuenta de WhatsApp. Consulte [Enrutamiento multiagente](/concepts/multi-agent).

**¿Por qué el asistente me pide mi número de teléfono?**  
El asistente lo usa para establecer su **lista de permitidos/propietario** y permitir sus propios DM. No se usa para envíos automáticos. Si ejecuta con su número personal de WhatsApp, use ese mismo número y habilite `channels.whatsapp.selfChatMode`.

## Normalización de mensajes (lo que ve el modelo)

- `Body` es el cuerpo del mensaje actual con envolvente.
- El contexto de respuesta citada **siempre se agrega**:

  ```
  [Replying to +1555 id:ABC123]
  <quoted text or <media:...>>
  [/Replying]
  ```

- También se establecen metadatos de respuesta:
  - `ReplyToId` = stanzaId
  - `ReplyToBody` = cuerpo citado o marcador de posición de medios
  - `ReplyToSender` = E.164 cuando se conoce
- Los mensajes entrantes solo de medios usan marcadores de posición:
  - `<media:image|video|audio|document|sticker>`

## Grupos

- Los grupos se asignan a sesiones `agent:<agentId>:whatsapp:group:<jid>`.
- Política de grupos: `channels.whatsapp.groupPolicy = open|disabled|allowlist` (predeterminado `allowlist`).
- Modos de activación:
  - `mention` (predeterminado): requiere @mención o coincidencia por regex.
  - `always`: siempre se activa.
- `/activation mention|always` es solo para propietario y debe enviarse como mensaje independiente.
- Propietario = `channels.whatsapp.allowFrom` (o E.164 propio si no se establece).
- **Inyección de historial** (solo pendientes):
  - Mensajes recientes _no procesados_ (predeterminado 50) insertados bajo:
    `[Chat messages since your last reply - for context]` (los mensajes ya en la sesión no se reinyectan)
  - Mensaje actual bajo:
    `[Current message - respond to this]`
  - Sufijo del remitente agregado: `[from: Name (+E164)]`
- Metadatos del grupo en caché por 5 min (asunto + participantes).

## Entrega de respuestas (hilos)

- WhatsApp Web envía mensajes estándar (sin hilos de respuesta citada en el gateway actual).
- Las etiquetas de respuesta se ignoran en este canal.

## Reacciones de confirmación (auto-reaccionar al recibir)

WhatsApp puede enviar automáticamente reacciones con emoji a los mensajes entrantes inmediatamente al recibirlos, antes de que el bot genere una respuesta. Esto proporciona retroalimentación instantánea a los usuarios de que su mensaje fue recibido.

**Configuración:**

```json
{
  "whatsapp": {
    "ackReaction": {
      "emoji": "👀",
      "direct": true,
      "group": "mentions"
    }
  }
}
```

**Opciones:**

- `emoji` (string): Emoji a usar para la confirmación (p. ej., "👀", "✅", "📨"). Vacío u omitido = función desactivada.
- `direct` (boolean, predeterminado: `true`): Enviar reacciones en chats directos/DM.
- `group` (string, predeterminado: `"mentions"`): Comportamiento en grupos:
  - `"always"`: Reaccionar a todos los mensajes del grupo (incluso sin @mención)
  - `"mentions"`: Reaccionar solo cuando el bot es @mencionado
  - `"never"`: Nunca reaccionar en grupos

**Anulación por cuenta:**

```json
{
  "whatsapp": {
    "accounts": {
      "work": {
        "ackReaction": {
          "emoji": "✅",
          "direct": false,
          "group": "always"
        }
      }
    }
  }
}
```

**Notas de comportamiento:**

- Las reacciones se envían **inmediatamente** al recibir el mensaje, antes de indicadores de escritura o respuestas del bot.
- En grupos con `requireMention: false` (activación: siempre), `group: "mentions"` reaccionará a todos los mensajes (no solo @menciones).
- Enviar y olvidar: los fallos de reacción se registran pero no impiden que el bot responda.
- El JID del participante se incluye automáticamente para reacciones en grupos.
- WhatsApp ignora `messages.ackReaction`; use `channels.whatsapp.ackReaction` en su lugar.

## Herramienta del agente (reacciones)

- Herramienta: `whatsapp` con acción `react` (`chatJid`, `messageId`, `emoji`, `remove` opcional).
- Opcional: `participant` (remitente del grupo), `fromMe` (reaccionar a su propio mensaje), `accountId` (multicuenta).
- Semántica de eliminación de reacciones: consulte [/tools/reactions](/tools/reactions).
- Control de herramienta: `channels.whatsapp.actions.reactions` (predeterminado: habilitado).

## Límites

- El texto saliente se fragmenta a `channels.whatsapp.textChunkLimit` (predeterminado 4000).
- Fragmentación opcional por nueva línea: configure `channels.whatsapp.chunkMode="newline"` para dividir en líneas en blanco (límites de párrafo) antes de fragmentar por longitud.
- Los guardados de medios entrantes están limitados por `channels.whatsapp.mediaMaxMb` (predeterminado 50 MB).
- Los elementos de medios salientes están limitados por `agents.defaults.mediaMaxMb` (predeterminado 5 MB).

## Envío saliente (texto + medios)

- Usa oyente web activo; error si el gateway no está en ejecución.
- Fragmentación de texto: máx. 4k por mensaje (configurable vía `channels.whatsapp.textChunkLimit`, `channels.whatsapp.chunkMode` opcional).
- Medios:
  - Se admiten imagen/video/audio/documento.
  - Audio enviado como PTT; `audio/ogg` => `audio/ogg; codecs=opus`.
  - El subtítulo solo en el primer elemento de medios.
  - La obtención de medios admite HTTP(S) y rutas locales.
  - GIF animados: WhatsApp espera MP4 con `gifPlayback: true` para bucle en línea.
    - CLI: `openclaw message send --media <mp4> --gif-playback`
    - Gateway: los parámetros de `send` incluyen `gifPlayback: true`

## Notas de voz (audio PTT)

WhatsApp envía audio como **notas de voz** (burbuja PTT).

- Mejores resultados: OGG/Opus. OpenClaw reescribe `audio/ogg` a `audio/ogg; codecs=opus`.
- `[[audio_as_voice]]` se ignora para WhatsApp (el audio ya se envía como nota de voz).

## Límites de medios + optimización

- Límite saliente predeterminado: 5 MB (por elemento de medios).
- Anulación: `agents.defaults.mediaMaxMb`.
- Las imágenes se optimizan automáticamente a JPEG bajo el límite (redimensionado + barrido de calidad).
- Medios sobredimensionados ⇒ error; la respuesta de medios vuelve a una advertencia de texto.

## Latidos

- **Latido del Gateway** registra la salud de la conexión (`web.heartbeatSeconds`, predeterminado 60 s).
- **Latido del agente** puede configurarse por agente (`agents.list[].heartbeat`) o globalmente
  vía `agents.defaults.heartbeat` (alternativa cuando no hay entradas por agente).
  - Usa el prompt de latido configurado (predeterminado: `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`) + el comportamiento de omisión `HEARTBEAT_OK`.
  - La entrega usa por defecto el último canal utilizado (o el destino configurado).

## Comportamiento de reconexión

- Política de backoff: `web.reconnect`:
  - `initialMs`, `maxMs`, `factor`, `jitter`, `maxAttempts`.
- Si se alcanza maxAttempts, el monitoreo web se detiene (degradado).
- Sesión cerrada ⇒ detener y requerir volver a vincular.

## Mapa rápido de configuración

- `channels.whatsapp.dmPolicy` (política de DM: emparejamiento/lista de permitidos/abierto/deshabilitado).
- `channels.whatsapp.selfChatMode` (configuración mismo teléfono; el bot usa su número personal de WhatsApp).
- `channels.whatsapp.allowFrom` (lista de permitidos de DM). WhatsApp usa números telefónicos E.164 (sin nombres de usuario).
- `channels.whatsapp.mediaMaxMb` (límite de guardado de medios entrantes).
- `channels.whatsapp.ackReaction` (auto-reacción al recibir mensajes: `{emoji, direct, group}`).
- `channels.whatsapp.accounts.<accountId>.*` (configuración por cuenta + `authDir` opcional).
- `channels.whatsapp.accounts.<accountId>.mediaMaxMb` (límite de medios entrantes por cuenta).
- `channels.whatsapp.accounts.<accountId>.ackReaction` (anulación de reacción de confirmación por cuenta).
- `channels.whatsapp.groupAllowFrom` (lista de permitidos de remitentes de grupo).
- `channels.whatsapp.groupPolicy` (política de grupos).
- `channels.whatsapp.historyLimit` / `channels.whatsapp.accounts.<accountId>.historyLimit` (contexto de historial de grupo; `0` deshabilita).
- `channels.whatsapp.dmHistoryLimit` (límite de historial de DM en turnos de usuario). Anulaciones por usuario: `channels.whatsapp.dms["<phone>"].historyLimit`.
- `channels.whatsapp.groups` (lista de permitidos de grupos + valores predeterminados de control por mención; use `"*"` para permitir todo)
- `channels.whatsapp.actions.reactions` (control de reacciones de herramientas de WhatsApp).
- `agents.list[].groupChat.mentionPatterns` (o `messages.groupChat.mentionPatterns`)
- `messages.groupChat.historyLimit`
- `channels.whatsapp.messagePrefix` (prefijo entrante; por cuenta: `channels.whatsapp.accounts.<accountId>.messagePrefix`; obsoleto: `messages.messagePrefix`)
- `messages.responsePrefix` (prefijo saliente)
- `agents.defaults.mediaMaxMb`
- `agents.defaults.heartbeat.every`
- `agents.defaults.heartbeat.model` (anulación opcional)
- `agents.defaults.heartbeat.target`
- `agents.defaults.heartbeat.to`
- `agents.defaults.heartbeat.session`
- `agents.list[].heartbeat.*` (anulaciones por agente)
- `session.*` (scope, idle, store, mainKey)
- `web.enabled` (deshabilitar inicio del canal cuando es false)
- `web.heartbeatSeconds`
- `web.reconnect.*`

## Registros + solución de problemas

- Subsistemas: `whatsapp/inbound`, `whatsapp/outbound`, `web-heartbeat`, `web-reconnect`.
- Archivo de registro: `/tmp/openclaw/openclaw-YYYY-MM-DD.log` (configurable).
- Guía de solución de problemas: [Solución de problemas del Gateway](/gateway/troubleshooting).

## Solución de problemas (rápida)

**No vinculado / se requiere inicio de sesión por QR**

- Síntoma: `channels status` muestra `linked: false` o advierte “No vinculado”.
- Solución: ejecute `openclaw channels login` en el host del Gateway y escanee el QR (WhatsApp → Configuración → Dispositivos vinculados).

**Vinculado pero desconectado / bucle de reconexión**

- Síntoma: `channels status` muestra `running, disconnected` o advierte “Vinculado pero desconectado”.
- Solución: `openclaw doctor` (o reinicie el gateway). Si persiste, vuelva a vincular vía `channels login` e inspeccione `openclaw logs --follow`.

**Runtime Bun**

- Bun **no es recomendado**. WhatsApp (Baileys) y Telegram no son confiables en Bun.
  Ejecute el gateway con **Node**. (Consulte la nota de runtime en Primeros pasos.)
