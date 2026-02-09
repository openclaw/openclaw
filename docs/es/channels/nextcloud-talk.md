---
summary: "Estado de soporte, capacidades y configuración de Nextcloud Talk"
read_when:
  - Trabajando en funciones del canal Nextcloud Talk
title: "Nextcloud Talk"
---

# Nextcloud Talk (plugin)

Estado: compatible mediante plugin (bot de webhook). Se admiten mensajes directos, salas, reacciones y mensajes en Markdown.

## Plugin requerido

Nextcloud Talk se distribuye como un plugin y no viene incluido con la instalación principal.

Instale mediante CLI (registro npm):

```bash
openclaw plugins install @openclaw/nextcloud-talk
```

Clonado local (cuando se ejecuta desde un repositorio git):

```bash
openclaw plugins install ./extensions/nextcloud-talk
```

Si elige Nextcloud Talk durante la configuración/incorporación y se detecta un clonado git,
OpenClaw ofrecerá automáticamente la ruta de instalación local.

Detalles: [Plugins](/tools/plugin)

## Configuración rápida (principiante)

1. Instale el plugin de Nextcloud Talk.

2. En su servidor Nextcloud, cree un bot:

   ```bash
   ./occ talk:bot:install "OpenClaw" "<shared-secret>" "<webhook-url>" --feature reaction
   ```

3. Habilite el bot en la configuración de la sala de destino.

4. Configure OpenClaw:
   - Configuración: `channels.nextcloud-talk.baseUrl` + `channels.nextcloud-talk.botSecret`
   - O variables de entorno: `NEXTCLOUD_TALK_BOT_SECRET` (solo cuenta predeterminada)

5. Reinicie el Gateway (o finalice la incorporación).

Configuración mínima:

```json5
{
  channels: {
    "nextcloud-talk": {
      enabled: true,
      baseUrl: "https://cloud.example.com",
      botSecret: "shared-secret",
      dmPolicy: "pairing",
    },
  },
}
```

## Notas

- Los bots no pueden iniciar mensajes directos. El usuario debe escribir primero al bot.
- La URL del webhook debe ser accesible por el Gateway; configure `webhookPublicUrl` si está detrás de un proxy.
- Las cargas de medios no son compatibles con la API del bot; los medios se envían como URLs.
- La carga útil del webhook no distingue entre mensajes directos y salas; configure `apiUser` + `apiPassword` para habilitar búsquedas por tipo de sala (de lo contrario, los mensajes directos se tratan como salas).

## Control de acceso (mensajes directos)

- Predeterminado: `channels.nextcloud-talk.dmPolicy = "pairing"`. Los remitentes desconocidos reciben un código de emparejamiento.
- Aprobar mediante:
  - `openclaw pairing list nextcloud-talk`
  - `openclaw pairing approve nextcloud-talk <CODE>`
- Mensajes directos públicos: `channels.nextcloud-talk.dmPolicy="open"` más `channels.nextcloud-talk.allowFrom=["*"]`.
- `allowFrom` coincide solo con IDs de usuario de Nextcloud; los nombres visibles se ignoran.

## Salas (grupos)

- Predeterminado: `channels.nextcloud-talk.groupPolicy = "allowlist"` (controlado por menciones).
- Permita salas mediante lista de permitidos con `channels.nextcloud-talk.rooms`:

```json5
{
  channels: {
    "nextcloud-talk": {
      rooms: {
        "room-token": { requireMention: true },
      },
    },
  },
}
```

- Para no permitir ninguna sala, mantenga la lista de permitidos vacía o configure `channels.nextcloud-talk.groupPolicy="disabled"`.

## Capacidades

| Función           | Estado        |
| ----------------- | ------------- |
| Mensajes directos | Compatible    |
| Salas             | Compatible    |
| Hilos             | No compatible |
| Medios            | Solo URL      |
| Reacciones        | Compatible    |
| Comandos nativos  | No compatible |

## Referencia de configuración (Nextcloud Talk)

Configuración completa: [Configuration](/gateway/configuration)

Opciones del proveedor:

- `channels.nextcloud-talk.enabled`: habilitar/deshabilitar el inicio del canal.
- `channels.nextcloud-talk.baseUrl`: URL de la instancia de Nextcloud.
- `channels.nextcloud-talk.botSecret`: secreto compartido del bot.
- `channels.nextcloud-talk.botSecretFile`: ruta del archivo del secreto.
- `channels.nextcloud-talk.apiUser`: usuario de la API para búsquedas de salas (detección de mensajes directos).
- `channels.nextcloud-talk.apiPassword`: contraseña de API/aplicación para búsquedas de salas.
- `channels.nextcloud-talk.apiPasswordFile`: ruta del archivo de la contraseña de la API.
- `channels.nextcloud-talk.webhookPort`: puerto del listener de webhook (predeterminado: 8788).
- `channels.nextcloud-talk.webhookHost`: host del webhook (predeterminado: 0.0.0.0).
- `channels.nextcloud-talk.webhookPath`: ruta del webhook (predeterminada: /nextcloud-talk-webhook).
- `channels.nextcloud-talk.webhookPublicUrl`: URL del webhook accesible externamente.
- `channels.nextcloud-talk.dmPolicy`: `pairing | allowlist | open | disabled`.
- `channels.nextcloud-talk.allowFrom`: lista de permitidos de mensajes directos (IDs de usuario). `open` requiere `"*"`.
- `channels.nextcloud-talk.groupPolicy`: `allowlist | open | disabled`.
- `channels.nextcloud-talk.groupAllowFrom`: lista de permitidos de grupos (IDs de usuario).
- `channels.nextcloud-talk.rooms`: configuración por sala y lista de permitidos.
- `channels.nextcloud-talk.historyLimit`: límite de historial de grupos (0 deshabilita).
- `channels.nextcloud-talk.dmHistoryLimit`: límite de historial de mensajes directos (0 deshabilita).
- `channels.nextcloud-talk.dms`: anulaciones por mensaje directo (historyLimit).
- `channels.nextcloud-talk.textChunkLimit`: tamaño de fragmento de texto de salida (caracteres).
- `channels.nextcloud-talk.chunkMode`: `length` (predeterminado) o `newline` para dividir en líneas en blanco (límites de párrafo) antes de fragmentar por longitud.
- `channels.nextcloud-talk.blockStreaming`: deshabilitar block streaming para este canal.
- `channels.nextcloud-talk.blockStreamingCoalesce`: ajuste de coalescencia de block streaming.
- `channels.nextcloud-talk.mediaMaxMb`: límite de medios entrantes (MB).
