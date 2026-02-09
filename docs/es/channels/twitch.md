---
summary: "Configuración y puesta en marcha del bot de chat de Twitch"
read_when:
  - Configurar la integración de chat de Twitch para OpenClaw
title: "Twitch"
---

# Twitch (plugin)

Soporte de chat de Twitch mediante conexión IRC. OpenClaw se conecta como un usuario de Twitch (cuenta de bot) para recibir y enviar mensajes en canales.

## Plugin requerido

Twitch se distribuye como un plugin y no viene incluido con la instalación principal.

Instale mediante CLI (registro npm):

```bash
openclaw plugins install @openclaw/twitch
```

Clonado local (al ejecutar desde un repositorio git):

```bash
openclaw plugins install ./extensions/twitch
```

Detalles: [Plugins](/tools/plugin)

## Configuración rápida (principiante)

1. Cree una cuenta dedicada de Twitch para el bot (o use una cuenta existente).
2. Genere credenciales: [Twitch Token Generator](https://twitchtokengenerator.com/)
   - Seleccione **Bot Token**
   - Verifique que los alcances `chat:read` y `chat:write` estén seleccionados
   - Copie el **Client ID** y el **Access Token**
3. Encuentre su ID de usuario de Twitch: [https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/](https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/)
4. Configure el token:
   - Env: `OPENCLAW_TWITCH_ACCESS_TOKEN=...` (solo cuenta predeterminada)
   - O config: `channels.twitch.accessToken`
   - Si ambos están configurados, la configuración tiene prioridad (el fallback por env es solo para la cuenta predeterminada).
5. Inicie el gateway.

**⚠️ Importante:** Agregue control de acceso (`allowFrom` o `allowedRoles`) para evitar que usuarios no autorizados activen el bot. `requireMention` tiene como valor predeterminado `true`.

Configuración mínima:

```json5
{
  channels: {
    twitch: {
      enabled: true,
      username: "openclaw", // Bot's Twitch account
      accessToken: "oauth:abc123...", // OAuth Access Token (or use OPENCLAW_TWITCH_ACCESS_TOKEN env var)
      clientId: "xyz789...", // Client ID from Token Generator
      channel: "vevisk", // Which Twitch channel's chat to join (required)
      allowFrom: ["123456789"], // (recommended) Your Twitch user ID only - get it from https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/
    },
  },
}
```

## Qué es

- Un canal de Twitch propiedad del Gateway.
- Enrutamiento determinista: las respuestas siempre regresan a Twitch.
- Cada cuenta se asigna a una clave de sesión aislada `agent:<agentId>:twitch:<accountName>`.
- `username` es la cuenta del bot (quien autentica), `channel` es la sala de chat a la que se une.

## Configuración (detallada)

### Generar credenciales

Use [Twitch Token Generator](https://twitchtokengenerator.com/):

- Seleccione **Bot Token**
- Verifique que los alcances `chat:read` y `chat:write` estén seleccionados
- Copie el **Client ID** y el **Access Token**

No se requiere registro manual de la aplicación. Los tokens expiran después de varias horas.

### Configurar el bot

**Variable de entorno (solo cuenta predeterminada):**

```bash
OPENCLAW_TWITCH_ACCESS_TOKEN=oauth:abc123...
```

**O configuración:**

```json5
{
  channels: {
    twitch: {
      enabled: true,
      username: "openclaw",
      accessToken: "oauth:abc123...",
      clientId: "xyz789...",
      channel: "vevisk",
    },
  },
}
```

Si se configuran tanto env como config, config tiene prioridad.

### Control de acceso (recomendado)

```json5
{
  channels: {
    twitch: {
      allowFrom: ["123456789"], // (recommended) Your Twitch user ID only
    },
  },
}
```

Prefiera `allowFrom` para una lista de permitidos estricta. Use `allowedRoles` si desea acceso basado en roles.

**Roles disponibles:** `"moderator"`, `"owner"`, `"vip"`, `"subscriber"`, `"all"`.

**¿Por qué IDs de usuario?** Los nombres de usuario pueden cambiar, lo que permite suplantación. Los IDs de usuario son permanentes.

Encuentre su ID de usuario de Twitch: [https://www.streamweasels.com/tools/convert-twitch-username-%20to-user-id/](https://www.streamweasels.com/tools/convert-twitch-username-%20to-user-id/) (Convierta su nombre de usuario de Twitch a ID)

## Actualización de token (opcional)

Los tokens de [Twitch Token Generator](https://twitchtokengenerator.com/) no se pueden actualizar automáticamente; regenérelos cuando expiren.

Para actualización automática de tokens, cree su propia aplicación de Twitch en [Twitch Developer Console](https://dev.twitch.tv/console) y agréguela a la configuración:

```json5
{
  channels: {
    twitch: {
      clientSecret: "your_client_secret",
      refreshToken: "your_refresh_token",
    },
  },
}
```

El bot actualiza automáticamente los tokens antes de su vencimiento y registra los eventos de actualización.

## Soporte multi-cuenta

Use `channels.twitch.accounts` con tokens por cuenta. Consulte [`gateway/configuration`](/gateway/configuration) para el patrón compartido.

Ejemplo (una cuenta de bot en dos canales):

```json5
{
  channels: {
    twitch: {
      accounts: {
        channel1: {
          username: "openclaw",
          accessToken: "oauth:abc123...",
          clientId: "xyz789...",
          channel: "vevisk",
        },
        channel2: {
          username: "openclaw",
          accessToken: "oauth:def456...",
          clientId: "uvw012...",
          channel: "secondchannel",
        },
      },
    },
  },
}
```

**Nota:** Cada cuenta necesita su propio token (un token por canal).

## Control de acceso

### Restricciones basadas en roles

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          allowedRoles: ["moderator", "vip"],
        },
      },
    },
  },
}
```

### Lista de permitidos por ID de usuario (más seguro)

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          allowFrom: ["123456789", "987654321"],
        },
      },
    },
  },
}
```

### Acceso basado en roles (alternativa)

`allowFrom` es una lista de permitidos estricta. Cuando se establece, solo se permiten esos IDs de usuario.
Si desea acceso basado en roles, deje `allowFrom` sin configurar y configure `allowedRoles` en su lugar:

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          allowedRoles: ["moderator"],
        },
      },
    },
  },
}
```

### Deshabilitar el requisito de @mención

De forma predeterminada, `requireMention` es `true`. Para deshabilitarlo y responder a todos los mensajes:

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          requireMention: false,
        },
      },
    },
  },
}
```

## Solución de problemas

Primero, ejecute los comandos de diagnóstico:

```bash
openclaw doctor
openclaw channels status --probe
```

### El bot no responde a los mensajes

**Verifique el control de acceso:** Asegúrese de que su ID de usuario esté en `allowFrom`, o elimine temporalmente
`allowFrom` y establezca `allowedRoles: ["all"]` para probar.

**Verifique que el bot esté en el canal:** El bot debe unirse al canal especificado en `channel`.

### Problemas de token

**“Failed to connect” o errores de autenticación:**

- Verifique que `accessToken` sea el valor del token de acceso OAuth (normalmente comienza con el prefijo `oauth:`)
- Verifique que el token tenga los alcances `chat:read` y `chat:write`
- Si usa actualización de token, verifique que `clientSecret` y `refreshToken` estén configurados

### La actualización de token no funciona

**Revise los registros para eventos de actualización:**

```
Using env token source for mybot
Access token refreshed for user 123456 (expires in 14400s)
```

Si ve “token refresh disabled (no refresh token)”:

- Asegúrese de que `clientSecret` esté proporcionado
- Asegúrese de que `refreshToken` esté proporcionado

## Configuración

**Configuración de cuenta:**

- `username` - Nombre de usuario del bot
- `accessToken` - Token de acceso OAuth con `chat:read` y `chat:write`
- `clientId` - Client ID de Twitch (del Token Generator o de su aplicación)
- `channel` - Canal al que unirse (requerido)
- `enabled` - Habilitar esta cuenta (predeterminado: `true`)
- `clientSecret` - Opcional: Para actualización automática de tokens
- `refreshToken` - Opcional: Para actualización automática de tokens
- `expiresIn` - Vencimiento del token en segundos
- `obtainmentTimestamp` - Marca de tiempo de obtención del token
- `allowFrom` - Lista de permitidos de IDs de usuario
- `allowedRoles` - Control de acceso basado en roles (`"moderator" | "owner" | "vip" | "subscriber" | "all"`)
- `requireMention` - Requerir @mención (predeterminado: `true`)

**Opciones del proveedor:**

- `channels.twitch.enabled` - Habilitar/deshabilitar el inicio del canal
- `channels.twitch.username` - Nombre de usuario del bot (configuración simplificada de una sola cuenta)
- `channels.twitch.accessToken` - Token de acceso OAuth (configuración simplificada de una sola cuenta)
- `channels.twitch.clientId` - Client ID de Twitch (configuración simplificada de una sola cuenta)
- `channels.twitch.channel` - Canal al que unirse (configuración simplificada de una sola cuenta)
- `channels.twitch.accounts.<accountName>` - Configuración multi-cuenta (todos los campos de cuenta anteriores)

Ejemplo completo:

```json5
{
  channels: {
    twitch: {
      enabled: true,
      username: "openclaw",
      accessToken: "oauth:abc123...",
      clientId: "xyz789...",
      channel: "vevisk",
      clientSecret: "secret123...",
      refreshToken: "refresh456...",
      allowFrom: ["123456789"],
      allowedRoles: ["moderator", "vip"],
      accounts: {
        default: {
          username: "mybot",
          accessToken: "oauth:abc123...",
          clientId: "xyz789...",
          channel: "your_channel",
          enabled: true,
          clientSecret: "secret123...",
          refreshToken: "refresh456...",
          expiresIn: 14400,
          obtainmentTimestamp: 1706092800000,
          allowFrom: ["123456789", "987654321"],
          allowedRoles: ["moderator"],
        },
      },
    },
  },
}
```

## Acciones de herramientas

El agente puede llamar a `twitch` con la acción:

- `send` - Enviar un mensaje a un canal

Ejemplo:

```json5
{
  action: "twitch",
  params: {
    message: "Hello Twitch!",
    to: "#mychannel",
  },
}
```

## Seguridad y operaciones

- **Trate los tokens como contraseñas**: nunca confirme tokens en git
- **Use actualización automática de tokens** para bots de larga ejecución
- **Use listas de permitidos por ID de usuario** en lugar de nombres de usuario para el control de acceso
- **Monitoree los registros** para eventos de actualización de tokens y estado de conexión
- **Limite los alcances de los tokens**: solicite solo `chat:read` y `chat:write`
- **Si se atasca**: reinicie el gateway después de confirmar que ningún otro proceso sea propietario de la sesión

## Límites

- **500 caracteres** por mensaje (segmentado automáticamente en límites de palabras)
- El Markdown se elimina antes de la segmentación
- Sin limitación de velocidad (usa los límites integrados de Twitch)
