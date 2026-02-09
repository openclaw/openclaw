---
summary: "Comportamiento del chat grupal en distintas superficies (WhatsApp/Telegram/Discord/Slack/Signal/iMessage/Microsoft Teams)"
read_when:
  - Cambiar el comportamiento del chat grupal o el control por menciones
title: "Grupos"
---

# Grupos

OpenClaw trata los chats grupales de forma consistente en todas las superficies: WhatsApp, Telegram, Discord, Slack, Signal, iMessage y Microsoft Teams.

## Introducción para principiantes (2 minutos)

OpenClaw “vive” en sus propias cuentas de mensajería. No existe un usuario de bot separado de WhatsApp.
Si **usted** está en un grupo, OpenClaw puede ver ese grupo y responder allí.

Comportamiento predeterminado:

- Los grupos están restringidos (`groupPolicy: "allowlist"`).
- Las respuestas requieren una mención a menos que usted desactive explícitamente el control por menciones.

Traducción: los remitentes en la lista de permitidos pueden activar OpenClaw al mencionarlo.

> TL;DR
>
> - El **acceso a mensajes directos** está controlado por `*.allowFrom`.
> - El **acceso a grupos** está controlado por `*.groupPolicy` + listas de permitidos (`*.groups`, `*.groupAllowFrom`).
> - La **activación de respuestas** está controlada por el control por menciones (`requireMention`, `/activation`).

Flujo rápido (qué ocurre con un mensaje de grupo):

```
groupPolicy? disabled -> drop
groupPolicy? allowlist -> group allowed? no -> drop
requireMention? yes -> mentioned? no -> store for context only
otherwise -> reply
```

![Flujo de mensajes de grupo](/images/groups-flow.svg)

Si usted quiere...

| Objetivo                                                                  | Qué configurar                                                              |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Permitir todos los grupos pero responder solo con @menciones | `groups: { "*": { requireMention: true } }`                                 |
| Desactivar todas las respuestas en grupos                                 | `groupPolicy: "disabled"`                                                   |
| Solo grupos específicos                                                   | `groups: { "<group-id>": { ... } }` (sin la clave `"*"`) |
| Solo usted puede activar en grupos                                        | `groupPolicy: "allowlist"`, `groupAllowFrom: ["+1555..."]`                  |

## Claves de sesión

- Las sesiones de grupo usan claves de sesión `agent:<agentId>:<channel>:group:<id>` (las salas/canales usan `agent:<agentId>:<channel>:channel:<id>`).
- Los temas de foros de Telegram agregan `:topic:<threadId>` al ID del grupo para que cada tema tenga su propia sesión.
- Los chats directos usan la sesión principal (o por remitente si está configurado).
- Los heartbeats se omiten para las sesiones de grupo.

## Patrón: DMs personales + grupos públicos (un solo agente)

Sí — esto funciona bien si su tráfico “personal” son **mensajes directos** y su tráfico “público” son **grupos**.

Por qué: en el modo de agente único, los mensajes directos normalmente llegan a la clave de sesión **principal** (`agent:main:main`), mientras que los grupos siempre usan claves de sesión **no principales** (`agent:main:<channel>:group:<id>`). Si usted habilita sandboxing con `mode: "non-main"`, esas sesiones de grupo se ejecutan en Docker mientras que su sesión principal de mensajes directos permanece en el host.

Esto le da un solo “cerebro” de agente (espacio de trabajo y memoria compartidos), pero dos posturas de ejecución:

- **Mensajes directos**: herramientas completas (host)
- **Grupos**: sandbox + herramientas restringidas (Docker)

> Si necesita espacios de trabajo/personas verdaderamente separados (“personal” y “público” nunca deben mezclarse), use un segundo agente + vinculaciones. Vea [Enrutamiento multiagente](/concepts/multi-agent).

Ejemplo (mensajes directos en el host, grupos en sandbox + herramientas solo de mensajería):

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main", // groups/channels are non-main -> sandboxed
        scope: "session", // strongest isolation (one container per group/channel)
        workspaceAccess: "none",
      },
    },
  },
  tools: {
    sandbox: {
      tools: {
        // If allow is non-empty, everything else is blocked (deny still wins).
        allow: ["group:messaging", "group:sessions"],
        deny: ["group:runtime", "group:fs", "group:ui", "nodes", "cron", "gateway"],
      },
    },
  },
}
```

¿Quiere “los grupos solo pueden ver la carpeta X” en lugar de “sin acceso al host”? Mantenga `workspaceAccess: "none"` y monte solo rutas en la lista de permitidos dentro del sandbox:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main",
        scope: "session",
        workspaceAccess: "none",
        docker: {
          binds: [
            // hostPath:containerPath:mode
            "~/FriendsShared:/data:ro",
          ],
        },
      },
    },
  },
}
```

Relacionado:

- Claves de configuración y valores predeterminados: [Configuración del Gateway](/gateway/configuration#agentsdefaultssandbox)
- Depurar por qué una herramienta está bloqueada: [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated)
- Detalles de montajes bind: [Sandboxing](/gateway/sandboxing#custom-bind-mounts)

## Etiquetas de visualización

- Las etiquetas de la UI usan `displayName` cuando está disponible, con el formato `<channel>:<token>`.
- `#room` está reservado para salas/canales; los chats grupales usan `g-<slug>` (minúsculas, espacios -> `-`, conservar `#@+._-`).

## Política de grupos

Controle cómo se manejan los mensajes de grupos/salas por canal:

```json5
{
  channels: {
    whatsapp: {
      groupPolicy: "disabled", // "open" | "disabled" | "allowlist"
      groupAllowFrom: ["+15551234567"],
    },
    telegram: {
      groupPolicy: "disabled",
      groupAllowFrom: ["123456789", "@username"],
    },
    signal: {
      groupPolicy: "disabled",
      groupAllowFrom: ["+15551234567"],
    },
    imessage: {
      groupPolicy: "disabled",
      groupAllowFrom: ["chat_id:123"],
    },
    msteams: {
      groupPolicy: "disabled",
      groupAllowFrom: ["user@org.com"],
    },
    discord: {
      groupPolicy: "allowlist",
      guilds: {
        GUILD_ID: { channels: { help: { allow: true } } },
      },
    },
    slack: {
      groupPolicy: "allowlist",
      channels: { "#general": { allow: true } },
    },
    matrix: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["@owner:example.org"],
      groups: {
        "!roomId:example.org": { allow: true },
        "#alias:example.org": { allow: true },
      },
    },
  },
}
```

| Política      | Comportamiento                                                                                        |
| ------------- | ----------------------------------------------------------------------------------------------------- |
| `"open"`      | Los grupos omiten las listas de permitidos; el control por menciones sigue aplicando. |
| `"disabled"`  | Bloquea por completo todos los mensajes de grupo.                                     |
| `"allowlist"` | Solo permite grupos/salas que coincidan con la lista de permitidos configurada.       |

Notas:

- `groupPolicy` es independiente del control por menciones (que requiere @menciones).
- WhatsApp/Telegram/Signal/iMessage/Microsoft Teams: use `groupAllowFrom` (alternativa: `allowFrom` explícito).
- Discord: la lista de permitidos usa `channels.discord.guilds.<id>.channels`.
- Slack: la lista de permitidos usa `channels.slack.channels`.
- Matrix: la lista de permitidos usa `channels.matrix.groups` (IDs de sala, alias o nombres). Use `channels.matrix.groupAllowFrom` para restringir remitentes; también se admiten listas de permitidos `users` por sala.
- Los mensajes directos grupales se controlan por separado (`channels.discord.dm.*`, `channels.slack.dm.*`).
- La lista de permitidos de Telegram puede coincidir con IDs de usuario (`"123456789"`, `"telegram:123456789"`, `"tg:123456789"`) o nombres de usuario (`"@alice"` o `"alice"`); los prefijos no distinguen mayúsculas/minúsculas.
- El valor predeterminado es `groupPolicy: "allowlist"`; si su lista de permitidos de grupos está vacía, los mensajes de grupo se bloquean.

Modelo mental rápido (orden de evaluación para mensajes de grupo):

1. `groupPolicy` (abierto/deshabilitado/lista de permitidos)
2. listas de permitidos de grupos (`*.groups`, `*.groupAllowFrom`, lista de permitidos específica del canal)
3. control por menciones (`requireMention`, `/activation`)

## Control por menciones (predeterminado)

Los mensajes de grupo requieren una mención a menos que se sobrescriba por grupo. Los valores predeterminados viven por subsistema bajo `*.groups."*"`.

Responder a un mensaje del bot cuenta como una mención implícita (cuando el canal admite metadatos de respuesta). Esto aplica a Telegram, WhatsApp, Slack, Discord y Microsoft Teams.

```json5
{
  channels: {
    whatsapp: {
      groups: {
        "*": { requireMention: true },
        "123@g.us": { requireMention: false },
      },
    },
    telegram: {
      groups: {
        "*": { requireMention: true },
        "123456789": { requireMention: false },
      },
    },
    imessage: {
      groups: {
        "*": { requireMention: true },
        "123": { requireMention: false },
      },
    },
  },
  agents: {
    list: [
      {
        id: "main",
        groupChat: {
          mentionPatterns: ["@openclaw", "openclaw", "\\+15555550123"],
          historyLimit: 50,
        },
      },
    ],
  },
}
```

Notas:

- `mentionPatterns` son expresiones regulares que no distinguen mayúsculas/minúsculas.
- Las superficies que proporcionan menciones explícitas siguen pasando; los patrones son un respaldo.
- Sobrescritura por agente: `agents.list[].groupChat.mentionPatterns` (útil cuando varios agentes comparten un grupo).
- El control por menciones solo se aplica cuando la detección de menciones es posible (menciones nativas o cuando `mentionPatterns` está configurado).
- Los valores predeterminados de Discord viven en `channels.discord.guilds."*"` (anulables por servidor/canal).
- El contexto histórico del grupo se envuelve de forma uniforme entre canales y es **solo pendiente** (mensajes omitidos por el control por menciones); use `messages.groupChat.historyLimit` para el valor predeterminado global y `channels.<channel>.historyLimit` (o `channels.<channel>.accounts.*.historyLimit`) para anulaciones. Configure `0` para desactivar.

## Restricciones de herramientas por grupo/canal (opcional)

Algunas configuraciones de canal admiten restringir qué herramientas están disponibles **dentro de un grupo/sala/canal específico**.

- `tools`: permitir/negar herramientas para todo el grupo.
- `toolsBySender`: anulaciones por remitente dentro del grupo (las claves son IDs de remitente/nombres de usuario/correos electrónicos/números de teléfono según el canal). Use `"*"` como comodín.

Orden de resolución (gana el más específico):

1. coincidencia de `toolsBySender` de grupo/canal
2. `tools` de grupo/canal
3. coincidencia `toolsBySender` del valor predeterminado (`"*"`)
4. `tools` del valor predeterminado (`"*"`)

Ejemplo (Telegram):

```json5
{
  channels: {
    telegram: {
      groups: {
        "*": { tools: { deny: ["exec"] } },
        "-1001234567890": {
          tools: { deny: ["exec", "read", "write"] },
          toolsBySender: {
            "123456789": { alsoAllow: ["exec"] },
          },
        },
      },
    },
  },
}
```

Notas:

- Las restricciones de herramientas por grupo/canal se aplican además de la política global/del agente (la denegación sigue ganando).
- Algunos canales usan un anidamiento diferente para salas/canales (p. ej., Discord `guilds.*.channels.*`, Slack `channels.*`, MS Teams `teams.*.channels.*`).

## Listas de permitidos de grupos

Cuando se configura `channels.whatsapp.groups`, `channels.telegram.groups` o `channels.imessage.groups`, las claves actúan como una lista de permitidos de grupos. Use `"*"` para permitir todos los grupos mientras sigue configurando el comportamiento de menciones predeterminado.

Intenciones comunes (copiar/pegar):

1. Desactivar todas las respuestas en grupos

```json5
{
  channels: { whatsapp: { groupPolicy: "disabled" } },
}
```

2. Permitir solo grupos específicos (WhatsApp)

```json5
{
  channels: {
    whatsapp: {
      groups: {
        "123@g.us": { requireMention: true },
        "456@g.us": { requireMention: false },
      },
    },
  },
}
```

3. Permitir todos los grupos pero requerir mención (explícito)

```json5
{
  channels: {
    whatsapp: {
      groups: { "*": { requireMention: true } },
    },
  },
}
```

4. Solo el propietario puede activar en grupos (WhatsApp)

```json5
{
  channels: {
    whatsapp: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15551234567"],
      groups: { "*": { requireMention: true } },
    },
  },
}
```

## Activación (solo propietario)

Los propietarios de grupos pueden alternar la activación por grupo:

- `/activation mention`
- `/activation always`

El propietario se determina por `channels.whatsapp.allowFrom` (o el E.164 propio del bot cuando no está configurado). Envíe el comando como un mensaje independiente. Otras superficies actualmente ignoran `/activation`.

## Campos de contexto

Las cargas entrantes de grupos establecen:

- `ChatType=group`
- `GroupSubject` (si se conoce)
- `GroupMembers` (si se conoce)
- `WasMentioned` (resultado del control por menciones)
- Los temas de foros de Telegram también incluyen `MessageThreadId` y `IsForum`.

El prompt del sistema del agente incluye una introducción del grupo en el primer turno de una nueva sesión de grupo. Le recuerda al modelo responder como un humano, evitar tablas en Markdown y evitar escribir secuencias literales `\n`.

## Especificidades de iMessage

- Prefiera `chat_id:<id>` al enrutar o crear listas de permitidos.
- Listar chats: `imsg chats --limit 20`.
- Las respuestas en grupos siempre regresan al mismo `chat_id`.

## Especificidades de WhatsApp

Vea [Mensajes de grupo](/channels/group-messages) para el comportamiento exclusivo de WhatsApp (inyección de historial, detalles del manejo de menciones).
