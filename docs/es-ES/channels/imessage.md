---
summary: "Soporte heredado para iMessage mediante imsg (JSON-RPC sobre stdio). Las nuevas instalaciones deberían usar BlueBubbles."
read_when:
  - Configurando soporte para iMessage
  - Depurando envío/recepción en iMessage
title: "iMessage"
---

# iMessage (heredado: imsg)

<Warning>
Para nuevos despliegues de iMessage, usa <a href="/es-ES/channels/bluebubbles">BlueBubbles</a>.

La integración `imsg` es heredada y puede ser eliminada en una versión futura.
</Warning>

Estado: integración CLI externa heredada. El Gateway genera `imsg rpc` y se comunica mediante JSON-RPC sobre stdio (sin daemon/puerto separado).

<CardGroup cols={3}>
  <Card title="BlueBubbles (recomendado)" icon="message-circle" href="/es-ES/channels/bluebubbles">
    Ruta preferida para iMessage en nuevas instalaciones.
  </Card>
  <Card title="Emparejamiento" icon="link" href="/es-ES/channels/pairing">
    Los mensajes directos de iMessage usan modo de emparejamiento por defecto.
  </Card>
  <Card title="Referencia de configuración" icon="settings" href="/es-ES/gateway/configuration-reference#imessage">
    Referencia completa de campos de iMessage.
  </Card>
</CardGroup>

## Configuración rápida

<Tabs>
  <Tab title="Mac Local (ruta rápida)">
    <Steps>
      <Step title="Instalar y verificar imsg">

```bash
brew install steipete/tap/imsg
imsg rpc --help
```

      </Step>

      <Step title="Configurar OpenClaw">

```json5
{
  channels: {
    imessage: {
      enabled: true,
      cliPath: "/usr/local/bin/imsg",
      dbPath: "/Users/<tu-usuario>/Library/Messages/chat.db",
    },
  },
}
```

      </Step>

      <Step title="Iniciar gateway">

```bash
openclaw gateway
```

      </Step>

      <Step title="Aprobar primer emparejamiento por DM (dmPolicy por defecto)">

```bash
openclaw pairing list imessage
openclaw pairing approve imessage <CÓDIGO>
```

        Las solicitudes de emparejamiento expiran después de 1 hora.
      </Step>
    </Steps>

  </Tab>

  <Tab title="Mac Remoto mediante SSH">
    OpenClaw solo requiere un `cliPath` compatible con stdio, por lo que puedes configurar `cliPath` para apuntar a un script wrapper que se conecta por SSH a un Mac remoto y ejecuta `imsg`.

```bash
#!/usr/bin/env bash
exec ssh -T gateway-host imsg "$@"
```

    Configuración recomendada cuando los adjuntos están habilitados:

```json5
{
  channels: {
    imessage: {
      enabled: true,
      cliPath: "~/.openclaw/scripts/imsg-ssh",
      remoteHost: "user@gateway-host", // usado para obtener adjuntos mediante SCP
      includeAttachments: true,
    },
  },
}
```

    Si `remoteHost` no está configurado, OpenClaw intenta autodetectarlo analizando el script wrapper SSH.

  </Tab>
</Tabs>

## Requisitos y permisos (macOS)

- Messages debe tener sesión iniciada en el Mac que ejecuta `imsg`.
- Se requiere Acceso Completo al Disco para el contexto del proceso que ejecuta OpenClaw/`imsg` (acceso a la BD de Messages).
- Se requiere permiso de Automatización para enviar mensajes a través de Messages.app.

<Tip>
Los permisos se otorgan por contexto de proceso. Si el gateway se ejecuta sin interfaz gráfica (LaunchAgent/SSH), ejecuta un comando interactivo único en ese mismo contexto para activar las solicitudes de permisos:

```bash
imsg chats --limit 1
# o
imsg send <identificador> "test"
```

</Tip>

## Control de acceso y enrutamiento

<Tabs>
  <Tab title="Política de DM">
    `channels.imessage.dmPolicy` controla los mensajes directos:

    - `pairing` (por defecto)
    - `allowlist`
    - `open` (requiere que `allowFrom` incluya `"*"`)
    - `disabled`

    Campo de lista de permitidos: `channels.imessage.allowFrom`.

    Las entradas de la lista de permitidos pueden ser identificadores o destinos de chat (`chat_id:*`, `chat_guid:*`, `chat_identifier:*`).

  </Tab>

  <Tab title="Política de grupos + menciones">
    `channels.imessage.groupPolicy` controla el manejo de grupos:

    - `allowlist` (por defecto cuando está configurado)
    - `open`
    - `disabled`

    Lista de permitidos de remitentes de grupo: `channels.imessage.groupAllowFrom`.

    Respaldo en tiempo de ejecución: si `groupAllowFrom` no está configurado, las verificaciones de remitentes de grupo de iMessage vuelven a `allowFrom` cuando está disponible.

    Control de menciones para grupos:

    - iMessage no tiene metadatos de menciones nativos
    - la detección de menciones usa patrones regex (`agents.list[].groupChat.mentionPatterns`, respaldo `messages.groupChat.mentionPatterns`)
    - sin patrones configurados, el control de menciones no puede aplicarse

    Los comandos de control de remitentes autorizados pueden evitar el control de menciones en grupos.

  </Tab>

  <Tab title="Sesiones y respuestas determinísticas">
    - Los mensajes directos usan enrutamiento directo; los grupos usan enrutamiento de grupo.
    - Con el `session.dmScope=main` por defecto, los mensajes directos de iMessage se colapsan en la sesión principal del agente.
    - Las sesiones de grupo están aisladas (`agent:<agentId>:imessage:group:<chat_id>`).
    - Las respuestas se enrutan de vuelta a iMessage usando metadatos de canal/destino originales.

    Comportamiento tipo hilo de grupo:

    Algunos hilos de iMessage con múltiples participantes pueden llegar con `is_group=false`.
    Si ese `chat_id` está configurado explícitamente en `channels.imessage.groups`, OpenClaw lo trata como tráfico de grupo (control de grupo + aislamiento de sesión de grupo).

  </Tab>
</Tabs>

## Patrones de despliegue

<AccordionGroup>
  <Accordion title="Usuario macOS dedicado para bot (identidad iMessage separada)">
    Usa un Apple ID dedicado y un usuario macOS para que el tráfico del bot esté aislado de tu perfil personal de Messages.

    Flujo típico:

    1. Crear/iniciar sesión con un usuario macOS dedicado.
    2. Iniciar sesión en Messages con el Apple ID del bot en ese usuario.
    3. Instalar `imsg` en ese usuario.
    4. Crear wrapper SSH para que OpenClaw pueda ejecutar `imsg` en ese contexto de usuario.
    5. Configurar `channels.imessage.accounts.<id>.cliPath` y `.dbPath` para apuntar a ese perfil de usuario.

    La primera ejecución puede requerir aprobaciones en la GUI (Automatización + Acceso Completo al Disco) en esa sesión de usuario del bot.

  </Accordion>

  <Accordion title="Mac Remoto mediante Tailscale (ejemplo)">
    Topología común:

    - el gateway se ejecuta en Linux/VM
    - iMessage + `imsg` se ejecuta en un Mac en tu tailnet
    - el wrapper `cliPath` usa SSH para ejecutar `imsg`
    - `remoteHost` habilita la obtención de adjuntos mediante SCP

    Ejemplo:

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

```bash
#!/usr/bin/env bash
exec ssh -T bot@mac-mini.tailnet-1234.ts.net imsg "$@"
```

    Usa claves SSH para que tanto SSH como SCP sean no interactivos.

  </Accordion>

  <Accordion title="Patrón multi-cuenta">
    iMessage soporta configuración por cuenta bajo `channels.imessage.accounts`.

    Cada cuenta puede sobrescribir campos como `cliPath`, `dbPath`, `allowFrom`, `groupPolicy`, `mediaMaxMb` y configuraciones de historial.

  </Accordion>
</AccordionGroup>

## Medios, fragmentación y destinos de entrega

<AccordionGroup>
  <Accordion title="Adjuntos y medios">
    - la ingesta de adjuntos entrantes es opcional: `channels.imessage.includeAttachments`
    - las rutas de adjuntos remotos pueden obtenerse mediante SCP cuando `remoteHost` está configurado
    - el tamaño de medios salientes usa `channels.imessage.mediaMaxMb` (por defecto 16 MB)
  </Accordion>

  <Accordion title="Fragmentación saliente">
    - límite de fragmento de texto: `channels.imessage.textChunkLimit` (por defecto 4000)
    - modo de fragmentación: `channels.imessage.chunkMode`
      - `length` (por defecto)
      - `newline` (división priorizada por párrafo)
  </Accordion>

  <Accordion title="Formatos de direccionamiento">
    Destinos explícitos preferidos:

    - `chat_id:123` (recomendado para enrutamiento estable)
    - `chat_guid:...`
    - `chat_identifier:...`

    Los destinos por identificador también son soportados:

    - `imessage:+1555...`
    - `sms:+1555...`
    - `user@example.com`

```bash
imsg chats --limit 20
```

  </Accordion>
</AccordionGroup>

## Escrituras de configuración

iMessage permite escrituras de configuración iniciadas por el canal por defecto (para `/config set|unset` cuando `commands.config: true`).

Deshabilitar:

```json5
{
  channels: {
    imessage: {
      configWrites: false,
    },
  },
}
```

## Solución de problemas

<AccordionGroup>
  <Accordion title="imsg no encontrado o RPC no soportado">
    Valida el binario y el soporte RPC:

```bash
imsg rpc --help
openclaw channels status --probe
```

    Si probe reporta RPC no soportado, actualiza `imsg`.

  </Accordion>

  <Accordion title="Los DMs son ignorados">
    Verifica:

    - `channels.imessage.dmPolicy`
    - `channels.imessage.allowFrom`
    - aprobaciones de emparejamiento (`openclaw pairing list imessage`)

  </Accordion>

  <Accordion title="Los mensajes de grupo son ignorados">
    Verifica:

    - `channels.imessage.groupPolicy`
    - `channels.imessage.groupAllowFrom`
    - comportamiento de lista de permitidos de `channels.imessage.groups`
    - configuración de patrones de menciones (`agents.list[].groupChat.mentionPatterns`)

  </Accordion>

  <Accordion title="Los adjuntos remotos fallan">
    Verifica:

    - `channels.imessage.remoteHost`
    - autenticación de clave SSH/SCP desde el host del gateway
    - legibilidad de rutas remotas en el Mac que ejecuta Messages

  </Accordion>

  <Accordion title="Se perdieron solicitudes de permisos de macOS">
    Vuelve a ejecutar en un terminal GUI interactivo en el mismo contexto de usuario/sesión y aprueba las solicitudes:

```bash
imsg chats --limit 1
imsg send <identificador> "test"
```

    Confirma que Acceso Completo al Disco + Automatización están otorgados para el contexto del proceso que ejecuta OpenClaw/`imsg`.

  </Accordion>
</AccordionGroup>

## Referencias de configuración

- [Referencia de configuración - iMessage](/es-ES/gateway/configuration-reference#imessage)
- [Configuración del Gateway](/es-ES/gateway/configuration)
- [Emparejamiento](/es-ES/channels/pairing)
- [BlueBubbles](/es-ES/channels/bluebubbles)
