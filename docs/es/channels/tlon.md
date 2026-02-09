---
summary: "Estado de compatibilidad de Tlon/Urbit, capacidades y configuración"
read_when:
  - Al trabajar en funciones del canal Tlon/Urbit
title: "Tlon"
---

# Tlon (plugin)

Tlon es un mensajero descentralizado construido sobre Urbit. OpenClaw se conecta a su nave de Urbit y puede
responder a mensajes directos y mensajes de chat grupales. Las respuestas en grupos requieren una mención con @ de forma predeterminada y pueden
restringirse aún más mediante listas de permitidos.

Estado: compatible mediante plugin. Mensajes directos, menciones en grupos, respuestas en hilos y respaldo de medios solo de texto
(URL añadida al pie). No se admiten reacciones, encuestas ni cargas de medios nativos.

## Plugin requerido

Tlon se distribuye como un plugin y no viene incluido con la instalación principal.

Instale mediante la CLI (registro npm):

```bash
openclaw plugins install @openclaw/tlon
```

Checkout local (al ejecutar desde un repositorio git):

```bash
openclaw plugins install ./extensions/tlon
```

Detalles: [Plugins](/tools/plugin)

## Configuración

1. Instale el plugin de Tlon.
2. Reúna la URL de su nave y el código de inicio de sesión.
3. Configure `channels.tlon`.
4. Reinicie el Gateway.
5. Envíe un mensaje directo al bot o menciónelo en un canal grupal.

Configuración mínima (una sola cuenta):

```json5
{
  channels: {
    tlon: {
      enabled: true,
      ship: "~sampel-palnet",
      url: "https://your-ship-host",
      code: "lidlut-tabwed-pillex-ridrup",
    },
  },
}
```

## Canales de grupo

El descubrimiento automático está habilitado de forma predeterminada. También puede fijar canales manualmente:

```json5
{
  channels: {
    tlon: {
      groupChannels: ["chat/~host-ship/general", "chat/~host-ship/support"],
    },
  },
}
```

Deshabilitar el descubrimiento automático:

```json5
{
  channels: {
    tlon: {
      autoDiscoverChannels: false,
    },
  },
}
```

## Control de acceso

Lista de permitidos de mensajes directos (vacía = permitir todos):

```json5
{
  channels: {
    tlon: {
      dmAllowlist: ["~zod", "~nec"],
    },
  },
}
```

Autorización de grupos (restringida de forma predeterminada):

```json5
{
  channels: {
    tlon: {
      defaultAuthorizedShips: ["~zod"],
      authorization: {
        channelRules: {
          "chat/~host-ship/general": {
            mode: "restricted",
            allowedShips: ["~zod", "~nec"],
          },
          "chat/~host-ship/announcements": {
            mode: "open",
          },
        },
      },
    },
  },
}
```

## Destinos de entrega (CLI/cron)

Use estos con `openclaw message send` o con entrega por cron:

- Mensaje directo: `~sampel-palnet` o `dm/~sampel-palnet`
- Grupo: `chat/~host-ship/channel` o `group:~host-ship/channel`

## Notas

- Las respuestas en grupos requieren una mención (p. ej., `~your-bot-ship`) para responder.
- Respuestas en hilos: si el mensaje entrante está en un hilo, OpenClaw responde dentro del hilo.
- Medios: `sendMedia` usa un respaldo a texto + URL (sin carga nativa).
