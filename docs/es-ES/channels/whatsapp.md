---
summary: "Soporte del canal de WhatsApp, controles de acceso, comportamiento de entrega y operaciones"
read_when:
  - Trabajando en comportamiento del canal de WhatsApp/web o enrutamiento de bandeja de entrada
title: "WhatsApp"
---

# WhatsApp (canal Web)

Estado: listo para producción a través de WhatsApp Web (Baileys). El gateway gestiona sesión(es) vinculada(s).

<CardGroup cols={3}>
  <Card title="Emparejamiento" icon="link" href="/es-ES/channels/pairing">
    La política DM predeterminada es emparejamiento para remitentes desconocidos.
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
  <Step title="Configurar política de acceso de WhatsApp">

```json5
{
  channels: {
    whatsapp: {
      dmPolicy: "pairing",
      allowFrom: ["+15551234567"],
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15551234567"],
    },
  },
}
```

  </Step>

  <Step title="Vincular WhatsApp (QR)">

```bash
openclaw channels login --channel whatsapp
```

    Para una cuenta específica:

```bash
openclaw channels login --channel whatsapp --account work
```

  </Step>

  <Step title="Iniciar el gateway">

```bash
openclaw gateway
```

  </Step>

  <Step title="Aprobar primera solicitud de emparejamiento (si usas modo de emparejamiento)">

```bash
openclaw pairing list whatsapp
openclaw pairing approve whatsapp <CODE>
```

    Las solicitudes de emparejamiento expiran después de 1 hora. Las solicitudes pendientes tienen un límite de 3 por canal.

  </Step>
</Steps>

<Note>
OpenClaw recomienda ejecutar WhatsApp en un número separado cuando sea posible. (Los metadatos del canal y el flujo de incorporación están optimizados para esa configuración, pero también se admiten configuraciones con números personales.)
</Note>

## Patrones de implementación

<AccordionGroup>
  <Accordion title="Número dedicado (recomendado)">
    Este es el modo operativo más limpio:

    - identidad de WhatsApp separada para OpenClaw
    - listas de permitidos de DM y límites de enrutamiento más claros
    - menor probabilidad de confusión en chat consigo mismo

    Patrón de política mínima:

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

  </Accordion>

  <Accordion title="Alternativa con número personal">
    La incorporación admite modo de número personal y escribe una línea base amigable para chat consigo mismo:

    - `dmPolicy: "allowlist"`
    - `allowFrom` incluye tu número personal
    - `selfChatMode: true`

    En tiempo de ejecución, las protecciones de chat consigo mismo se activan según el número propio vinculado y `allowFrom`.

  </Accordion>

  <Accordion title="Alcance del canal solo de WhatsApp Web">
    El canal de la plataforma de mensajería está basado en WhatsApp Web (`Baileys`) en la arquitectura de canales actual de OpenClaw.

    No hay un canal de mensajería de WhatsApp de Twilio separado en el registro de canales de chat integrados.

  </Accordion>
</AccordionGroup>

## Modelo de tiempo de ejecución

- El gateway posee el socket de WhatsApp y el bucle de reconexión.
- Los envíos salientes requieren un listener de WhatsApp activo para la cuenta de destino.
- Los chats de estado y difusión se ignoran (`@status`, `@broadcast`).
- Los chats directos usan reglas de sesión DM (`session.dmScope`; el valor predeterminado `main` colapsa los DMs en la sesión principal del agente).
- Las sesiones de grupo están aisladas (`agent:<agentId>:whatsapp:group:<jid>`).

## Control de acceso y activación

<Tabs>
  <Tab title="Política DM">
    `channels.whatsapp.dmPolicy` controla el acceso a chats directos:

    - `pairing` (predeterminado)
    - `allowlist`
    - `open` (requiere que `allowFrom` incluya `"*"`)
    - `disabled`

    `allowFrom` acepta números en formato E.164 (normalizados internamente).

    Anulación multi-cuenta: `channels.whatsapp.accounts.<id>.dmPolicy` (y `allowFrom`) tienen precedencia sobre los valores predeterminados a nivel de canal para esa cuenta.

    Detalles del comportamiento en tiempo de ejecución:

    - los emparejamientos se persisten en el almacén de permitidos del canal y se fusionan con `allowFrom` configurado
    - si no se configura lista de permitidos, el número propio vinculado se permite de forma predeterminada
    - los DMs salientes `fromMe` nunca se emparejan automáticamente

  </Tab>

  <Tab title="Política de grupo + listas de permitidos">
    El acceso a grupos tiene dos capas:

    1. **Lista de permitidos de membresía de grupo** (`channels.whatsapp.groups`)
       - si se omite `groups`, todos los grupos son elegibles
       - si `groups` está presente, actúa como una lista de permitidos de grupos (`"*"` permitido)

    2. **Política de remitente de grupo** (`channels.whatsapp.groupPolicy` + `groupAllowFrom`)
       - `open`: lista de permitidos de remitente omitida
       - `allowlist`: el remitente debe coincidir con `groupAllowFrom` (o `*`)
       - `disabled`: bloquear todas las entradas de grupo

    Alternativa de lista de permitidos de remitente:

    - si `groupAllowFrom` no está configurado, el tiempo de ejecución recurre a `allowFrom` cuando está disponible

    Nota: si no existe ningún bloque `channels.whatsapp`, la alternativa de política de grupo en tiempo de ejecución es efectivamente `open`.

  </Tab>

  <Tab title="Menciones + /activation">
    Las respuestas de grupo requieren mención de forma predeterminada.

    La detección de menciones incluye:

    - menciones explícitas de WhatsApp de la identidad del bot
    - patrones regex de mención configurados (`agents.list[].groupChat.mentionPatterns`, alternativa `messages.groupChat.mentionPatterns`)
    - detección implícita de respuesta al bot (el remitente de la respuesta coincide con la identidad del bot)

    Comando de activación a nivel de sesión:

    - `/activation mention`
    - `/activation always`

    `activation` actualiza el estado de la sesión (no la configuración global). Está protegido por propietario.

  </Tab>
</Tabs>

## Comportamiento de número personal y chat consigo mismo

Cuando el número propio vinculado también está presente en `allowFrom`, se activan las salvaguardas de chat consigo mismo de WhatsApp:

- omitir recibos de lectura para turnos de chat consigo mismo
- ignorar comportamiento de activación automática de mention-JID que de otro modo te haría ping a ti mismo
- si `messages.responsePrefix` no está configurado, las respuestas de chat consigo mismo tienen como valor predeterminado `[{identity.name}]` o `[openclaw]`

## Normalización y contexto de mensajes

<AccordionGroup>
  <Accordion title="Sobre de entrada + contexto de respuesta">
    Los mensajes entrantes de WhatsApp se envuelven en el sobre de entrada compartido.

    Si existe una respuesta citada, el contexto se agrega en esta forma:

    ```text
    [Replying to <sender> id:<stanzaId>]
    <quoted body or media placeholder>
    [/Replying]
    ```

    Los campos de metadatos de respuesta también se rellenan cuando están disponibles (`ReplyToId`, `ReplyToBody`, `ReplyToSender`, JID del remitente/E.164).

  </Accordion>

  <Accordion title="Marcadores de medios y extracción de ubicación/contacto">
    Los mensajes entrantes solo de medios se normalizan con marcadores como:

    - `<media:image>`
    - `<media:video>`
    - `<media:audio>`
    - `<media:document>`
    - `<media:sticker>`

    Las cargas útiles de ubicación y contacto se normalizan en contexto textual antes del enrutamiento.

  </Accordion>

  <Accordion title="Inyección de historial de grupo pendiente">
    Para grupos, los mensajes no procesados se pueden almacenar en búfer e inyectar como contexto cuando el bot finalmente se activa.

    - límite predeterminado: `50`
    - configuración: `channels.whatsapp.historyLimit`
    - alternativa: `messages.groupChat.historyLimit`
    - `0` deshabilita

    Marcadores de inyección:

    - `[Chat messages since your last reply - for context]`
    - `[Current message - respond to this]`

  </Accordion>

  <Accordion title="Recibos de lectura">
    Los recibos de lectura están habilitados de forma predeterminada para mensajes entrantes de WhatsApp aceptados.

    Deshabilitar globalmente:

    ```json5
    {
      channels: {
        whatsapp: {
          sendReadReceipts: false,
        },
      },
    }
    ```

    Anulación por cuenta:

    ```json5
    {
      channels: {
        whatsapp: {
          accounts: {
            work: {
              sendReadReceipts: false,
            },
          },
        },
      },
    }
    ```

    Los turnos de chat consigo mismo omiten los recibos de lectura incluso cuando están habilitados globalmente.

  </Accordion>
</AccordionGroup>

## Entrega, fragmentación y medios

<AccordionGroup>
  <Accordion title="Fragmentación de texto">
    - límite de fragmento predeterminado: `channels.whatsapp.textChunkLimit = 4000`
    - `channels.whatsapp.chunkMode = "length" | "newline"`
    - el modo `newline` prefiere límites de párrafo (líneas en blanco), luego recurre a fragmentación segura por longitud
  </Accordion>

  <Accordion title="Comportamiento de medios salientes">
    - admite cargas útiles de imagen, video, audio (nota de voz PTT) y documento
    - `audio/ogg` se reescribe como `audio/ogg; codecs=opus` para compatibilidad con notas de voz
    - la reproducción de GIF animado es compatible a través de `gifPlayback: true` en envíos de video
    - los subtítulos se aplican al primer elemento multimedia al enviar cargas útiles de respuesta multi-media
    - la fuente multimedia puede ser HTTP(S), `file://` o rutas locales
  </Accordion>

  <Accordion title="Límites de tamaño de medios y comportamiento alternativo">
    - límite de guardado de medios entrantes: `channels.whatsapp.mediaMaxMb` (predeterminado `50`)
    - límite de medios salientes para respuestas automáticas: `agents.defaults.mediaMaxMb` (predeterminado `5MB`)
    - las imágenes se optimizan automáticamente (cambio de tamaño/barrido de calidad) para ajustarse a los límites
    - en caso de fallo de envío de medios, la alternativa del primer elemento envía advertencia de texto en lugar de eliminar la respuesta silenciosamente
  </Accordion>
</AccordionGroup>

## Reacciones de confirmación

WhatsApp admite reacciones de confirmación inmediatas al recibo de entrada a través de `channels.whatsapp.ackReaction`.

```json5
{
  channels: {
    whatsapp: {
      ackReaction: {
        emoji: "👀",
        direct: true,
        group: "mentions", // always | mentions | never
      },
    },
  },
}
```

Notas de comportamiento:

- enviado inmediatamente después de que se acepta la entrada (pre-respuesta)
- los fallos se registran pero no bloquean la entrega normal de respuestas
- el modo de grupo `mentions` reacciona en turnos activados por mención; la activación de grupo `always` actúa como omisión para esta verificación
- WhatsApp usa `channels.whatsapp.ackReaction` (`messages.ackReaction` heredado no se usa aquí)

## Multi-cuenta y credenciales

<AccordionGroup>
  <Accordion title="Selección de cuenta y valores predeterminados">
    - los IDs de cuenta provienen de `channels.whatsapp.accounts`
    - selección de cuenta predeterminada: `default` si está presente, de lo contrario primer ID de cuenta configurado (ordenado)
    - los IDs de cuenta se normalizan internamente para búsqueda
  </Accordion>

  <Accordion title="Rutas de credenciales y compatibilidad heredada">
    - ruta de autenticación actual: `~/.openclaw/credentials/whatsapp/<accountId>/creds.json`
    - archivo de respaldo: `creds.json.bak`
    - la autenticación predeterminada heredada en `~/.openclaw/credentials/` todavía se reconoce/migra para flujos de cuenta predeterminada
  </Accordion>

  <Accordion title="Comportamiento de cierre de sesión">
    `openclaw channels logout --channel whatsapp [--account <id>]` borra el estado de autenticación de WhatsApp para esa cuenta.

    En directorios de autenticación heredados, `oauth.json` se conserva mientras que los archivos de autenticación de Baileys se eliminan.

  </Accordion>
</AccordionGroup>

## Herramientas, acciones y escrituras de configuración

- El soporte de herramientas del agente incluye acción de reacción de WhatsApp (`react`).
- Puertas de acción:
  - `channels.whatsapp.actions.reactions`
  - `channels.whatsapp.actions.polls`
- Las escrituras de configuración iniciadas por el canal están habilitadas de forma predeterminada (deshabilitar a través de `channels.whatsapp.configWrites=false`).

## Solución de problemas

<AccordionGroup>
  <Accordion title="No vinculado (QR requerido)">
    Síntoma: el estado del canal informa que no está vinculado.

    Solución:

    ```bash
    openclaw channels login --channel whatsapp
    openclaw channels status
    ```

  </Accordion>

  <Accordion title="Vinculado pero desconectado / bucle de reconexión">
    Síntoma: cuenta vinculada con desconexiones repetidas o intentos de reconexión.

    Solución:

    ```bash
    openclaw doctor
    openclaw logs --follow
    ```

    Si es necesario, vuelve a vincular con `channels login`.

  </Accordion>

  <Accordion title="Sin listener activo al enviar">
    Los envíos salientes fallan rápidamente cuando no existe un listener de gateway activo para la cuenta de destino.

    Asegúrate de que el gateway esté en ejecución y la cuenta esté vinculada.

  </Accordion>

  <Accordion title="Mensajes de grupo ignorados inesperadamente">
    Verifica en este orden:

    - `groupPolicy`
    - `groupAllowFrom` / `allowFrom`
    - entradas de lista de permitidos de `groups`
    - bloqueo de menciones (`requireMention` + patrones de mención)

  </Accordion>

  <Accordion title="Advertencia de tiempo de ejecución de Bun">
    El tiempo de ejecución del gateway de WhatsApp debe usar Node. Bun está marcado como incompatible para operaciones estables del gateway de WhatsApp/Telegram.
  </Accordion>
</AccordionGroup>

## Punteros de referencia de configuración

Referencia principal:

- [Referencia de configuración - WhatsApp](/es-ES/gateway/configuration-reference#whatsapp)

Campos de WhatsApp de alta señal:

- acceso: `dmPolicy`, `allowFrom`, `groupPolicy`, `groupAllowFrom`, `groups`
- entrega: `textChunkLimit`, `chunkMode`, `mediaMaxMb`, `sendReadReceipts`, `ackReaction`
- multi-cuenta: `accounts.<id>.enabled`, `accounts.<id>.authDir`, anulaciones a nivel de cuenta
- operaciones: `configWrites`, `debounceMs`, `web.enabled`, `web.heartbeatSeconds`, `web.reconnect.*`
- comportamiento de sesión: `session.dmScope`, `historyLimit`, `dmHistoryLimit`, `dms.<id>.historyLimit`

## Relacionado

- [Emparejamiento](/es-ES/channels/pairing)
- [Enrutamiento de canales](/es-ES/channels/channel-routing)
- [Solución de problemas](/es-ES/channels/troubleshooting)
