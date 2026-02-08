---
summary: "Descripción general del bot de Feishu, características y configuración"
read_when:
  - Quiere conectar un bot de Feishu/Lark
  - Está configurando el canal de Feishu
title: Feishu
x-i18n:
  source_path: channels/feishu.md
  source_hash: c9349983562d1a98
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:32:45Z
---

# Bot de Feishu

Feishu (Lark) es una plataforma de chat de equipo utilizada por empresas para mensajería y colaboración. Este plugin conecta OpenClaw con un bot de Feishu/Lark usando la suscripción de eventos WebSocket de la plataforma, de modo que los mensajes se puedan recibir sin exponer una URL pública de webhook.

---

## Plugin requerido

Instale el plugin de Feishu:

```bash
openclaw plugins install @openclaw/feishu
```

Clonado local (cuando se ejecuta desde un repositorio git):

```bash
openclaw plugins install ./extensions/feishu
```

---

## Inicio rápido

Hay dos formas de agregar el canal de Feishu:

### Método 1: asistente de incorporación (recomendado)

Si acaba de instalar OpenClaw, ejecute el asistente:

```bash
openclaw onboard
```

El asistente le guía a través de:

1. Crear una app de Feishu y recopilar credenciales
2. Configurar las credenciales de la app en OpenClaw
3. Iniciar el Gateway

✅ **Después de la configuración**, verifique el estado del Gateway:

- `openclaw gateway status`
- `openclaw logs --follow`

### Método 2: configuración por CLI

Si ya completó la instalación inicial, agregue el canal vía CLI:

```bash
openclaw channels add
```

Elija **Feishu**, luego ingrese el App ID y el App Secret.

✅ **Después de la configuración**, administre el Gateway:

- `openclaw gateway status`
- `openclaw gateway restart`
- `openclaw logs --follow`

---

## Paso 1: Crear una app de Feishu

### 1. Abrir Feishu Open Platform

Visite [Feishu Open Platform](https://open.feishu.cn/app) e inicie sesión.

Los tenants de Lark (global) deben usar [https://open.larksuite.com/app](https://open.larksuite.com/app) y establecer `domain: "lark"` en la configuración de Feishu.

### 2. Crear una app

1. Haga clic en **Create enterprise app**
2. Complete el nombre y la descripción de la app
3. Elija un icono para la app

![Create enterprise app](../images/feishu-step2-create-app.png)

### 3. Copiar credenciales

Desde **Credentials & Basic Info**, copie:

- **App ID** (formato: `cli_xxx`)
- **App Secret**

❗ **Importante:** mantenga el App Secret en privado.

![Get credentials](../images/feishu-step3-credentials.png)

### 4. Configurar permisos

En **Permissions**, haga clic en **Batch import** y pegue:

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

![Configure permissions](../images/feishu-step4-permissions.png)

### 5. Habilitar la capacidad de bot

En **App Capability** > **Bot**:

1. Habilite la capacidad de bot
2. Establezca el nombre del bot

![Enable bot capability](../images/feishu-step5-bot-capability.png)

### 6. Configurar la suscripción de eventos

⚠️ **Importante:** antes de configurar la suscripción de eventos, asegúrese de que:

1. Ya ejecutó `openclaw channels add` para Feishu
2. El Gateway está en ejecución (`openclaw gateway status`)

En **Event Subscription**:

1. Elija **Use long connection to receive events** (WebSocket)
2. Agregue el evento: `im.message.receive_v1`

⚠️ Si el Gateway no está en ejecución, la configuración de conexión larga puede no guardarse.

![Configure event subscription](../images/feishu-step6-event-subscription.png)

### 7. Publicar la app

1. Cree una versión en **Version Management & Release**
2. Envíe a revisión y publique
3. Espere la aprobación del administrador (las apps empresariales suelen aprobarse automáticamente)

---

## Paso 2: Configurar OpenClaw

### Configurar con el asistente (recomendado)

```bash
openclaw channels add
```

Elija **Feishu** y pegue su App ID y App Secret.

### Configurar mediante archivo de configuración

Edite `~/.openclaw/openclaw.json`:

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
          botName: "My AI assistant",
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

Si su tenant está en Lark (internacional), establezca el dominio en `lark` (o una cadena de dominio completa). Puede configurarlo en `channels.feishu.domain` o por cuenta (`channels.feishu.accounts.<id>.domain`).

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

## Paso 3: Iniciar y probar

### 1. Iniciar el Gateway

```bash
openclaw gateway
```

### 2. Enviar un mensaje de prueba

En Feishu, encuentre su bot y envíe un mensaje.

### 3. Aprobar el emparejamiento

De forma predeterminada, el bot responde con un código de emparejamiento. Apruébelo:

```bash
openclaw pairing approve feishu <CODE>
```

Después de la aprobación, puede chatear normalmente.

---

## Descripción general

- **Canal de bot de Feishu**: bot de Feishu administrado por el Gateway
- **Enrutamiento determinista**: las respuestas siempre regresan a Feishu
- **Aislamiento de sesiones**: los mensajes directos comparten una sesión principal; los grupos están aislados
- **Conexión WebSocket**: conexión larga vía SDK de Feishu, no se requiere URL pública

---

## Control de acceso

### Mensajes directos

- **Predeterminado**: `dmPolicy: "pairing"` (los usuarios desconocidos reciben un código de emparejamiento)
- **Aprobar emparejamiento**:

  ```bash
  openclaw pairing list feishu
  openclaw pairing approve feishu <CODE>
  ```

- **Modo de lista de permitidos**: establezca `channels.feishu.allowFrom` con los Open ID permitidos

### Chats grupales

**1. Política de grupos** (`channels.feishu.groupPolicy`):

- `"open"` = permitir a todos en grupos (predeterminado)
- `"allowlist"` = permitir solo `groupAllowFrom`
- `"disabled"` = deshabilitar mensajes de grupos

**2. Requisito de mención** (`channels.feishu.groups.<chat_id>.requireMention`):

- `true` = requerir @mención (predeterminado)
- `false` = responder sin menciones

---

## Ejemplos de configuración de grupos

### Permitir todos los grupos, requerir @mención (predeterminado)

```json5
{
  channels: {
    feishu: {
      groupPolicy: "open",
      // Default requireMention: true
    },
  },
}
```

### Permitir todos los grupos, sin requerir @mención

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

### Permitir solo usuarios específicos en grupos

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

1. Inicie el Gateway y @mencione al bot en el grupo
2. Ejecute `openclaw logs --follow` y busque `chat_id`

**Método 2**

Use el depurador de la API de Feishu para listar los chats de grupo.

### IDs de usuario (open_id)

Los IDs de usuario se ven como `ou_xxx`.

**Método 1 (recomendado)**

1. Inicie el Gateway y envíe un mensaje directo al bot
2. Ejecute `openclaw logs --follow` y busque `open_id`

**Método 2**

Revise las solicitudes de emparejamiento para obtener los Open ID de usuario:

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

## Comandos de gestión del Gateway

| Comando                    | Descripción                              |
| -------------------------- | ---------------------------------------- |
| `openclaw gateway status`  | Mostrar estado del Gateway               |
| `openclaw gateway install` | Instalar/iniciar el servicio del Gateway |
| `openclaw gateway stop`    | Detener el servicio del Gateway          |
| `openclaw gateway restart` | Reiniciar el servicio del Gateway        |
| `openclaw logs --follow`   | Ver logs del Gateway                     |

---

## Solución de problemas

### El bot no responde en chats grupales

1. Asegúrese de que el bot esté agregado al grupo
2. Asegúrese de @mencionar al bot (comportamiento predeterminado)
3. Verifique que `groupPolicy` no esté configurado en `"disabled"`
4. Revise los logs: `openclaw logs --follow`

### El bot no recibe mensajes

1. Asegúrese de que la app esté publicada y aprobada
2. Asegúrese de que la suscripción de eventos incluya `im.message.receive_v1`
3. Asegúrese de que la **conexión larga** esté habilitada
4. Asegúrese de que los permisos de la app estén completos
5. Asegúrese de que el Gateway esté en ejecución: `openclaw gateway status`
6. Revise los logs: `openclaw logs --follow`

### Fuga del App Secret

1. Restablezca el App Secret en Feishu Open Platform
2. Actualice el App Secret en su configuración
3. Reinicie el Gateway

### Fallos al enviar mensajes

1. Asegúrese de que la app tenga el permiso `im:message:send_as_bot`
2. Asegúrese de que la app esté publicada
3. Revise los logs para ver errores detallados

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
          botName: "Primary bot",
        },
        backup: {
          appId: "cli_yyy",
          appSecret: "yyy",
          botName: "Backup bot",
          enabled: false,
        },
      },
    },
  },
}
```

### Límites de mensajes

- `textChunkLimit`: tamaño del bloque de texto saliente (predeterminado: 2000 caracteres)
- `mediaMaxMb`: límite de carga/descarga de medios (predeterminado: 30 MB)

### Streaming

Feishu admite respuestas en streaming mediante tarjetas interactivas. Cuando está habilitado, el bot actualiza una tarjeta a medida que genera texto.

```json5
{
  channels: {
    feishu: {
      streaming: true, // enable streaming card output (default true)
      blockStreaming: true, // enable block-level streaming (default true)
    },
  },
}
```

Establezca `streaming: false` para esperar la respuesta completa antes de enviar.

### Enrutamiento multiagente

Use `bindings` para enrutar mensajes directos o grupos de Feishu a diferentes agentes.

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
        peer: { kind: "dm", id: "ou_xxx" },
      },
    },
    {
      agentId: "clawd-fan",
      match: {
        channel: "feishu",
        peer: { kind: "dm", id: "ou_yyy" },
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
- `match.peer.kind`: `"dm"` o `"group"`
- `match.peer.id`: Open ID de usuario (`ou_xxx`) o ID de grupo (`oc_xxx`)

Consulte [Obtener IDs de grupo/usuario](#get-groupuser-ids) para obtener consejos de búsqueda.

---

## Referencia de configuración

Configuración completa: [Configuración del Gateway](/gateway/configuration)

Opciones clave:

| Configuración                                     | Descripción                                                 | Predeterminado |
| ------------------------------------------------- | ----------------------------------------------------------- | -------------- |
| `channels.feishu.enabled`                         | Habilitar/deshabilitar canal                                | `true`         |
| `channels.feishu.domain`                          | Dominio de API (`feishu` o `lark`)                          | `feishu`       |
| `channels.feishu.accounts.<id>.appId`             | App ID                                                      | -              |
| `channels.feishu.accounts.<id>.appSecret`         | App Secret                                                  | -              |
| `channels.feishu.accounts.<id>.domain`            | Anulación de dominio de API por cuenta                      | `feishu`       |
| `channels.feishu.dmPolicy`                        | Política de mensajes directos                               | `pairing`      |
| `channels.feishu.allowFrom`                       | Lista de permitidos de mensajes directos (lista de open_id) | -              |
| `channels.feishu.groupPolicy`                     | Política de grupos                                          | `open`         |
| `channels.feishu.groupAllowFrom`                  | Lista de permitidos de grupos                               | -              |
| `channels.feishu.groups.<chat_id>.requireMention` | Requerir @mención                                           | `true`         |
| `channels.feishu.groups.<chat_id>.enabled`        | Habilitar grupos                                            | `true`         |
| `channels.feishu.textChunkLimit`                  | Tamaño del bloque de mensajes                               | `2000`         |
| `channels.feishu.mediaMaxMb`                      | Límite de tamaño de medios                                  | `30`           |
| `channels.feishu.streaming`                       | Habilitar salida de tarjeta en streaming                    | `true`         |
| `channels.feishu.blockStreaming`                  | Habilitar block streaming                                   | `true`         |

---

## Referencia de dmPolicy

| Valor         | Comportamiento                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| `"pairing"`   | **Predeterminado.** Los usuarios desconocidos reciben un código de emparejamiento; deben ser aprobados |
| `"allowlist"` | Solo los usuarios en `allowFrom` pueden chatear                                                        |
| `"open"`      | Permitir a todos los usuarios (requiere `"*"` en allowFrom)                                            |
| `"disabled"`  | Deshabilitar mensajes directos                                                                         |

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
