---
summary: "Configuración, instalación y uso del plugin de la API de mensajería de LINE"
read_when:
  - Quieres conectar OpenClaw a LINE
  - Necesitas configurar el webhook y credenciales de LINE
  - Quieres opciones de mensajes específicas de LINE
title: LINE
---

# LINE (plugin)

LINE se conecta a OpenClaw a través de la API de mensajería de LINE. El plugin funciona como un receptor de webhook en el gateway y utiliza tu token de acceso del canal + secreto del canal para la autenticación.

Estado: compatible mediante plugin. Los mensajes directos, chats grupales, medios, ubicaciones, mensajes Flex, mensajes de plantilla y respuestas rápidas son compatibles. Las reacciones y los hilos no son compatibles.

## Plugin requerido

Instala el plugin de LINE:

```bash
openclaw plugins install @openclaw/line
```

Instalación local (cuando se ejecuta desde un repositorio git):

```bash
openclaw plugins install ./extensions/line
```

## Configuración

1. Crea una cuenta de LINE Developers y abre la Consola:
   [https://developers.line.biz/console/](https://developers.line.biz/console/)
2. Crea (o selecciona) un Provider y añade un canal de **API de mensajería**.
3. Copia el **Token de acceso del canal** y el **Secreto del canal** desde la configuración del canal.
4. Habilita **Usar webhook** en la configuración de la API de mensajería.
5. Establece la URL del webhook a tu endpoint del gateway (HTTPS requerido):

```
https://gateway-host/line/webhook
```

El gateway responde a la verificación del webhook de LINE (GET) y a los eventos entrantes (POST).
Si necesitas una ruta personalizada, establece `channels.line.webhookPath` o
`channels.line.accounts.<id>.webhookPath` y actualiza la URL en consecuencia.

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

Variables de entorno (solo cuenta predeterminada):

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

Los mensajes directos utilizan emparejamiento por defecto. Los remitentes desconocidos reciben un código de emparejamiento y sus mensajes son ignorados hasta ser aprobados.

```bash
openclaw pairing list line
openclaw pairing approve line <CODE>
```

Listas de permitidos y políticas:

- `channels.line.dmPolicy`: `pairing | allowlist | open | disabled`
- `channels.line.allowFrom`: IDs de usuarios de LINE permitidos para mensajes directos
- `channels.line.groupPolicy`: `allowlist | open | disabled`
- `channels.line.groupAllowFrom`: IDs de usuarios de LINE permitidos para grupos
- Anulaciones por grupo: `channels.line.groups.<groupId>.allowFrom`

Los IDs de LINE distinguen mayúsculas de minúsculas. Los IDs válidos se ven así:

- Usuario: `U` + 32 caracteres hexadecimales
- Grupo: `C` + 32 caracteres hexadecimales
- Sala: `R` + 32 caracteres hexadecimales

## Comportamiento de los mensajes

- El texto se divide en fragmentos de 5000 caracteres.
- El formato Markdown se elimina; los bloques de código y las tablas se convierten en tarjetas Flex cuando es posible.
- Las respuestas en streaming se almacenan en búfer; LINE recibe fragmentos completos con una animación de carga mientras el agente trabaja.
- Las descargas de medios están limitadas por `channels.line.mediaMaxMb` (predeterminado 10).

## Datos del canal (mensajes enriquecidos)

Usa `channelData.line` para enviar respuestas rápidas, ubicaciones, tarjetas Flex o mensajes de plantilla.

```json5
{
  text: "Aquí tienes",
  channelData: {
    line: {
      quickReplies: ["Estado", "Ayuda"],
      location: {
        title: "Oficina",
        address: "123 Main St",
        latitude: 35.681236,
        longitude: 139.767125,
      },
      flexMessage: {
        altText: "Tarjeta de estado",
        contents: {
          /* Carga útil Flex */
        },
      },
      templateMessage: {
        type: "confirm",
        text: "¿Continuar?",
        confirmLabel: "Sí",
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
/card info "Bienvenido" "¡Gracias por unirte!"
```

## Solución de problemas

- **La verificación del webhook falla:** asegúrate de que la URL del webhook sea HTTPS y que el `channelSecret` coincida con la consola de LINE.
- **No hay eventos entrantes:** confirma que la ruta del webhook coincida con `channels.line.webhookPath` y que el gateway sea accesible desde LINE.
- **Errores de descarga de medios:** aumenta `channels.line.mediaMaxMb` si los medios superan el límite predeterminado.
