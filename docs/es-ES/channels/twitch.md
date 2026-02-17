---
summary: "Configuración y setup del bot de chat de Twitch"
read_when:
  - Configurando la integración de chat de Twitch para OpenClaw
title: "Twitch"
---

# Twitch (plugin)

Soporte de chat de Twitch mediante conexión IRC. OpenClaw se conecta como un usuario de Twitch (cuenta de bot) para recibir y enviar mensajes en canales.

## Plugin requerido

Twitch se distribuye como plugin y no viene incluido con la instalación principal.

Instalar mediante CLI (registro npm):

```bash
openclaw plugins install @openclaw/twitch
```

Instalación local (cuando se ejecuta desde un repositorio git):

```bash
openclaw plugins install ./extensions/twitch
```

Detalles: [Plugins](/es-ES/tools/plugin)

## Configuración rápida (principiante)

1. Crea una cuenta de Twitch dedicada para el bot (o usa una cuenta existente).
2. Genera credenciales: [Twitch Token Generator](https://twitchtokengenerator.com/)
   - Selecciona **Bot Token**
   - Verifica que los scopes `chat:read` y `chat:write` estén seleccionados
   - Copia el **Client ID** y el **Access Token**
3. Encuentra tu ID de usuario de Twitch: [https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/](https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/)
4. Configura el token:
   - Env: `OPENCLAW_TWITCH_ACCESS_TOKEN=...` (solo cuenta predeterminada)
   - O config: `channels.twitch.accessToken`
   - Si ambos están establecidos, la configuración tiene precedencia (env es respaldo solo para cuenta predeterminada).
5. Inicia el gateway.

**⚠️ Importante:** Añade control de acceso (`allowFrom` o `allowedRoles`) para evitar que usuarios no autorizados activen el bot. `requireMention` está en `true` por defecto.

Configuración mínima:

```json5
{
  channels: {
    twitch: {
      enabled: true,
      username: "openclaw", // Cuenta de Twitch del bot
      accessToken: "oauth:abc123...", // OAuth Access Token (o usa la variable de entorno OPENCLAW_TWITCH_ACCESS_TOKEN)
      clientId: "xyz789...", // Client ID del Token Generator
      channel: "vevisk", // A qué canal de Twitch unirse (requerido)
      allowFrom: ["123456789"], // (recomendado) Solo tu ID de usuario de Twitch - obténlo desde https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/
    },
  },
}
```

## Qué es

- Un canal de Twitch gestionado por el Gateway.
- Enrutamiento determinista: las respuestas siempre regresan a Twitch.
- Cada cuenta se mapea a una clave de sesión aislada `agent:<agentId>:twitch:<accountName>`.
- `username` es la cuenta del bot (quien autentica), `channel` es a qué sala de chat unirse.

## Configuración (detallado)

### Generar credenciales

Usa [Twitch Token Generator](https://twitchtokengenerator.com/):

- Selecciona **Bot Token**
- Verifica que los scopes `chat:read` y `chat:write` estén seleccionados
- Copia el **Client ID** y el **Access Token**

No se necesita registro manual de app. Los tokens expiran después de varias horas.

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

Si tanto env como config están establecidos, la configuración tiene precedencia.

### Control de acceso (recomendado)

```json5
{
  channels: {
    twitch: {
      allowFrom: ["123456789"], // (recomendado) Solo tu ID de usuario de Twitch
    },
  },
}
```

Prefiere `allowFrom` para una lista de permitidos estricta. Usa `allowedRoles` en su lugar si quieres acceso basado en roles.

**Roles disponibles:** `"moderator"`, `"owner"`, `"vip"`, `"subscriber"`, `"all"`.

**¿Por qué IDs de usuario?** Los nombres de usuario pueden cambiar, permitiendo suplantación. Los IDs de usuario son permanentes.

Encuentra tu ID de usuario de Twitch: [https://www.streamweasels.com/tools/convert-twitch-username-%20to-user-id/](https://www.streamweasels.com/tools/convert-twitch-username-%20to-user-id/) (Convierte tu nombre de usuario de Twitch a ID)

## Actualización de token (opcional)

Los tokens de [Twitch Token Generator](https://twitchtokengenerator.com/) no pueden actualizarse automáticamente - regenera cuando expiren.

Para actualización automática de token, crea tu propia aplicación de Twitch en [Twitch Developer Console](https://dev.twitch.tv/console) y añade a la configuración:

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

El bot actualiza automáticamente los tokens antes de la expiración y registra eventos de actualización.

## Soporte multi-cuenta

Usa `channels.twitch.accounts` con tokens por cuenta. Consulta [`gateway/configuration`](/es-ES/gateway/configuration) para el patrón compartido.

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

`allowFrom` es una lista de permitidos estricta. Cuando se establece, solo esos IDs de usuario están permitidos.
Si quieres acceso basado en roles, deja `allowFrom` sin establecer y configura `allowedRoles` en su lugar:

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

### Deshabilitar requisito de @mención

Por defecto, `requireMention` es `true`. Para deshabilitar y responder a todos los mensajes:

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

Primero, ejecuta comandos de diagnóstico:

```bash
openclaw doctor
openclaw channels status --probe
```

### El bot no responde a los mensajes

**Verifica el control de acceso:** Asegúrate de que tu ID de usuario esté en `allowFrom`, o temporalmente elimina
`allowFrom` y establece `allowedRoles: ["all"]` para probar.

**Verifica que el bot esté en el canal:** El bot debe unirse al canal especificado en `channel`.

### Problemas con tokens

**"Failed to connect" o errores de autenticación:**

- Verifica que `accessToken` sea el valor del token de acceso OAuth (típicamente comienza con el prefijo `oauth:`)
- Verifica que el token tenga los scopes `chat:read` y `chat:write`
- Si usas actualización de token, verifica que `clientSecret` y `refreshToken` estén establecidos

### La actualización de token no funciona

**Verifica los logs para eventos de actualización:**

```
Using env token source for mybot
Access token refreshed for user 123456 (expires in 14400s)
```

Si ves "token refresh disabled (no refresh token)":

- Asegúrate de que `clientSecret` esté proporcionado
- Asegúrate de que `refreshToken` esté proporcionado

## Configuración

**Configuración de cuenta:**

- `username` - Nombre de usuario del bot
- `accessToken` - Token de acceso OAuth con `chat:read` y `chat:write`
- `clientId` - Client ID de Twitch (desde Token Generator o tu app)
- `channel` - Canal al que unirse (requerido)
- `enabled` - Habilitar esta cuenta (predeterminado: `true`)
- `clientSecret` - Opcional: Para actualización automática de token
- `refreshToken` - Opcional: Para actualización automática de token
- `expiresIn` - Expiración del token en segundos
- `obtainmentTimestamp` - Marca de tiempo de obtención del token
- `allowFrom` - Lista de permitidos de ID de usuario
- `allowedRoles` - Control de acceso basado en roles (`"moderator" | "owner" | "vip" | "subscriber" | "all"`)
- `requireMention` - Requiere @mención (predeterminado: `true`)

**Opciones del provider:**

- `channels.twitch.enabled` - Habilitar/deshabilitar inicio del canal
- `channels.twitch.username` - Nombre de usuario del bot (configuración simplificada de cuenta única)
- `channels.twitch.accessToken` - Token de acceso OAuth (configuración simplificada de cuenta única)
- `channels.twitch.clientId` - Client ID de Twitch (configuración simplificada de cuenta única)
- `channels.twitch.channel` - Canal al que unirse (configuración simplificada de cuenta única)
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

El agente puede llamar `twitch` con acción:

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

- **Trata los tokens como contraseñas** - Nunca confirmes tokens en git
- **Usa actualización automática de tokens** para bots de ejecución prolongada
- **Usa listas de permitidos de ID de usuario** en lugar de nombres de usuario para control de acceso
- **Monitorea los logs** para eventos de actualización de tokens y estado de conexión
- **Limita los scopes de tokens** - Solo solicita `chat:read` y `chat:write`
- **Si te atascas**: Reinicia el gateway después de confirmar que ningún otro proceso posee la sesión

## Límites

- **500 caracteres** por mensaje (fragmentación automática en límites de palabras)
- Markdown se elimina antes de fragmentar
- Sin limitación de tasa (usa los límites de tasa integrados de Twitch)
