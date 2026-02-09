---
summary: "Configuración, ajustes y uso del plugin de la API de mensajería de LINE"
read_when:
  - Quiere conectar OpenClaw con LINE
  - Necesita configurar el webhook y las credenciales de LINE
  - Quiere opciones de mensajes específicas de LINE
title: LINE
---

# LINE (plugin)

LINE se conecta a OpenClaw mediante la API de mensajería de LINE. El plugin se ejecuta como un receptor de webhooks
en el Gateway y utiliza su token de acceso del canal + el secreto del canal para la
autenticación.

Estado: compatible mediante plugin. Se admiten mensajes directos, chats grupales, medios, ubicaciones, mensajes Flex,
mensajes de plantilla y respuestas rápidas. No se admiten reacciones ni hilos.

## Plugin requerido

Instale el plugin de LINE:

```bash
openclaw plugins install @openclaw/line
```

Checkout local (cuando se ejecuta desde un repositorio git):

```bash
openclaw plugins install ./extensions/line
```

## Configuración

1. Cree una cuenta de LINE Developers y abra la Consola:
   [https://developers.line.biz/console/](https://developers.line.biz/console/)
2. Cree (o seleccione) un Proveedor y agregue un canal de **Messaging API**.
3. Copie el **Channel access token** y el **Channel secret** desde la configuración del canal.
4. Habilite **Use webhook** en la configuración de Messaging API.
5. Configure la URL del webhook a su endpoint del Gateway (se requiere HTTPS):

```
https://gateway-host/line/webhook
```

El Gateway responde a la verificación del webhook de LINE (GET) y a los eventos entrantes (POST).
Si necesita una ruta personalizada, configure `channels.line.webhookPath` o
`channels.line.accounts.<id>.webhookPath` y actualice la URL en consecuencia.

## Configurar

Configuración mínima:

```json5
{
  channels: {
    line: {
      enabled: true,
      channelAccessToken: "LINE_CHANNEL_ACCESS_TOKEN",
      channelSecret: "LINE_CHANNEL_SECRET",
      dmPolicy: "pairing",
    },
  },
}
```

Env vars (sólo cuenta por defecto):

- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_CHANNEL_SECRET`

Archivos de token/secreto:

```json5
{
  channels: {
    line: {
      tokenFile: "/path/to/line-token.txt",
      secretFile: "/path/to/line-secret.txt",
    },
  },
}
```

Múltiples cuentas:

```json5
{
  channels: {
    line: {
      accounts: {
        marketing: {
          channelAccessToken: "...",
          channelSecret: "...",
          webhookPath: "/line/marketing",
        },
      },
    },
  },
}
```

## Control de acceso

Los mensajes directos se emparejan de forma predeterminada. Los remitentes desconocidos reciben un código de emparejamiento y sus
mensajes se ignoran hasta que se aprueben.

```bash
openclaw pairing list line
openclaw pairing approve line <CODE>
```

Listas de permitidos y políticas:

- `channels.line.dmPolicy`: `pairing | allowlist | open | disabled`
- `channels.line.allowFrom`: IDs de usuario de LINE permitidos para mensajes directos
- `channels.line.groupPolicy`: `allowlist | open | disabled`
- `channels.line.groupAllowFrom`: IDs de usuario de LINE permitidos para grupos
- Anulaciones por grupo: `channels.line.groups.<groupId>.allowFrom`

Los IDs de LINE distinguen entre mayúsculas y minúsculas. Los IDs válidos se ven así:

- Usuario: `U` + 32 caracteres hexadecimales
- Grupo: `C` + 32 caracteres hexadecimales
- Sala: `R` + 32 caracteres hexadecimales

## Comportamiento de mensajes

- El texto se divide en fragmentos de 5000 caracteres.
- El formato Markdown se elimina; los bloques de código y las tablas se convierten en tarjetas Flex cuando es posible.
- Las respuestas en streaming se almacenan en búfer; LINE recibe fragmentos completos con una animación de carga mientras el agente trabaja.
- Las descargas de medios están limitadas por `channels.line.mediaMaxMb` (valor predeterminado 10).

## Datos del canal (mensajes enriquecidos)

Use `channelData.line` para enviar respuestas rápidas, ubicaciones, tarjetas Flex o mensajes de plantilla.

```json5
{
  text: "Here you go",
  channelData: {
    line: {
      quickReplies: ["Status", "Help"],
      location: {
        title: "Office",
        address: "123 Main St",
        latitude: 35.681236,
        longitude: 139.767125,
      },
      flexMessage: {
        altText: "Status card",
        contents: {
          /* Flex payload */
        },
      },
      templateMessage: {
        type: "confirm",
        text: "Proceed?",
        confirmLabel: "Yes",
        confirmData: "yes",
        cancelLabel: "No",
        cancelData: "no",
      },
    },
  },
}
```

El plugin de LINE también incluye un comando `/card` para preajustes de mensajes Flex:

```
/card info "Welcome" "Thanks for joining!"
```

## Solución de problemas

- **Falla la verificación del webhook:** asegúrese de que la URL del webhook sea HTTPS y que
  `channelSecret` coincida con la consola de LINE.
- **No hay eventos entrantes:** confirme que la ruta del webhook coincida con `channels.line.webhookPath`
  y que el Gateway sea accesible desde LINE.
- **Errores de descarga de medios:** aumente `channels.line.mediaMaxMb` si los medios superan el
  límite predeterminado.
