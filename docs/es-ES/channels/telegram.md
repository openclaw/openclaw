---
summary: "Estado de soporte de bot de Telegram, capacidades y configuración"
read_when:
  - Trabajando en características de Telegram o webhooks
title: "Telegram"
---

# Telegram (API de Bot)

Estado: listo para producción para DMs de bot + grupos a través de grammY. El sondeo largo es el modo predeterminado; el modo webhook es opcional.

<CardGroup cols={3}>
  <Card title="Emparejamiento" icon="link" href="/es-ES/channels/pairing">
    La política DM predeterminada para Telegram es emparejamiento.
  </Card>
  <Card title="Solución de problemas de canales" icon="wrench" href="/es-ES/channels/troubleshooting">
    Diagnósticos entre canales y guías de reparación.
  </Card>
  <Card title="Configuración del gateway" icon="settings" href="/es-ES/gateway/configuration">
    Patrones de configuración completos de canales y ejemplos.
  </Card>
</CardGroup>

## Configuración rápida

<Steps>
  <Step title="Crear el token del bot en BotFather">
    Abre Telegram y chatea con **@BotFather** (confirma que el handle sea exactamente `@BotFather`).

    Ejecuta `/newbot`, sigue las instrucciones y guarda el token.

  </Step>

  <Step title="Configurar token y política DM">

```json5
{
  channels: {
    telegram: {
      enabled: true,
      botToken: "123:abc",
      dmPolicy: "pairing",
      groups: { "*": { requireMention: true } },
    },
  },
}
```

    Alternativa de entorno: `TELEGRAM_BOT_TOKEN=...` (solo cuenta predeterminada).

  </Step>

  <Step title="Iniciar gateway y aprobar primer DM">

```bash
openclaw gateway
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

    Los códigos de emparejamiento expiran después de 1 hora.

  </Step>

  <Step title="Agregar el bot a un grupo">
    Agrega el bot a tu grupo, luego configura `channels.telegram.groups` y `groupPolicy` para que coincida con tu modelo de acceso.
  </Step>
</Steps>

<Note>
El orden de resolución de tokens es consciente de la cuenta. En la práctica, los valores de configuración ganan sobre la alternativa de entorno, y `TELEGRAM_BOT_TOKEN` solo se aplica a la cuenta predeterminada.
</Note>

## Configuración del lado de Telegram

<AccordionGroup>
  <Accordion title="Modo de privacidad y visibilidad de grupo">
    Los bots de Telegram tienen el **Modo de Privacidad** habilitado de forma predeterminada, lo que limita qué mensajes de grupo reciben.

    Si el bot debe ver todos los mensajes de grupo, ya sea:

    - deshabilita el modo de privacidad a través de `/setprivacy`, o
    - haz que el bot sea administrador del grupo.

    Al alternar el modo de privacidad, elimina y vuelve a agregar el bot en cada grupo para que Telegram aplique el cambio.

  </Accordion>

  <Accordion title="Permisos de grupo">
    El estado de administrador se controla en la configuración del grupo de Telegram.

    Los bots administradores reciben todos los mensajes de grupo, lo cual es útil para comportamiento de grupo siempre activo.

  </Accordion>

  <Accordion title="Alternancias útiles de BotFather">

    - `/setjoingroups` para permitir/denegar adiciones a grupos
    - `/setprivacy` para comportamiento de visibilidad de grupo

  </Accordion>
</AccordionGroup>

## Control de acceso y activación

<Tabs>
  <Tab title="Política DM">
    `channels.telegram.dmPolicy` controla el acceso a mensajes directos:

    - `pairing` (predeterminado)
    - `allowlist`
    - `open` (requiere que `allowFrom` incluya `"*"`)
    - `disabled`

    `channels.telegram.allowFrom` acepta IDs de usuario de Telegram numéricos. Los prefijos `telegram:` / `tg:` se aceptan y normalizan.
    El asistente de incorporación acepta entrada `@username` y lo resuelve a IDs numéricos.
    Si actualizaste y tu configuración contiene entradas de lista de permitidos `@username`, ejecuta `openclaw doctor --fix` para resolverlas (mejor esfuerzo; requiere un token de bot de Telegram).

    ### Encontrar tu ID de usuario de Telegram

    Más seguro (sin bot de terceros):

    1. Envía un DM a tu bot.
    2. Ejecuta `openclaw logs --follow`.
    3. Lee `from.id`.

    Método oficial de la API de Bot:

```bash
curl "https://api.telegram.org/bot<bot_token>/getUpdates"
```

    Método de terceros (menos privado): `@userinfobot` o `@getidsbot`.

  </Tab>

  <Tab title="Política de grupo y listas de permitidos">
    Hay dos controles independientes:

    1. **Qué grupos están permitidos** (`channels.telegram.groups`)
       - sin configuración de `groups`: todos los grupos permitidos
       - `groups` configurado: actúa como lista de permitidos (IDs explícitos o `"*"`)

    2. **Qué remitentes están permitidos en grupos** (`channels.telegram.groupPolicy`)
       - `open`
       - `allowlist` (predeterminado)
       - `disabled`

    `groupAllowFrom` se usa para filtrado de remitentes de grupo. Si no está configurado, Telegram recurre a `allowFrom`.
    Las entradas de `groupAllowFrom` deben ser IDs de usuario de Telegram numéricos.

    Ejemplo: permitir cualquier miembro en un grupo específico:

```json5
{
  channels: {
    telegram: {
      groups: {
        "-1001234567890": {
          groupPolicy: "open",
          requireMention: false,
        },
      },
    },
  },
}
```

  </Tab>

  <Tab title="Comportamiento de menciones">
    Las respuestas de grupo requieren mención de forma predeterminada.

    La mención puede provenir de:

    - mención nativa `@botusername`, o
    - patrones de mención en:
      - `agents.list[].groupChat.mentionPatterns`
      - `messages.groupChat.mentionPatterns`

    Alternancias de comando a nivel de sesión:

    - `/activation always`
    - `/activation mention`

    Estos actualizan solo el estado de la sesión. Usa configuración para persistencia.

    Ejemplo de configuración persistente:

```json5
{
  channels: {
    telegram: {
      groups: {
        "*": { requireMention: false },
      },
    },
  },
}
```

    Obtener el ID de chat de grupo:

    - reenvía un mensaje de grupo a `@userinfobot` / `@getidsbot`
    - o lee `chat.id` de `openclaw logs --follow`
    - o inspecciona `getUpdates` de la API de Bot

  </Tab>
</Tabs>

## Comportamiento en tiempo de ejecución

- Telegram es propiedad del proceso del gateway.
- El enrutamiento es determinístico: las respuestas entrantes de Telegram regresan a Telegram (el modelo no elige canales).
- Los mensajes entrantes se normalizan en el sobre de canal compartido con metadatos de respuesta y marcadores de medios.
- Las sesiones de grupo están aisladas por ID de grupo. Los temas del foro agregan `:topic:<threadId>` para mantener los temas aislados.
- Los mensajes DM pueden llevar `message_thread_id`; OpenClaw los enruta con claves de sesión conscientes de hilos y conserva el ID de hilo para respuestas.
- El sondeo largo usa el runner de grammY con secuenciación por chat/hilo. La concurrencia general del sink del runner usa `agents.defaults.maxConcurrent`.
- La API de Bot de Telegram no tiene soporte de recibos de lectura (`sendReadReceipts` no aplica).

## Referencia de características

<AccordionGroup>
  <Accordion title="Vista previa de transmisión en vivo (ediciones de mensaje)">
    OpenClaw puede transmitir respuestas parciales enviando un mensaje temporal de Telegram y editándolo a medida que llega el texto.

    Requisito:

    - `channels.telegram.streamMode` no es `"off"` (predeterminado: `"partial"`)

    Modos:

    - `off`: sin vista previa en vivo
    - `partial`: actualizaciones frecuentes de vista previa del texto parcial
    - `block`: actualizaciones de vista previa fragmentadas usando `channels.telegram.draftChunk`

    Valores predeterminados de `draftChunk` para `streamMode: "block"`:

    - `minChars: 200`
    - `maxChars: 800`
    - `breakPreference: "paragraph"`

    `maxChars` está limitado por `channels.telegram.textChunkLimit`.

    Esto funciona en chats directos y grupos/temas.

    Para respuestas solo de texto, OpenClaw mantiene el mismo mensaje de vista previa y realiza una edición final en el lugar (sin segundo mensaje).

    Para respuestas complejas (por ejemplo, cargas útiles de medios), OpenClaw recurre a la entrega final normal y luego limpia el mensaje de vista previa.

    `streamMode` es independiente de la transmisión de bloques. Cuando la transmisión de bloques está habilitada explícitamente para Telegram, OpenClaw omite la transmisión de vista previa para evitar la doble transmisión.

    Transmisión de razonamiento solo para Telegram:

    - `/reasoning stream` envía razonamiento a la vista previa en vivo mientras genera
    - la respuesta final se envía sin texto de razonamiento

  </Accordion>

  <Accordion title="Formato y alternativa HTML">
    El texto saliente usa `parse_mode: "HTML"` de Telegram.

    - El texto similar a Markdown se renderiza a HTML seguro para Telegram.
    - El HTML del modelo sin procesar se escapa para reducir fallos de análisis de Telegram.
    - Si Telegram rechaza el HTML analizado, OpenClaw reintenta como texto plano.

    Las vistas previas de enlaces están habilitadas de forma predeterminada y se pueden deshabilitar con `channels.telegram.linkPreview: false`.

  </Accordion>

  <Accordion title="Comandos nativos y comandos personalizados">
    El registro del menú de comandos de Telegram se maneja al inicio con `setMyCommands`.

    Valores predeterminados de comandos nativos:

    - `commands.native: "auto"` habilita comandos nativos para Telegram

    Agregar entradas personalizadas al menú de comandos:

```json5
{
  channels: {
    telegram: {
      customCommands: [
        { command: "backup", description: "Git backup" },
        { command: "generate", description: "Create an image" },
      ],
    },
  },
}
```

    Reglas:

    - los nombres se normalizan (eliminar `/` inicial, minúsculas)
    - patrón válido: `a-z`, `0-9`, `_`, longitud `1..32`
    - los comandos personalizados no pueden anular comandos nativos
    - los conflictos/duplicados se omiten y registran

    Notas:

    - los comandos personalizados son solo entradas de menú; no implementan automáticamente comportamiento
    - los comandos de plugin/skill aún pueden funcionar cuando se escriben incluso si no se muestran en el menú de Telegram

    Si los comandos nativos están deshabilitados, se eliminan los integrados. Los comandos personalizados/de plugin aún pueden registrarse si están configurados.

    Fallo de configuración común:

    - `setMyCommands failed` generalmente significa que el DNS/HTTPS saliente a `api.telegram.org` está bloqueado.

    ### Comandos de emparejamiento de dispositivo (plugin `device-pair`)

    Cuando el plugin `device-pair` está instalado:

    1. `/pair` genera código de configuración
    2. pega el código en la aplicación iOS
    3. `/pair approve` aprueba la última solicitud pendiente

    Más detalles: [Emparejamiento](/es-ES/channels/pairing#pair-via-telegram-recommended-for-ios).

  </Accordion>

  <Accordion title="Botones en línea">
    Configurar el alcance del teclado en línea:

```json5
{
  channels: {
    telegram: {
      capabilities: {
        inlineButtons: "allowlist",
      },
    },
  },
}
```

    Anulación por cuenta:

```json5
{
  channels: {
    telegram: {
      accounts: {
        main: {
          capabilities: {
            inlineButtons: "allowlist",
          },
        },
      },
    },
  },
}
```

    Alcances:

    - `off`
    - `dm`
    - `group`
    - `all`
    - `allowlist` (predeterminado)

    El `capabilities: ["inlineButtons"]` heredado se asigna a `inlineButtons: "all"`.

    Ejemplo de acción de mensaje:

```json5
{
  action: "send",
  channel: "telegram",
  to: "123456789",
  message: "Choose an option:",
  buttons: [
    [
      { text: "Yes", callback_data: "yes" },
      { text: "No", callback_data: "no" },
    ],
    [{ text: "Cancel", callback_data: "cancel" }],
  ],
}
```

    Los clics de callback se pasan al agente como texto:
    `callback_data: <value>`

  </Accordion>

  <Accordion title="Acciones de mensaje de Telegram para agentes y automatización">
    Las acciones de herramientas de Telegram incluyen:

    - `sendMessage` (`to`, `content`, `mediaUrl` opcional, `replyToMessageId`, `messageThreadId`)
    - `react` (`chatId`, `messageId`, `emoji`)
    - `deleteMessage` (`chatId`, `messageId`)
    - `editMessage` (`chatId`, `messageId`, `content`)

    Las acciones de mensaje de canal exponen alias ergonómicos (`send`, `react`, `delete`, `edit`, `sticker`, `sticker-search`).

    Controles de bloqueo:

    - `channels.telegram.actions.sendMessage`
    - `channels.telegram.actions.editMessage`
    - `channels.telegram.actions.deleteMessage`
    - `channels.telegram.actions.reactions`
    - `channels.telegram.actions.sticker` (predeterminado: deshabilitado)

    Semántica de eliminación de reacción: [/tools/reactions](/es-ES/tools/reactions)

  </Accordion>

  <Accordion title="Etiquetas de hilo de respuesta">
    Telegram admite etiquetas de hilo de respuesta explícitas en la salida generada:

    - `[[reply_to_current]]` responde al mensaje activador
    - `[[reply_to:<id>]]` responde a un ID de mensaje de Telegram específico

    `channels.telegram.replyToMode` controla el manejo:

    - `off` (predeterminado)
    - `first`
    - `all`

    Nota: `off` deshabilita el hilo de respuesta implícito. Las etiquetas explícitas `[[reply_to_*]]` todavía se respetan.

  </Accordion>

  <Accordion title="Temas de foro y comportamiento de hilos">
    Supergrupos de foro:

    - las claves de sesión de tema agregan `:topic:<threadId>`
    - las respuestas y la escritura se dirigen al hilo del tema
    - ruta de configuración del tema:
      `channels.telegram.groups.<chatId>.topics.<threadId>`

    Caso especial del tema general (`threadId=1`):

    - los envíos de mensajes omiten `message_thread_id` (Telegram rechaza `sendMessage(...thread_id=1)`)
    - las acciones de escritura aún incluyen `message_thread_id`

    Herencia de tema: las entradas de tema heredan la configuración del grupo a menos que se anulen (`requireMention`, `allowFrom`, `skills`, `systemPrompt`, `enabled`, `groupPolicy`).

    El contexto de plantilla incluye:

    - `MessageThreadId`
    - `IsForum`

    Comportamiento de hilo DM:

    - los chats privados con `message_thread_id` mantienen el enrutamiento DM pero usan claves de sesión/objetivos de respuesta conscientes de hilos.

  </Accordion>

  <Accordion title="Audio, video y stickers">
    ### Mensajes de audio

    Telegram distingue notas de voz vs archivos de audio.

    - predeterminado: comportamiento de archivo de audio
    - etiqueta `[[audio_as_voice]]` en la respuesta del agente para forzar el envío de nota de voz

    Ejemplo de acción de mensaje:

```json5
{
  action: "send",
  channel: "telegram",
  to: "123456789",
  media: "https://example.com/voice.ogg",
  asVoice: true,
}
```

    ### Mensajes de video

    Telegram distingue archivos de video vs notas de video.

    Ejemplo de acción de mensaje:

```json5
{
  action: "send",
  channel: "telegram",
  to: "123456789",
  media: "https://example.com/video.mp4",
  asVideoNote: true,
}
```

    Las notas de video no admiten subtítulos; el texto del mensaje proporcionado se envía por separado.

    ### Stickers

    Manejo de sticker entrante:

    - WEBP estático: descargado y procesado (marcador `<media:sticker>`)
    - TGS animado: omitido
    - WEBM video: omitido

    Campos de contexto de sticker:

    - `Sticker.emoji`
    - `Sticker.setName`
    - `Sticker.fileId`
    - `Sticker.fileUniqueId`
    - `Sticker.cachedDescription`

    Archivo de caché de sticker:

    - `~/.openclaw/telegram/sticker-cache.json`

    Los stickers se describen una vez (cuando es posible) y se almacenan en caché para reducir llamadas de visión repetidas.

    Habilitar acciones de sticker:

```json5
{
  channels: {
    telegram: {
      actions: {
        sticker: true,
      },
    },
  },
}
```

    Acción de envío de sticker:

```json5
{
  action: "sticker",
  channel: "telegram",
  to: "123456789",
  fileId: "CAACAgIAAxkBAAI...",
}
```

    Buscar stickers en caché:

```json5
{
  action: "sticker-search",
  channel: "telegram",
  query: "cat waving",
  limit: 5,
}
```

  </Accordion>

  <Accordion title="Notificaciones de reacción">
    Las reacciones de Telegram llegan como actualizaciones `message_reaction` (separadas de las cargas útiles de mensaje).

    Cuando está habilitado, OpenClaw encola eventos del sistema como:

    - `Telegram reaction added: 👍 by Alice (@alice) on msg 42`

    Configuración:

    - `channels.telegram.reactionNotifications`: `off | own | all` (predeterminado: `own`)
    - `channels.telegram.reactionLevel`: `off | ack | minimal | extensive` (predeterminado: `minimal`)

    Notas:

    - `own` significa reacciones del usuario solo a mensajes enviados por el bot (mejor esfuerzo a través de caché de mensajes enviados).
    - Telegram no proporciona IDs de hilo en actualizaciones de reacción.
      - grupos no-foro enrutan a sesión de chat de grupo
      - grupos de foro enrutan a la sesión de tema general del grupo (`:topic:1`), no al tema de origen exacto

    `allowed_updates` para sondeo/webhook incluye `message_reaction` automáticamente.

  </Accordion>

  <Accordion title="Reacciones de confirmación">
    `ackReaction` envía un emoji de confirmación mientras OpenClaw está procesando un mensaje entrante.

    Orden de resolución:

    - `channels.telegram.accounts.<accountId>.ackReaction`
    - `channels.telegram.ackReaction`
    - `messages.ackReaction`
    - alternativa de emoji de identidad del agente (`agents.list[].identity.emoji`, sino "👀")

    Notas:

    - Telegram espera emoji unicode (por ejemplo "👀").
    - Usa `""` para deshabilitar la reacción para un canal o cuenta.

  </Accordion>

  <Accordion title="Escrituras de configuración desde eventos y comandos de Telegram">
    Las escrituras de configuración del canal están habilitadas de forma predeterminada (`configWrites !== false`).

    Las escrituras activadas por Telegram incluyen:

    - eventos de migración de grupo (`migrate_to_chat_id`) para actualizar `channels.telegram.groups`
    - `/config set` y `/config unset` (requiere habilitación de comando)

    Deshabilitar:

```json5
{
  channels: {
    telegram: {
      configWrites: false,
    },
  },
}
```

  </Accordion>

  <Accordion title="Sondeo largo vs webhook">
    Predeterminado: sondeo largo.

    Modo webhook:

    - establece `channels.telegram.webhookUrl`
    - establece `channels.telegram.webhookSecret` (requerido cuando se establece URL de webhook)
    - `channels.telegram.webhookPath` opcional (predeterminado `/telegram-webhook`)
    - `channels.telegram.webhookHost` opcional (predeterminado `127.0.0.1`)

    El listener local predeterminado para modo webhook se vincula a `127.0.0.1:8787`.

    Si tu endpoint público difiere, coloca un proxy inverso al frente y apunta `webhookUrl` a la URL pública.
    Establece `webhookHost` (por ejemplo `0.0.0.0`) cuando intencionalmente necesitas ingreso externo.

  </Accordion>

  <Accordion title="Límites, reintentos y objetivos CLI">
    - `channels.telegram.textChunkLimit` predeterminado es 4000.
    - `channels.telegram.chunkMode="newline"` prefiere límites de párrafo (líneas en blanco) antes de división por longitud.
    - `channels.telegram.mediaMaxMb` (predeterminado 5) limita el tamaño de descarga/procesamiento de medios entrantes de Telegram.
    - `channels.telegram.timeoutSeconds` anula el tiempo de espera del cliente de la API de Telegram (si no está configurado, se aplica el predeterminado de grammY).
    - el historial de contexto de grupo usa `channels.telegram.historyLimit` o `messages.groupChat.historyLimit` (predeterminado 50); `0` deshabilita.
    - controles de historial DM:
      - `channels.telegram.dmHistoryLimit`
      - `channels.telegram.dms["<user_id>"].historyLimit`
    - los reintentos salientes de la API de Telegram son configurables a través de `channels.telegram.retry`.

    El objetivo de envío CLI puede ser ID de chat numérico o nombre de usuario:

```bash
openclaw message send --channel telegram --target 123456789 --message "hi"
openclaw message send --channel telegram --target @name --message "hi"
```

  </Accordion>
</AccordionGroup>

## Solución de problemas

<AccordionGroup>
  <Accordion title="El bot no responde a mensajes de grupo sin mención">

    - Si `requireMention=false`, el modo de privacidad de Telegram debe permitir visibilidad completa.
      - BotFather: `/setprivacy` -> Disable
      - luego elimina + vuelve a agregar bot al grupo
    - `openclaw channels status` advierte cuando la configuración espera mensajes de grupo sin mención.
    - `openclaw channels status --probe` puede verificar IDs de grupo numéricos explícitos; el comodín `"*"` no se puede probar por membresía.
    - prueba rápida de sesión: `/activation always`.

  </Accordion>

  <Accordion title="El bot no ve mensajes de grupo en absoluto">

    - cuando existe `channels.telegram.groups`, el grupo debe estar listado (o incluir `"*"`)
    - verifica la membresía del bot en el grupo
    - revisa logs: `openclaw logs --follow` para razones de omisión

  </Accordion>

  <Accordion title="Los comandos funcionan parcialmente o no funcionan en absoluto">

    - autoriza tu identidad de remitente (emparejamiento y/o `allowFrom` numérico)
    - la autorización de comandos aún se aplica incluso cuando la política de grupo es `open`
    - `setMyCommands failed` generalmente indica problemas de alcance DNS/HTTPS a `api.telegram.org`

  </Accordion>

  <Accordion title="Sondeo o inestabilidad de red">

    - Node 22+ + fetch/proxy personalizado puede activar comportamiento de aborto inmediato si los tipos de AbortSignal no coinciden.
    - Algunos hosts resuelven `api.telegram.org` primero a IPv6; el egreso IPv6 roto puede causar fallos intermitentes de la API de Telegram.
    - Valida respuestas DNS:

```bash
dig +short api.telegram.org A
dig +short api.telegram.org AAAA
```

  </Accordion>
</AccordionGroup>

Más ayuda: [Solución de problemas de canales](/es-ES/channels/troubleshooting).

## Punteros de referencia de configuración de Telegram

Referencia principal:

- `channels.telegram.enabled`: habilitar/deshabilitar inicio de canal.
- `channels.telegram.botToken`: token de bot (BotFather).
- `channels.telegram.tokenFile`: leer token desde ruta de archivo.
- `channels.telegram.dmPolicy`: `pairing | allowlist | open | disabled` (predeterminado: pairing).
- `channels.telegram.allowFrom`: lista de permitidos DM (IDs de usuario de Telegram numéricos). `open` requiere `"*"`. `openclaw doctor --fix` puede resolver entradas heredadas `@username` a IDs.
- `channels.telegram.groupPolicy`: `open | allowlist | disabled` (predeterminado: allowlist).
- `channels.telegram.groupAllowFrom`: lista de permitidos de remitente de grupo (IDs de usuario de Telegram numéricos). `openclaw doctor --fix` puede resolver entradas heredadas `@username` a IDs.
- `channels.telegram.groups`: valores predeterminados por grupo + lista de permitidos (usa `"*"` para valores predeterminados globales).
  - `channels.telegram.groups.<id>.groupPolicy`: anulación por grupo para groupPolicy (`open | allowlist | disabled`).
  - `channels.telegram.groups.<id>.requireMention`: bloqueo de mención predeterminado.
  - `channels.telegram.groups.<id>.skills`: filtro de skill (omitir = todas las skills, vacío = ninguna).
  - `channels.telegram.groups.<id>.allowFrom`: anulación de lista de permitidos de remitente por grupo.
  - `channels.telegram.groups.<id>.systemPrompt`: prompt de sistema extra para el grupo.
  - `channels.telegram.groups.<id>.enabled`: deshabilitar el grupo cuando es `false`.
  - `channels.telegram.groups.<id>.topics.<threadId>.*`: anulaciones por tema (mismos campos que grupo).
  - `channels.telegram.groups.<id>.topics.<threadId>.groupPolicy`: anulación por tema para groupPolicy (`open | allowlist | disabled`).
  - `channels.telegram.groups.<id>.topics.<threadId>.requireMention`: anulación de bloqueo de mención por tema.
- `channels.telegram.capabilities.inlineButtons`: `off | dm | group | all | allowlist` (predeterminado: allowlist).
- `channels.telegram.accounts.<account>.capabilities.inlineButtons`: anulación por cuenta.
- `channels.telegram.replyToMode`: `off | first | all` (predeterminado: `off`).
- `channels.telegram.textChunkLimit`: tamaño de fragmento saliente (caracteres).
- `channels.telegram.chunkMode`: `length` (predeterminado) o `newline` para dividir en líneas en blanco (límites de párrafo) antes de fragmentación por longitud.
- `channels.telegram.linkPreview`: alternar vistas previas de enlaces para mensajes salientes (predeterminado: true).
- `channels.telegram.streamMode`: `off | partial | block` (vista previa de transmisión en vivo).
- `channels.telegram.mediaMaxMb`: límite de medios entrantes/salientes (MB).
- `channels.telegram.retry`: política de reintento para llamadas salientes de API de Telegram (intentos, minDelayMs, maxDelayMs, jitter).
- `channels.telegram.network.autoSelectFamily`: anular autoSelectFamily de Node (true=habilitar, false=deshabilitar). Predeterminado deshabilitado en Node 22 para evitar tiempos de espera de Happy Eyeballs.
- `channels.telegram.proxy`: URL de proxy para llamadas a la API de Bot (SOCKS/HTTP).
- `channels.telegram.webhookUrl`: habilitar modo webhook (requiere `channels.telegram.webhookSecret`).
- `channels.telegram.webhookSecret`: secreto de webhook (requerido cuando se establece webhookUrl).
- `channels.telegram.webhookPath`: ruta de webhook local (predeterminado `/telegram-webhook`).
- `channels.telegram.webhookHost`: host de enlace de webhook local (predeterminado `127.0.0.1`).
- `channels.telegram.actions.reactions`: bloquear reacciones de herramienta de Telegram.
- `channels.telegram.actions.sendMessage`: bloquear envíos de mensajes de herramienta de Telegram.
- `channels.telegram.actions.deleteMessage`: bloquear eliminaciones de mensajes de herramienta de Telegram.
- `channels.telegram.actions.sticker`: bloquear acciones de sticker de Telegram — enviar y buscar (predeterminado: false).
- `channels.telegram.reactionNotifications`: `off | own | all` — controlar qué reacciones activan eventos del sistema (predeterminado: `own` cuando no está configurado).
- `channels.telegram.reactionLevel`: `off | ack | minimal | extensive` — controlar capacidad de reacción del agente (predeterminado: `minimal` cuando no está configurado).

- [Referencia de configuración - Telegram](/es-ES/gateway/configuration-reference#telegram)

Campos de alta señal específicos de Telegram:

- inicio/autenticación: `enabled`, `botToken`, `tokenFile`, `accounts.*`
- control de acceso: `dmPolicy`, `allowFrom`, `groupPolicy`, `groupAllowFrom`, `groups`, `groups.*.topics.*`
- comando/menú: `commands.native`, `customCommands`
- hilos/respuestas: `replyToMode`
- transmisión: `streamMode` (vista previa), `draftChunk`, `blockStreaming`
- formato/entrega: `textChunkLimit`, `chunkMode`, `linkPreview`, `responsePrefix`
- medios/red: `mediaMaxMb`, `timeoutSeconds`, `retry`, `network.autoSelectFamily`, `proxy`
- webhook: `webhookUrl`, `webhookSecret`, `webhookPath`, `webhookHost`
- acciones/capacidades: `capabilities.inlineButtons`, `actions.sendMessage|editMessage|deleteMessage|reactions|sticker`
- reacciones: `reactionNotifications`, `reactionLevel`
- escrituras/historial: `configWrites`, `historyLimit`, `dmHistoryLimit`, `dms.*.historyLimit`

## Relacionado

- [Emparejamiento](/es-ES/channels/pairing)
- [Enrutamiento de canales](/es-ES/channels/channel-routing)
- [Solución de problemas](/es-ES/channels/troubleshooting)
