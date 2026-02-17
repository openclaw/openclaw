---
summary: "Descripción general, características y configuración del bot de Feishu"
read_when:
  - Quieres conectar un bot de Feishu/Lark
  - Estás configurando el canal de Feishu
title: Feishu
---

# Bot de Feishu

Feishu (Lark) es una plataforma de chat de equipo utilizada por empresas para mensajería y colaboración. Este plugin conecta OpenClaw a un bot de Feishu/Lark utilizando la suscripción de eventos por WebSocket de la plataforma para que los mensajes puedan recibirse sin exponer una URL de webhook pública.

---

## Plugin requerido

Instala el plugin de Feishu:

```bash
openclaw plugins install @openclaw/feishu
```

Instalación local (cuando se ejecuta desde un repositorio git):

```bash
openclaw plugins install ./extensions/feishu
```

---

## Inicio rápido

Hay dos formas de añadir el canal de Feishu:

### Método 1: asistente de incorporación (recomendado)

Si acabas de instalar OpenClaw, ejecuta el asistente:

```bash
openclaw onboard
```

El asistente te guía a través de:

1. Crear una app de Feishu y recopilar credenciales
2. Configurar las credenciales de la app en OpenClaw
3. Iniciar el gateway

✅ **Después de la configuración**, verifica el estado del gateway:

- `openclaw gateway status`
- `openclaw logs --follow`

### Método 2: configuración CLI

Si ya completaste la instalación inicial, añade el canal mediante CLI:

```bash
openclaw channels add
```

Elige **Feishu**, luego ingresa el App ID y App Secret.

✅ **Después de la configuración**, gestiona el gateway:

- `openclaw gateway status`
- `openclaw gateway restart`
- `openclaw logs --follow`

---

## Paso 1: Crear una app de Feishu

### 1. Abrir Feishu Open Platform

Visita [Feishu Open Platform](https://open.feishu.cn/app) e inicia sesión.

Los tenants de Lark (global) deben usar [https://open.larksuite.com/app](https://open.larksuite.com/app) y establecer `domain: "lark"` en la configuración de Feishu.

### 2. Crear una app

1. Haz clic en **Crear app empresarial**
2. Completa el nombre + descripción de la app
3. Elige un icono de app

![Crear app empresarial](../images/feishu-step2-create-app.png)

### 3. Copiar credenciales

Desde **Credenciales e información básica**, copia:

- **App ID** (formato: `cli_xxx`)
- **App Secret**

❗ **Importante:** mantén el App Secret privado.

![Obtener credenciales](../images/feishu-step3-credentials.png)

### 4. Configurar permisos

En **Permisos**, haz clic en **Importación por lotes** y pega:

```json
{
  "scopes": {
    "tenant": [
      "aily:file:read",
      "aily:file:write",
      "application:application.app_message_stats.overview:readonly",
      "application:application:self_manage",
      "application:bot.menu:write",
      "contact:user.employee_id:readonly",
      "corehr:file:download",
      "event:ip_list",
      "im:chat.access_event.bot_p2p_chat:read",
      "im:chat.members:bot_access",
      "im:message",
      "im:message.group_at_msg:readonly",
      "im:message.p2p_msg:readonly",
      "im:message:readonly",
      "im:message:send_as_bot",
      "im:resource"
    ],
    "user": ["aily:file:read", "aily:file:write", "im:chat.access_event.bot_p2p_chat:read"]
  }
}
```

![Configurar permisos](../images/feishu-step4-permissions.png)

### 5. Habilitar capacidad de bot

En **Capacidad de la app** > **Bot**:

1. Habilita la capacidad de bot
2. Establece el nombre del bot

![Habilitar capacidad de bot](../images/feishu-step5-bot-capability.png)

### 6. Configurar suscripción de eventos

⚠️ **Importante:** antes de configurar la suscripción de eventos, asegúrate de que:

1. Ya ejecutaste `openclaw channels add` para Feishu
2. El gateway está en ejecución (`openclaw gateway status`)

En **Suscripción de eventos**:

1. Elige **Usar conexión larga para recibir eventos** (WebSocket)
2. Añade el evento: `im.message.receive_v1`

⚠️ Si el gateway no está en ejecución, la configuración de conexión larga puede fallar al guardar.

![Configurar suscripción de eventos](../images/feishu-step6-event-subscription.png)

### 7. Publicar la app

1. Crea una versión en **Gestión de versiones y lanzamiento**
2. Envía para revisión y publica
3. Espera la aprobación del administrador (las apps empresariales generalmente se aprueban automáticamente)

---

## Paso 2: Configurar OpenClaw

### Configurar con el asistente (recomendado)

```bash
openclaw channels add
```

Elige **Feishu** y pega tu App ID + App Secret.

### Configurar mediante archivo de configuración

Edita `~/.openclaw/openclaw.json`:

```json5
{
  channels: {
    feishu: {
      enabled: true,
      dmPolicy: "pairing",
      accounts: {
        main: {
          appId: "cli_xxx",
          appSecret: "xxx",
          botName: "Mi asistente de IA",
        },
      },
    },
  },
}
```

### Configurar mediante variables de entorno

```bash
export FEISHU_APP_ID="cli_xxx"
export FEISHU_APP_SECRET="xxx"
```

### Dominio de Lark (global)

Si tu tenant está en Lark (internacional), establece el dominio a `lark` (o una cadena de dominio completa). Puedes establecerlo en `channels.feishu.domain` o por cuenta (`channels.feishu.accounts.<id>.domain`).

```json5
{
  channels: {
    feishu: {
      domain: "lark",
      accounts: {
        main: {
          appId: "cli_xxx",
          appSecret: "xxx",
        },
      },
    },
  },
}
```

---

## Paso 3: Iniciar + probar

### 1. Iniciar el gateway

```bash
openclaw gateway
```

### 2. Enviar un mensaje de prueba

En Feishu, busca tu bot y envía un mensaje.

### 3. Aprobar emparejamiento

Por defecto, el bot responde con un código de emparejamiento. Apruébalo:

```bash
openclaw pairing approve feishu <CODE>
```

Después de la aprobación, puedes chatear normalmente.

---

## Descripción general

- **Canal de bot de Feishu**: bot de Feishu gestionado por el gateway
- **Enrutamiento determinista**: las respuestas siempre regresan a Feishu
- **Aislamiento de sesiones**: los mensajes directos comparten una sesión principal; los grupos están aislados
- **Conexión WebSocket**: conexión larga mediante Feishu SDK, no se necesita URL pública

---

## Control de acceso

### Mensajes directos

- **Predeterminado**: `dmPolicy: "pairing"` (los usuarios desconocidos obtienen un código de emparejamiento)
- **Aprobar emparejamiento**:

  ```bash
  openclaw pairing list feishu
  openclaw pairing approve feishu <CODE>
  ```

- **Modo lista de permitidos**: establece `channels.feishu.allowFrom` con Open IDs permitidos

### Chats grupales

**1. Política de grupo** (`channels.feishu.groupPolicy`):

- `"open"` = permitir a todos en grupos (predeterminado)
- `"allowlist"` = solo permitir `groupAllowFrom`
- `"disabled"` = deshabilitar mensajes de grupo

**2. Requisito de mención** (`channels.feishu.groups.<chat_id>.requireMention`):

- `true` = requiere @mención (predeterminado)
- `false` = responde sin menciones

---

## Ejemplos de configuración de grupo

### Permitir todos los grupos, requiere @mención (predeterminado)

```json5
{
  channels: {
    feishu: {
      groupPolicy: "open",
      // Predeterminado requireMention: true
    },
  },
}
```

### Permitir todos los grupos, no requiere @mención

```json5
{
  channels: {
    feishu: {
      groups: {
        oc_xxx: { requireMention: false },
      },
    },
  },
}
```

### Permitir usuarios específicos solo en grupos

```json5
{
  channels: {
    feishu: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["ou_xxx", "ou_yyy"],
    },
  },
}
```

---

## Obtener IDs de grupo/usuario

### IDs de grupo (chat_id)

Los IDs de grupo se ven como `oc_xxx`.

**Método 1 (recomendado)**

1. Inicia el gateway y @menciona al bot en el grupo
2. Ejecuta `openclaw logs --follow` y busca `chat_id`

**Método 2**

Usa el depurador de API de Feishu para listar chats grupales.

### IDs de usuario (open_id)

Los IDs de usuario se ven como `ou_xxx`.

**Método 1 (recomendado)**

1. Inicia el gateway y envía un mensaje directo al bot
2. Ejecuta `openclaw logs --follow` y busca `open_id`

**Método 2**

Verifica las solicitudes de emparejamiento para Open IDs de usuario:

```bash
openclaw pairing list feishu
```

---

## Comandos comunes

| Comando   | Descripción            |
| --------- | ---------------------- |
| `/status` | Mostrar estado del bot |
| `/reset`  | Restablecer la sesión  |
| `/model`  | Mostrar/cambiar modelo |

> Nota: Feishu aún no admite menús de comandos nativos, por lo que los comandos deben enviarse como texto.

## Comandos de gestión del gateway

| Comando                    | Descripción                |
| -------------------------- | -------------------------- |
| `openclaw gateway status`  | Mostrar estado del gateway |
| `openclaw gateway install` | Instalar/iniciar servicio  |
| `openclaw gateway stop`    | Detener servicio           |
| `openclaw gateway restart` | Reiniciar servicio         |
| `openclaw logs --follow`   | Seguir logs del gateway    |

---

## Solución de problemas

### El bot no responde en chats grupales

1. Asegúrate de que el bot esté añadido al grupo
2. Asegúrate de @mencionar al bot (comportamiento predeterminado)
3. Verifica que `groupPolicy` no esté establecida en `"disabled"`
4. Verifica logs: `openclaw logs --follow`

### El bot no recibe mensajes

1. Asegúrate de que la app esté publicada y aprobada
2. Asegúrate de que la suscripción de eventos incluya `im.message.receive_v1`
3. Asegúrate de que la **conexión larga** esté habilitada
4. Asegúrate de que los permisos de la app estén completos
5. Asegúrate de que el gateway esté en ejecución: `openclaw gateway status`
6. Verifica logs: `openclaw logs --follow`

### Fuga de App Secret

1. Restablece el App Secret en Feishu Open Platform
2. Actualiza el App Secret en tu configuración
3. Reinicia el gateway

### Fallos en el envío de mensajes

1. Asegúrate de que la app tenga el permiso `im:message:send_as_bot`
2. Asegúrate de que la app esté publicada
3. Verifica los logs para errores detallados

---

## Configuración avanzada

### Múltiples cuentas

```json5
{
  channels: {
    feishu: {
      accounts: {
        main: {
          appId: "cli_xxx",
          appSecret: "xxx",
          botName: "Bot principal",
        },
        backup: {
          appId: "cli_yyy",
          appSecret: "yyy",
          botName: "Bot de respaldo",
          enabled: false,
        },
      },
    },
  },
}
```

### Límites de mensajes

- `textChunkLimit`: tamaño de fragmento de texto de salida (predeterminado: 2000 caracteres)
- `mediaMaxMb`: límite de carga/descarga de medios (predeterminado: 30MB)

### Streaming

Feishu admite respuestas en streaming mediante tarjetas interactivas. Cuando está habilitado, el bot actualiza una tarjeta mientras genera texto.

```json5
{
  channels: {
    feishu: {
      streaming: true, // habilitar salida de tarjeta en streaming (predeterminado true)
      blockStreaming: true, // habilitar streaming a nivel de bloque (predeterminado true)
    },
  },
}
```

Establece `streaming: false` para esperar la respuesta completa antes de enviar.

### Enrutamiento multi-agente

Usa `bindings` para enrutar mensajes directos o grupos de Feishu a diferentes agentes.

```json5
{
  agents: {
    list: [
      { id: "main" },
      {
        id: "clawd-fan",
        workspace: "/home/user/clawd-fan",
        agentDir: "/home/user/.openclaw/agents/clawd-fan/agent",
      },
      {
        id: "clawd-xi",
        workspace: "/home/user/clawd-xi",
        agentDir: "/home/user/.openclaw/agents/clawd-xi/agent",
      },
    ],
  },
  bindings: [
    {
      agentId: "main",
      match: {
        channel: "feishu",
        peer: { kind: "direct", id: "ou_xxx" },
      },
    },
    {
      agentId: "clawd-fan",
      match: {
        channel: "feishu",
        peer: { kind: "direct", id: "ou_yyy" },
      },
    },
    {
      agentId: "clawd-xi",
      match: {
        channel: "feishu",
        peer: { kind: "group", id: "oc_zzz" },
      },
    },
  ],
}
```

Campos de enrutamiento:

- `match.channel`: `"feishu"`
- `match.peer.kind`: `"direct"` o `"group"`
- `match.peer.id`: Open ID de usuario (`ou_xxx`) o ID de grupo (`oc_xxx`)

Consulta [Obtener IDs de grupo/usuario](#obtener-ids-de-grupousuario) para consejos de búsqueda.

---

## Referencia de configuración

Configuración completa: [Configuración del gateway](/es-ES/gateway/configuration)

Opciones clave:

| Configuración                                     | Descripción                              | Predeterminado |
| ------------------------------------------------- | ---------------------------------------- | -------------- |
| `channels.feishu.enabled`                         | Habilitar/deshabilitar canal             | `true`         |
| `channels.feishu.domain`                          | Dominio API (`feishu` o `lark`)          | `feishu`       |
| `channels.feishu.accounts.<id>.appId`             | App ID                                   | -              |
| `channels.feishu.accounts.<id>.appSecret`         | App Secret                               | -              |
| `channels.feishu.accounts.<id>.domain`            | Anulación de dominio API por cuenta      | `feishu`       |
| `channels.feishu.dmPolicy`                        | Política de mensajes directos            | `pairing`      |
| `channels.feishu.allowFrom`                       | Lista de permitidos DM (lista open_id)   | -              |
| `channels.feishu.groupPolicy`                     | Política de grupo                        | `open`         |
| `channels.feishu.groupAllowFrom`                  | Lista de permitidos de grupo             | -              |
| `channels.feishu.groups.<chat_id>.requireMention` | Requiere @mención                        | `true`         |
| `channels.feishu.groups.<chat_id>.enabled`        | Habilitar grupo                          | `true`         |
| `channels.feishu.textChunkLimit`                  | Tamaño de fragmento de mensaje           | `2000`         |
| `channels.feishu.mediaMaxMb`                      | Límite de tamaño de medios               | `30`           |
| `channels.feishu.streaming`                       | Habilitar salida de tarjeta en streaming | `true`         |
| `channels.feishu.blockStreaming`                  | Habilitar streaming de bloques           | `true`         |

---

## Referencia dmPolicy

| Valor         | Comportamiento                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------- |
| `"pairing"`   | **Predeterminado.** Los usuarios desconocidos obtienen un código de emparejamiento; deben ser aprobados |
| `"allowlist"` | Solo los usuarios en `allowFrom` pueden chatear                                                         |
| `"open"`      | Permitir todos los usuarios (requiere `"*"` en allowFrom)                                               |
| `"disabled"`  | Deshabilitar mensajes directos                                                                          |

---

## Tipos de mensajes compatibles

### Recibir

- ✅ Texto
- ✅ Texto enriquecido (post)
- ✅ Imágenes
- ✅ Archivos
- ✅ Audio
- ✅ Video
- ✅ Stickers

### Enviar

- ✅ Texto
- ✅ Imágenes
- ✅ Archivos
- ✅ Audio
- ⚠️ Texto enriquecido (soporte parcial)
