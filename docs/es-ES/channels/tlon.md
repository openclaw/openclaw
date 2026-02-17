---
summary: "Estado de soporte, capacidades y configuración de Tlon/Urbit"
read_when:
  - Trabajando en características del canal Tlon/Urbit
title: "Tlon"
---

# Tlon (plugin)

Tlon es un mensajero descentralizado construido sobre Urbit. OpenClaw se conecta a tu ship de Urbit y puede responder a mensajes directos y mensajes de chat grupal. Las respuestas de grupo requieren una mención @ por defecto y pueden restringirse aún más mediante listas de permitidos.

Estado: compatible mediante plugin. Mensajes directos, menciones de grupo, respuestas de hilos y respaldo de medios de solo texto (URL añadida al caption). Las reacciones, encuestas y cargas de medios nativas no son compatibles.

## Plugin requerido

Tlon se distribuye como plugin y no viene incluido con la instalación principal.

Instalar mediante CLI (registro npm):

```bash
openclaw plugins install @openclaw/tlon
```

Instalación local (cuando se ejecuta desde un repositorio git):

```bash
openclaw plugins install ./extensions/tlon
```

Detalles: [Plugins](/es-ES/tools/plugin)

## Configuración

1. Instala el plugin de Tlon.
2. Recopila la URL de tu ship y el código de inicio de sesión.
3. Configura `channels.tlon`.
4. Reinicia el gateway.
5. Envía un mensaje directo al bot o menciónalo en un canal grupal.

Configuración mínima (cuenta única):

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

URLs de ship privadas/LAN (avanzado):

Por defecto, OpenClaw bloquea nombres de host privados/internos y rangos de IP para este plugin (endurecimiento SSRF).
Si la URL de tu ship está en una red privada (por ejemplo `http://192.168.1.50:8080` o `http://localhost:8080`),
debes optar explícitamente:

```json5
{
  channels: {
    tlon: {
      allowPrivateNetwork: true,
    },
  },
}
```

## Canales de grupo

El auto-descubrimiento está habilitado por defecto. También puedes fijar canales manualmente:

```json5
{
  channels: {
    tlon: {
      groupChannels: ["chat/~host-ship/general", "chat/~host-ship/support"],
    },
  },
}
```

Deshabilitar auto-descubrimiento:

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

Autorización de grupo (restringida por defecto):

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

## Objetivos de entrega (CLI/cron)

Úsalos con `openclaw message send` o entrega cron:

- DM: `~sampel-palnet` o `dm/~sampel-palnet`
- Grupo: `chat/~host-ship/channel` o `group:~host-ship/channel`

## Notas

- Las respuestas de grupo requieren una mención (por ejemplo `~your-bot-ship`) para responder.
- Respuestas de hilos: si el mensaje entrante está en un hilo, OpenClaw responde dentro del hilo.
- Medios: `sendMedia` recurre a texto + URL (sin carga nativa).
