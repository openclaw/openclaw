---
summary: "Todas las opciones de configuración para ~/.openclaw/openclaw.json con ejemplos"
read_when:
  - Al agregar o modificar campos de configuración
title: "Configuración"
x-i18n:
  source_path: gateway/configuration.md
  source_hash: e226e24422c05e7e
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:39:43Z
---

# Configuración 🔧

OpenClaw lee una configuración **JSON5** opcional desde `~/.openclaw/openclaw.json` (se permiten comentarios y comas finales).

Si el archivo falta, OpenClaw usa valores predeterminados razonablemente seguros (agente Pi integrado + sesiones por remitente + espacio de trabajo `~/.openclaw/workspace`). Por lo general, solo necesita una configuración para:

- restringir quién puede activar el bot (`channels.whatsapp.allowFrom`, `channels.telegram.allowFrom`, etc.)
- controlar listas de permitidos de grupos y el comportamiento de menciones (`channels.whatsapp.groups`, `channels.telegram.groups`, `channels.discord.guilds`, `agents.list[].groupChat`)
- personalizar prefijos de mensajes (`messages`)
- establecer el espacio de trabajo del agente (`agents.defaults.workspace` o `agents.list[].workspace`)
- ajustar los valores predeterminados del agente integrado (`agents.defaults`) y el comportamiento de sesión (`session`)
- establecer la identidad por agente (`agents.list[].identity`)

> **¿Nuevo en la configuración?** Consulte la guía de [Ejemplos de configuración](/gateway/configuration-examples) para ver ejemplos completos con explicaciones detalladas.

## Validación estricta de configuración

OpenClaw solo acepta configuraciones que coincidan completamente con el esquema.
Claves desconocidas, tipos malformados o valores inválidos hacen que el Gateway **se niegue a iniciar** por seguridad.

Cuando falla la validación:

- El Gateway no arranca.
- Solo se permiten comandos de diagnóstico (por ejemplo: `openclaw doctor`, `openclaw logs`, `openclaw health`, `openclaw status`, `openclaw service`, `openclaw help`).
- Ejecute `openclaw doctor` para ver los problemas exactos.
- Ejecute `openclaw doctor --fix` (o `--yes`) para aplicar migraciones/reparaciones.

Doctor nunca escribe cambios a menos que usted opte explícitamente por `--fix`/`--yes`.

## Esquema + pistas de UI

El Gateway expone una representación JSON Schema de la configuración mediante `config.schema` para editores de UI.
La UI de Control renderiza un formulario a partir de este esquema, con un editor de **JSON sin procesar** como vía de escape.

Los plugins de canal y las extensiones pueden registrar esquema y pistas de UI para su configuración, de modo que los ajustes del canal
se mantengan basados en esquema entre aplicaciones sin formularios codificados.

Las pistas (etiquetas, agrupación, campos sensibles) se entregan junto con el esquema para que los clientes puedan renderizar
mejores formularios sin codificar conocimiento de la configuración.

## Aplicar + reiniciar (RPC)

Use `config.apply` para validar y escribir la configuración completa y reiniciar el Gateway en un solo paso.
Escribe un centinela de reinicio y hace ping a la última sesión activa después de que el Gateway vuelve.

Advertencia: `config.apply` reemplaza la **configuración completa**. Si desea cambiar solo algunas claves,
use `config.patch` o `openclaw config set`. Mantenga una copia de seguridad de `~/.openclaw/openclaw.json`.

Parámetros:

- `raw` (string) — carga útil JSON5 para la configuración completa
- `baseHash` (opcional) — hash de configuración de `config.get` (requerido cuando ya existe una configuración)
- `sessionKey` (opcional) — clave de la última sesión activa para el ping de activación
- `note` (opcional) — nota para incluir en el centinela de reinicio
- `restartDelayMs` (opcional) — retraso antes del reinicio (predeterminado 2000)

Ejemplo (vía `gateway call`):

```bash
openclaw gateway call config.get --params '{}' # capture payload.hash
openclaw gateway call config.apply --params '{
  "raw": "{\\n  agents: { defaults: { workspace: \\"~/.openclaw/workspace\\" } }\\n}\\n",
  "baseHash": "<hash-from-config.get>",
  "sessionKey": "agent:main:whatsapp:dm:+15555550123",
  "restartDelayMs": 1000
}'
```

## Actualizaciones parciales (RPC)

Use `config.patch` para fusionar una actualización parcial en la configuración existente sin sobrescribir
claves no relacionadas. Aplica semántica de JSON merge patch:

- los objetos se fusionan recursivamente
- `null` elimina una clave
- los arreglos se reemplazan  
  Al igual que `config.apply`, valida, escribe la configuración, almacena un centinela de reinicio y programa
  el reinicio del Gateway (con una activación opcional cuando se proporciona `sessionKey`).

Parámetros:

- `raw` (string) — carga útil JSON5 que contiene solo las claves a cambiar
- `baseHash` (requerido) — hash de configuración de `config.get`
- `sessionKey` (opcional) — clave de la última sesión activa para el ping de activación
- `note` (opcional) — nota para incluir en el centinela de reinicio
- `restartDelayMs` (opcional) — retraso antes del reinicio (predeterminado 2000)

Ejemplo:

```bash
openclaw gateway call config.get --params '{}' # capture payload.hash
openclaw gateway call config.patch --params '{
  "raw": "{\\n  channels: { telegram: { groups: { \\"*\\": { requireMention: false } } } }\\n}\\n",
  "baseHash": "<hash-from-config.get>",
  "sessionKey": "agent:main:whatsapp:dm:+15555550123",
  "restartDelayMs": 1000
}'
```

## Configuración mínima (punto de partida recomendado)

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },
}
```

Construya la imagen predeterminada una vez con:

```bash
scripts/sandbox-setup.sh
```

## Modo de autochat (recomendado para control de grupos)

Para evitar que el bot responda a menciones @ de WhatsApp en grupos (responder solo a disparadores de texto específicos):

```json5
{
  agents: {
    defaults: { workspace: "~/.openclaw/workspace" },
    list: [
      {
        id: "main",
        groupChat: { mentionPatterns: ["@openclaw", "reisponde"] },
      },
    ],
  },
  channels: {
    whatsapp: {
      // Allowlist is DMs only; including your own number enables self-chat mode.
      allowFrom: ["+15555550123"],
      groups: { "*": { requireMention: true } },
    },
  },
}
```

## Inclusiones de configuración (`$include`)

Divida su configuración en varios archivos usando la directiva `$include`. Esto es útil para:

- Organizar configuraciones grandes (p. ej., definiciones de agentes por cliente)
- Compartir ajustes comunes entre entornos
- Mantener configuraciones sensibles separadas

### Uso básico

```json5
// ~/.openclaw/openclaw.json
{
  gateway: { port: 18789 },

  // Include a single file (replaces the key's value)
  agents: { $include: "./agents.json5" },

  // Include multiple files (deep-merged in order)
  broadcast: {
    $include: ["./clients/mueller.json5", "./clients/schmidt.json5"],
  },
}
```

```json5
// ~/.openclaw/agents.json5
{
  defaults: { sandbox: { mode: "all", scope: "session" } },
  list: [{ id: "main", workspace: "~/.openclaw/workspace" }],
}
```

### Comportamiento de fusión

- **Archivo único**: Reemplaza el objeto que contiene `$include`
- **Arreglo de archivos**: Fusiona profundamente los archivos en orden (los posteriores sobrescriben a los anteriores)
- **Con claves hermanas**: Las claves hermanas se fusionan después de las inclusiones (sobrescriben valores incluidos)
- **Claves hermanas + arreglos/primitivos**: No compatible (el contenido incluido debe ser un objeto)

```json5
// Sibling keys override included values
{
  $include: "./base.json5", // { a: 1, b: 2 }
  b: 99, // Result: { a: 1, b: 99 }
}
```

### Inclusiones anidadas

Los archivos incluidos pueden contener directivas `$include` (hasta 10 niveles de profundidad):

```json5
// clients/mueller.json5
{
  agents: { $include: "./mueller/agents.json5" },
  broadcast: { $include: "./mueller/broadcast.json5" },
}
```

### Resolución de rutas

- **Rutas relativas**: Se resuelven relativas al archivo que incluye
- **Rutas absolutas**: Se usan tal cual
- **Directorios padre**: Las referencias `../` funcionan como se espera

```json5
{ "$include": "./sub/config.json5" }      // relative
{ "$include": "/etc/openclaw/base.json5" } // absolute
{ "$include": "../shared/common.json5" }   // parent dir
```

### Manejo de errores

- **Archivo faltante**: Error claro con la ruta resuelta
- **Error de parseo**: Muestra qué archivo incluido falló
- **Inclusiones circulares**: Detectadas y reportadas con la cadena de inclusión

### Ejemplo: Configuración legal multi‑cliente

```json5
// ~/.openclaw/openclaw.json
{
  gateway: { port: 18789, auth: { token: "secret" } },

  // Common agent defaults
  agents: {
    defaults: {
      sandbox: { mode: "all", scope: "session" },
    },
    // Merge agent lists from all clients
    list: { $include: ["./clients/mueller/agents.json5", "./clients/schmidt/agents.json5"] },
  },

  // Merge broadcast configs
  broadcast: {
    $include: ["./clients/mueller/broadcast.json5", "./clients/schmidt/broadcast.json5"],
  },

  channels: { whatsapp: { groupPolicy: "allowlist" } },
}
```

```json5
// ~/.openclaw/clients/mueller/agents.json5
[
  { id: "mueller-transcribe", workspace: "~/clients/mueller/transcribe" },
  { id: "mueller-docs", workspace: "~/clients/mueller/docs" },
]
```

```json5
// ~/.openclaw/clients/mueller/broadcast.json5
{
  "120363403215116621@g.us": ["mueller-transcribe", "mueller-docs"],
}
```

## Opciones comunes

### Variables de entorno + `.env`

OpenClaw lee variables de entorno del proceso padre (shell, launchd/systemd, CI, etc.).

Además, carga:

- `.env` desde el directorio de trabajo actual (si existe)
- un respaldo global `.env` desde `~/.openclaw/.env` (también conocido como `$OPENCLAW_STATE_DIR/.env`)

Ninguno de los archivos `.env` sobrescribe variables de entorno existentes.

También puede proporcionar variables de entorno en línea en la configuración. Estas solo se aplican si
el entorno del proceso no tiene la clave (misma regla de no sobrescritura):

```json5
{
  env: {
    OPENROUTER_API_KEY: "sk-or-...",
    vars: {
      GROQ_API_KEY: "gsk-...",
    },
  },
}
```

Vea [/environment](/help/environment) para la precedencia y las fuentes completas.

### `env.shellEnv` (opcional)

Comodidad opcional: si está habilitado y aún no se estableció ninguna de las claves esperadas, OpenClaw ejecuta su shell de inicio de sesión e importa solo las claves esperadas faltantes (nunca sobrescribe).
Esto equivale a cargar su perfil de shell.

```json5
{
  env: {
    shellEnv: {
      enabled: true,
      timeoutMs: 15000,
    },
  },
}
```

Equivalente por variable de entorno:

- `OPENCLAW_LOAD_SHELL_ENV=1`
- `OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000`

### Sustitución de variables de entorno en la configuración

Puede referenciar variables de entorno directamente en cualquier valor de cadena de la configuración usando
la sintaxis `${VAR_NAME}`. Las variables se sustituyen al cargar la configuración, antes de la validación.

```json5
{
  models: {
    providers: {
      "vercel-gateway": {
        apiKey: "${VERCEL_GATEWAY_API_KEY}",
      },
    },
  },
  gateway: {
    auth: {
      token: "${OPENCLAW_GATEWAY_TOKEN}",
    },
  },
}
```

**Reglas:**

- Solo se reconocen nombres de variables en mayúsculas: `[A-Z_][A-Z0-9_]*`
- Variables faltantes o vacías provocan un error al cargar la configuración
- Escape con `$${VAR}` para producir un `${VAR}` literal
- Funciona con `$include` (los archivos incluidos también reciben sustitución)

**Sustitución en línea:**

```json5
{
  models: {
    providers: {
      custom: {
        baseUrl: "${CUSTOM_API_BASE}/v1", // → "https://api.example.com/v1"
      },
    },
  },
}
```

### Almacenamiento de autenticación (OAuth + claves de API)

OpenClaw almacena perfiles de autenticación **por agente** (OAuth + claves de API) en:

- `<agentDir>/auth-profiles.json` (predeterminado: `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`)

Vea también: [/concepts/oauth](/concepts/oauth)

Importaciones OAuth heredadas:

- `~/.openclaw/credentials/oauth.json` (o `$OPENCLAW_STATE_DIR/credentials/oauth.json`)

El agente Pi integrado mantiene una caché de tiempo de ejecución en:

- `<agentDir>/auth.json` (administrada automáticamente; no edite manualmente)

Directorio heredado del agente (antes de multi‑agente):

- `~/.openclaw/agent/*` (migrado por `openclaw doctor` a `~/.openclaw/agents/<defaultAgentId>/agent/*`)

Anulaciones:

- Directorio OAuth (solo importación heredada): `OPENCLAW_OAUTH_DIR`
- Directorio de agente (anulación de la raíz del agente predeterminado): `OPENCLAW_AGENT_DIR` (preferido), `PI_CODING_AGENT_DIR` (heredado)

En el primer uso, OpenClaw importa las entradas `oauth.json` en `auth-profiles.json`.

### `auth`

Metadatos opcionales para perfiles de autenticación. **No** almacena secretos; asigna
IDs de perfil a un proveedor + modo (y correo electrónico opcional) y define el orden
de rotación de proveedores usado para conmutación por error.

```json5
{
  auth: {
    profiles: {
      "anthropic:me@example.com": { provider: "anthropic", mode: "oauth", email: "me@example.com" },
      "anthropic:work": { provider: "anthropic", mode: "api_key" },
    },
    order: {
      anthropic: ["anthropic:me@example.com", "anthropic:work"],
    },
  },
}
```

### `agents.list[].identity`

Identidad opcional por agente usada para valores predeterminados y UX. La escribe el asistente de incorporación de macOS.

Si se establece, OpenClaw deriva valores predeterminados (solo cuando no los ha establecido explícitamente):

- `messages.ackReaction` a partir del `identity.emoji` del **agente activo** (retrocede a 👀)
- `agents.list[].groupChat.mentionPatterns` a partir del `identity.name`/`identity.emoji` del agente (para que “@Samantha” funcione en grupos en Telegram/Slack/Discord/Google Chat/iMessage/WhatsApp)
- `identity.avatar` acepta una ruta de imagen relativa al espacio de trabajo o una URL remota/data URL. Los archivos locales deben residir dentro del espacio de trabajo del agente.

`identity.avatar` acepta:

- Ruta relativa al espacio de trabajo (debe permanecer dentro del espacio del agente)
- URL `http(s)`
- URI `data:`

```json5
{
  agents: {
    list: [
      {
        id: "main",
        identity: {
          name: "Samantha",
          theme: "helpful sloth",
          emoji: "🦥",
          avatar: "avatars/samantha.png",
        },
      },
    ],
  },
}
```

### `wizard`

Metadatos escritos por asistentes de la CLI (`onboard`, `configure`, `doctor`).

```json5
{
  wizard: {
    lastRunAt: "2026-01-01T00:00:00.000Z",
    lastRunVersion: "2026.1.4",
    lastRunCommit: "abc1234",
    lastRunCommand: "configure",
    lastRunMode: "local",
  },
}
```

### `logging`

- Archivo de registro predeterminado: `/tmp/openclaw/openclaw-YYYY-MM-DD.log`
- Si desea una ruta estable, establezca `logging.file` en `/tmp/openclaw/openclaw.log`.
- La salida de consola puede ajustarse por separado mediante:
  - `logging.consoleLevel` (predeterminado `info`, aumenta a `debug` cuando `--verbose`)
  - `logging.consoleStyle` (`pretty` | `compact` | `json`)
- Los resúmenes de herramientas pueden redactarse para evitar filtraciones de secretos:
  - `logging.redactSensitive` (`off` | `tools`, predeterminado: `tools`)
  - `logging.redactPatterns` (arreglo de cadenas regex; sobrescribe los valores predeterminados)

```json5
{
  logging: {
    level: "info",
    file: "/tmp/openclaw/openclaw.log",
    consoleLevel: "info",
    consoleStyle: "pretty",
    redactSensitive: "tools",
    redactPatterns: [
      // Example: override defaults with your own rules.
      "\\bTOKEN\\b\\s*[=:]\\s*([\"']?)([^\\s\"']+)\\1",
      "/\\bsk-[A-Za-z0-9_-]{8,}\\b/gi",
    ],
  },
}
```

### `channels.whatsapp.dmPolicy`

Controla cómo se manejan los chats directos (DMs) de WhatsApp:

- `"pairing"` (predeterminado): remitentes desconocidos reciben un código de emparejamiento; el propietario debe aprobar
- `"allowlist"`: solo permitir remitentes en `channels.whatsapp.allowFrom` (o en el almacén de permitidos emparejados)
- `"open"`: permitir todos los DMs entrantes (**requiere** que `channels.whatsapp.allowFrom` incluya `"*"`)
- `"disabled"`: ignorar todos los DMs entrantes

Los códigos de emparejamiento expiran después de 1 hora; el bot solo envía un código cuando se crea una nueva solicitud. Las solicitudes de emparejamiento DM pendientes se limitan a **3 por canal** de forma predeterminada.

Aprobaciones de emparejamiento:

- `openclaw pairing list whatsapp`
- `openclaw pairing approve whatsapp <code>`

### `channels.whatsapp.allowFrom`

Lista de permitidos de números telefónicos E.164 que pueden activar respuestas automáticas de WhatsApp (**solo DMs**).
Si está vacía y `channels.whatsapp.dmPolicy="pairing"`, los remitentes desconocidos recibirán un código de emparejamiento.
Para grupos, use `channels.whatsapp.groupPolicy` + `channels.whatsapp.groupAllowFrom`.

```json5
{
  channels: {
    whatsapp: {
      dmPolicy: "pairing", // pairing | allowlist | open | disabled
      allowFrom: ["+15555550123", "+447700900123"],
      textChunkLimit: 4000, // optional outbound chunk size (chars)
      chunkMode: "length", // optional chunking mode (length | newline)
      mediaMaxMb: 50, // optional inbound media cap (MB)
    },
  },
}
```

### `channels.whatsapp.sendReadReceipts`

Controla si los mensajes entrantes de WhatsApp se marcan como leídos (doble marca azul). Predeterminado: `true`.

El modo de autochat siempre omite los recibos de lectura, incluso cuando está habilitado.

Anulación por cuenta: `channels.whatsapp.accounts.<id>.sendReadReceipts`.

```json5
{
  channels: {
    whatsapp: { sendReadReceipts: false },
  },
}
```

### `channels.whatsapp.accounts` (multicuenta)

Ejecute varias cuentas de WhatsApp en un solo gateway:

```json5
{
  channels: {
    whatsapp: {
      accounts: {
        default: {}, // optional; keeps the default id stable
        personal: {},
        biz: {
          // Optional override. Default: ~/.openclaw/credentials/whatsapp/biz
          // authDir: "~/.openclaw/credentials/whatsapp/biz",
        },
      },
    },
  },
}
```

Notas:

- Los comandos salientes usan por defecto la cuenta `default` si está presente; de lo contrario, el primer ID de cuenta configurado (ordenado).
- El directorio de autenticación Baileys heredado de cuenta única se migra por `openclaw doctor` a `whatsapp/default`.

### `channels.telegram.accounts` / `channels.discord.accounts` / `channels.googlechat.accounts` / `channels.slack.accounts` / `channels.mattermost.accounts` / `channels.signal.accounts` / `channels.imessage.accounts`

Ejecute múltiples cuentas por canal (cada cuenta tiene su propio `accountId` y `name` opcional):

```json5
{
  channels: {
    telegram: {
      accounts: {
        default: {
          name: "Primary bot",
          botToken: "123456:ABC...",
        },
        alerts: {
          name: "Alerts bot",
          botToken: "987654:XYZ...",
        },
      },
    },
  },
}
```

Notas:

- Se usa `default` cuando se omite `accountId` (CLI + enrutamiento).
- Los tokens de entorno solo aplican a la **cuenta predeterminada**.
- Los ajustes base del canal (política de grupos, control de menciones, etc.) aplican a todas las cuentas a menos que se anulen por cuenta.
- Use `bindings[].match.accountId` para enrutar cada cuenta a un agents.defaults diferente.

### Control de menciones en chats de grupo (`agents.list[].groupChat` + `messages.groupChat`)

Los mensajes de grupo requieren **mención obligatoria** de forma predeterminada (ya sea mención por metadatos o patrones regex). Aplica a grupos de WhatsApp, Telegram, Discord, Google Chat e iMessage.

**Tipos de mención:**

- **Menciones por metadatos**: menciones @ nativas de la plataforma (p. ej., tocar para mencionar en WhatsApp). Se ignoran en el modo de autochat de WhatsApp (ver `channels.whatsapp.allowFrom`).
- **Patrones de texto**: patrones regex definidos en `agents.list[].groupChat.mentionPatterns`. Siempre se verifican independientemente del modo de autochat.
- El control de menciones solo se aplica cuando la detección de menciones es posible (menciones nativas o al menos un `mentionPattern`).

```json5
{
  messages: {
    groupChat: { historyLimit: 50 },
  },
  agents: {
    list: [{ id: "main", groupChat: { mentionPatterns: ["@openclaw", "openclaw"] } }],
  },
}
```

`messages.groupChat.historyLimit` establece el valor predeterminado global para el contexto de historial de grupo. Los canales pueden anularlo con `channels.<channel>.historyLimit` (o `channels.<channel>.accounts.*.historyLimit` para multicuenta). Establezca `0` para deshabilitar el envoltorio de historial.

#### Límites de historial en DM

Las conversaciones DM usan historial basado en sesiones administrado por el agente. Puede limitar el número de turnos del usuario retenidos por sesión DM:

```json5
{
  channels: {
    telegram: {
      dmHistoryLimit: 30, // limit DM sessions to 30 user turns
      dms: {
        "123456789": { historyLimit: 50 }, // per-user override (user ID)
      },
    },
  },
}
```

Orden de resolución:

1. Anulación por DM: `channels.<provider>.dms[userId].historyLimit`
2. Predeterminado del proveedor: `channels.<provider>.dmHistoryLimit`
3. Sin límite (se conserva todo el historial)

Proveedores compatibles: `telegram`, `whatsapp`, `discord`, `slack`, `signal`, `imessage`, `msteams`.

Anulación por agente (tiene prioridad cuando se establece, incluso `[]`):

```json5
{
  agents: {
    list: [
      { id: "work", groupChat: { mentionPatterns: ["@workbot", "\\+15555550123"] } },
      { id: "personal", groupChat: { mentionPatterns: ["@homebot", "\\+15555550999"] } },
    ],
  },
}
```

Los valores predeterminados de control de menciones viven por canal (`channels.whatsapp.groups`, `channels.telegram.groups`, `channels.imessage.groups`, `channels.discord.guilds`). Cuando se establece `*.groups`, también actúa como lista de permitidos de grupos; incluya `"*"` para permitir todos los grupos.

Para responder **solo** a disparadores de texto específicos (ignorando menciones @ nativas):

```json5
{
  channels: {
    whatsapp: {
      // Include your own number to enable self-chat mode (ignore native @-mentions).
      allowFrom: ["+15555550123"],
      groups: { "*": { requireMention: true } },
    },
  },
  agents: {
    list: [
      {
        id: "main",
        groupChat: {
          // Only these text patterns will trigger responses
          mentionPatterns: ["reisponde", "@openclaw"],
        },
      },
    ],
  },
}
```

### Política de grupos (por canal)

Use `channels.*.groupPolicy` para controlar si se aceptan mensajes de grupos/salas:

```json5
{
  channels: {
    whatsapp: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15551234567"],
    },
    telegram: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["tg:123456789", "@alice"],
    },
    signal: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15551234567"],
    },
    imessage: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["chat_id:123"],
    },
    msteams: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["user@org.com"],
    },
    discord: {
      groupPolicy: "allowlist",
      guilds: {
        GUILD_ID: {
          channels: { help: { allow: true } },
        },
      },
    },
    slack: {
      groupPolicy: "allowlist",
      channels: { "#general": { allow: true } },
    },
  },
}
```

Notas:

- `"open"`: los grupos omiten listas de permitidos; el control de menciones sigue aplicando.
- `"disabled"`: bloquear todos los mensajes de grupos/salas.
- `"allowlist"`: permitir solo grupos/salas que coincidan con la lista de permitidos configurada.
- `channels.defaults.groupPolicy` establece el valor predeterminado cuando el `groupPolicy` de un proveedor no está configurado.
- WhatsApp/Telegram/Signal/iMessage/Microsoft Teams usan `groupAllowFrom` (respaldo: `allowFrom` explícito).
- Discord/Slack usan listas de permitidos de canal (`channels.discord.guilds.*.channels`, `channels.slack.channels`).
- Los DMs de grupo (Discord/Slack) siguen controlados por `dm.groupEnabled` + `dm.groupChannels`.
- El valor predeterminado es `groupPolicy: "allowlist"` (a menos que lo anule `channels.defaults.groupPolicy`); si no se configura una lista de permitidos, los mensajes de grupo se bloquean.

### Enrutamiento multi‑agente (`agents.list` + `bindings`)

Ejecute múltiples agentes aislados (espacio de trabajo separado, `agentDir`, sesiones) dentro de un Gateway.
Los mensajes entrantes se enrutan a un agente mediante enlaces.

- `agents.list[]`: anulaciones por agente.
  - `id`: ID estable del agente (requerido).
  - `default`: opcional; cuando se establecen varios, gana el primero y se registra una advertencia.
    Si no se establece ninguno, la **primera entrada** de la lista es el agente predeterminado.
  - `name`: nombre visible del agente.
  - `workspace`: `~/.openclaw/workspace-<agentId>` predeterminado (para `main`, retrocede a `agents.defaults.workspace`).
  - `agentDir`: `~/.openclaw/agents/<agentId>/agent` predeterminado.
  - `model`: modelo predeterminado por agente, anula `agents.defaults.model` para ese agente.
    - forma de cadena: `"provider/model"`, anula solo `agents.defaults.model.primary`
    - forma de objeto: `{ primary, fallbacks }` (los retrocesos anulan `agents.defaults.model.fallbacks`; `[]` deshabilita los retrocesos globales para ese agente)
  - `identity`: nombre/tema/emoji por agente (usado para patrones de mención + reacciones de acuse).
  - `groupChat`: control de menciones por agente (`mentionPatterns`).
  - `sandbox`: configuración de sandbox por agente (anula `agents.defaults.sandbox`).
    - `mode`: `"off"` | `"non-main"` | `"all"`
    - `workspaceAccess`: `"none"` | `"ro"` | `"rw"`
    - `scope`: `"session"` | `"agent"` | `"shared"`
    - `workspaceRoot`: raíz personalizada del espacio de trabajo del sandbox
    - `docker`: anulaciones de docker por agente (p. ej., `image`, `network`, `env`, `setupCommand`, límites; se ignora cuando `scope: "shared"`)
    - `browser`: anulaciones del navegador en sandbox por agente (se ignora cuando `scope: "shared"`)
    - `prune`: anulaciones de depuración del sandbox por agente (se ignora cuando `scope: "shared"`)
  - `subagents`: valores predeterminados de sub‑agente por agente.
    - `allowAgents`: lista de permitidos de IDs de agente para `sessions_spawn` desde este agente (`["*"]` = permitir cualquiera; predeterminado: solo el mismo agente)
  - `tools`: restricciones de herramientas por agente (aplicadas antes de la política de herramientas del sandbox).
    - `profile`: perfil base de herramientas (aplicado antes de permitir/denegar)
    - `allow`: arreglo de nombres de herramientas permitidas
    - `deny`: arreglo de nombres de herramientas denegadas (la denegación prevalece)
- `agents.defaults`: valores predeterminados compartidos del agente (modelo, espacio de trabajo, sandbox, etc.).
- `bindings[]`: enruta mensajes entrantes a un `agentId`.
  - `match.channel` (requerido)
  - `match.accountId` (opcional; `*` = cualquier cuenta; omitido = cuenta predeterminada)
  - `match.peer` (opcional; `{ kind: dm|group|channel, id }`)
  - `match.guildId` / `match.teamId` (opcional; específico del canal)

Orden de coincidencia determinista:

1. `match.peer`
2. `match.guildId`
3. `match.teamId`
4. `match.accountId` (exacto, sin par/gremio/equipo)
5. `match.accountId: "*"` (a nivel de canal, sin par/gremio/equipo)
6. agente predeterminado (`agents.list[].default`, o la primera entrada de la lista, o `"main"`)

Dentro de cada nivel de coincidencia, gana la primera entrada coincidente en `bindings`.

#### Perfiles de acceso por agente (multi‑agente)

Cada agente puede llevar su propia política de sandbox + herramientas. Úselo para mezclar
niveles de acceso en un solo gateway:

- **Acceso completo** (agente personal)
- **Solo lectura** de herramientas + espacio de trabajo
- **Sin acceso al sistema de archivos** (solo herramientas de mensajería/sesión)

Vea [Sandbox y herramientas multi‑agente](/tools/multi-agent-sandbox-tools) para la precedencia
y ejemplos adicionales.

Acceso completo (sin sandbox):

```json5
{
  agents: {
    list: [
      {
        id: "personal",
        workspace: "~/.openclaw/workspace-personal",
        sandbox: { mode: "off" },
      },
    ],
  },
}
```

Herramientas de solo lectura + espacio de trabajo de solo lectura:

```json5
{
  agents: {
    list: [
      {
        id: "family",
        workspace: "~/.openclaw/workspace-family",
        sandbox: {
          mode: "all",
          scope: "agent",
          workspaceAccess: "ro",
        },
        tools: {
          allow: [
            "read",
            "sessions_list",
            "sessions_history",
            "sessions_send",
            "sessions_spawn",
            "session_status",
          ],
          deny: ["write", "edit", "apply_patch", "exec", "process", "browser"],
        },
      },
    ],
  },
}
```

Sin acceso al sistema de archivos (herramientas de mensajería/sesión habilitadas):

```json5
{
  agents: {
    list: [
      {
        id: "public",
        workspace: "~/.openclaw/workspace-public",
        sandbox: {
          mode: "all",
          scope: "agent",
          workspaceAccess: "none",
        },
        tools: {
          allow: [
            "sessions_list",
            "sessions_history",
            "sessions_send",
            "sessions_spawn",
            "session_status",
            "whatsapp",
            "telegram",
            "slack",
            "discord",
            "gateway",
          ],
          deny: [
            "read",
            "write",
            "edit",
            "apply_patch",
            "exec",
            "process",
            "browser",
            "canvas",
            "nodes",
            "cron",
            "gateway",
            "image",
          ],
        },
      },
    ],
  },
}
```

Ejemplo: dos cuentas de WhatsApp → dos agentes:

```json5
{
  agents: {
    list: [
      { id: "home", default: true, workspace: "~/.openclaw/workspace-home" },
      { id: "work", workspace: "~/.openclaw/workspace-work" },
    ],
  },
  bindings: [
    { agentId: "home", match: { channel: "whatsapp", accountId: "personal" } },
    { agentId: "work", match: { channel: "whatsapp", accountId: "biz" } },
  ],
  channels: {
    whatsapp: {
      accounts: {
        personal: {},
        biz: {},
      },
    },
  },
}
```

### `tools.agentToAgent` (opcional)

La mensajería de agente a agente es opcional:

```json5
{
  tools: {
    agentToAgent: {
      enabled: false,
      allow: ["home", "work"],
    },
  },
}
```

### `messages.queue`

Controla cómo se comportan los mensajes entrantes cuando ya hay una ejecución de agente activa.

```json5
{
  messages: {
    queue: {
      mode: "collect", // steer | followup | collect | steer-backlog (steer+backlog ok) | interrupt (queue=steer legacy)
      debounceMs: 1000,
      cap: 20,
      drop: "summarize", // old | new | summarize
      byChannel: {
        whatsapp: "collect",
        telegram: "collect",
        discord: "collect",
        imessage: "collect",
        webchat: "collect",
      },
    },
  },
}
```

### `messages.inbound`

Desacelera mensajes entrantes rápidos del **mismo remitente** para que varios mensajes consecutivos
se conviertan en un solo turno del agente. La desaceleración se limita por canal + conversación
y usa el mensaje más reciente para el encadenamiento de respuestas/IDs.

```json5
{
  messages: {
    inbound: {
      debounceMs: 2000, // 0 disables
      byChannel: {
        whatsapp: 5000,
        slack: 1500,
        discord: 1500,
      },
    },
  },
}
```

Notas:

- La desaceleración agrupa mensajes **solo de texto**; los medios/adjuntos se envían de inmediato.
- Los comandos de control (p. ej., `/queue`, `/new`) omiten la desaceleración para mantenerse independientes.

### `commands` (manejo de comandos de chat)

Controla cómo se habilitan los comandos de chat en los conectores.

```json5
{
  commands: {
    native: "auto", // register native commands when supported (auto)
    text: true, // parse slash commands in chat messages
    bash: false, // allow ! (alias: /bash) (host-only; requires tools.elevated allowlists)
    bashForegroundMs: 2000, // bash foreground window (0 backgrounds immediately)
    config: false, // allow /config (writes to disk)
    debug: false, // allow /debug (runtime-only overrides)
    restart: false, // allow /restart + gateway restart tool
    useAccessGroups: true, // enforce access-group allowlists/policies for commands
  },
}
```

Notas:

- Los comandos de texto deben enviarse como un mensaje **independiente** y usar el prefijo inicial `/` (sin alias de texto plano).
- `commands.text: false` deshabilita el análisis de mensajes de chat para comandos.
- `commands.native: "auto"` (predeterminado) activa comandos nativos para Discord/Telegram y deja Slack desactivado; los canales no compatibles permanecen solo texto.
- Establezca `commands.native: true|false` para forzar todos, o anule por canal con `channels.discord.commands.native`, `channels.telegram.commands.native`, `channels.slack.commands.native` (bool o `"auto"`). `false` borra comandos registrados previamente en Discord/Telegram al iniciar; los comandos de Slack se gestionan en la app de Slack.
- `channels.telegram.customCommands` agrega entradas adicionales al menú del bot de Telegram. Los nombres se normalizan; los conflictos con comandos nativos se ignoran.
- `commands.bash: true` habilita `! <cmd>` para ejecutar comandos del shell del host (`/bash <cmd>` también funciona como alias). Requiere `tools.elevated.enabled` y listar al remitente en `tools.elevated.allowFrom.<channel>`.
- `commands.bashForegroundMs` controla cuánto espera bash antes de pasar a segundo plano. Mientras un trabajo de bash se ejecuta, nuevas solicitudes `! <cmd>` se rechazan (una a la vez).
- `commands.config: true` habilita `/config` (lee/escribe `openclaw.json`).
- `channels.<provider>.configWrites` controla las mutaciones de configuración iniciadas por ese canal (predeterminado: true). Aplica a `/config set|unset` más migraciones automáticas específicas del proveedor (cambios de ID de supergrupo de Telegram, cambios de ID de canal de Slack).
- `commands.debug: true` habilita `/debug` (anulaciones solo en tiempo de ejecución).
- `commands.restart: true` habilita `/restart` y la acción de reinicio de la herramienta del gateway.
- `commands.useAccessGroups: false` permite que los comandos omitan listas de permitidos/políticas de grupos de acceso.
- Los comandos slash y directivas solo se respetan para **remitentes autorizados**. La autorización se deriva de
  listas de permitidos/emparejamiento del canal más `commands.useAccessGroups`.

### `web` (tiempo de ejecución del canal web de WhatsApp)

WhatsApp se ejecuta a través del canal web del gateway (Baileys Web). Se inicia automáticamente cuando existe una sesión vinculada.
Establezca `web.enabled: false` para mantenerlo desactivado de forma predeterminada.

```json5
{
  web: {
    enabled: true,
    heartbeatSeconds: 60,
    reconnect: {
      initialMs: 2000,
      maxMs: 120000,
      factor: 1.4,
      jitter: 0.2,
      maxAttempts: 0,
    },
  },
}
```

### `channels.telegram` (transporte del bot)

OpenClaw inicia Telegram solo cuando existe una sección de configuración `channels.telegram`. El token del bot se resuelve desde `channels.telegram.botToken` (o `channels.telegram.tokenFile`), con `TELEGRAM_BOT_TOKEN` como respaldo para la cuenta predeterminada.
Establezca `channels.telegram.enabled: false` para deshabilitar el inicio automático.
La compatibilidad multicuenta vive bajo `channels.telegram.accounts` (ver la sección multicuenta arriba). Los tokens de entorno solo aplican a la cuenta predeterminada.
Establezca `channels.telegram.configWrites: false` para bloquear escrituras de configuración iniciadas por Telegram (incluidas migraciones de ID de supergrupo y `/config set|unset`).

```json5
{
  channels: {
    telegram: {
      enabled: true,
      botToken: "your-bot-token",
      dmPolicy: "pairing", // pairing | allowlist | open | disabled
      allowFrom: ["tg:123456789"], // optional; "open" requires ["*"]
      groups: {
        "*": { requireMention: true },
        "-1001234567890": {
          allowFrom: ["@admin"],
          systemPrompt: "Keep answers brief.",
          topics: {
            "99": {
              requireMention: false,
              skills: ["search"],
              systemPrompt: "Stay on topic.",
            },
          },
        },
      },
      customCommands: [
        { command: "backup", description: "Git backup" },
        { command: "generate", description: "Create an image" },
      ],
      historyLimit: 50, // include last N group messages as context (0 disables)
      replyToMode: "first", // off | first | all
      linkPreview: true, // toggle outbound link previews
      streamMode: "partial", // off | partial | block (draft streaming; separate from block streaming)
      draftChunk: {
        // optional; only for streamMode=block
        minChars: 200,
        maxChars: 800,
        breakPreference: "paragraph", // paragraph | newline | sentence
      },
      actions: { reactions: true, sendMessage: true }, // tool action gates (false disables)
      reactionNotifications: "own", // off | own | all
      mediaMaxMb: 5,
      retry: {
        // outbound retry policy
        attempts: 3,
        minDelayMs: 400,
        maxDelayMs: 30000,
        jitter: 0.1,
      },
      network: {
        // transport overrides
        autoSelectFamily: false,
      },
      proxy: "socks5://localhost:9050",
      webhookUrl: "https://example.com/telegram-webhook", // requires webhookSecret
      webhookSecret: "secret",
      webhookPath: "/telegram-webhook",
    },
  },
}
```

Notas de streaming en borrador:

- Usa `sendMessageDraft` de Telegram (burbuja de borrador, no un mensaje real).
- Requiere **temas de chat privado** (message_thread_id en DMs; el bot tiene temas habilitados).
- `/reasoning stream` transmite el razonamiento al borrador y luego envía la respuesta final.
  Los valores predeterminados y el comportamiento de la política de reintentos están documentados en [Política de reintentos](/concepts/retry).

### `channels.discord` (transporte del bot)

Configure el bot de Discord estableciendo el token del bot y el control opcional:
La compatibilidad multicuenta vive bajo `channels.discord.accounts` (ver la sección multicuenta arriba). Los tokens de entorno solo aplican a la cuenta predeterminada.

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: "your-bot-token",
      mediaMaxMb: 8, // clamp inbound media size
      allowBots: false, // allow bot-authored messages
      actions: {
        // tool action gates (false disables)
        reactions: true,
        stickers: true,
        polls: true,
        permissions: true,
        messages: true,
        threads: true,
        pins: true,
        search: true,
        memberInfo: true,
        roleInfo: true,
        roles: false,
        channelInfo: true,
        voiceStatus: true,
        events: true,
        moderation: false,
      },
      replyToMode: "off", // off | first | all
      dm: {
        enabled: true, // disable all DMs when false
        policy: "pairing", // pairing | allowlist | open | disabled
        allowFrom: ["1234567890", "steipete"], // optional DM allowlist ("open" requires ["*"])
        groupEnabled: false, // enable group DMs
        groupChannels: ["openclaw-dm"], // optional group DM allowlist
      },
      guilds: {
        "123456789012345678": {
          // guild id (preferred) or slug
          slug: "friends-of-openclaw",
          requireMention: false, // per-guild default
          reactionNotifications: "own", // off | own | all | allowlist
          users: ["987654321098765432"], // optional per-guild user allowlist
          channels: {
            general: { allow: true },
            help: {
              allow: true,
              requireMention: true,
              users: ["987654321098765432"],
              skills: ["docs"],
              systemPrompt: "Short answers only.",
            },
          },
        },
      },
      historyLimit: 20, // include last N guild messages as context
      textChunkLimit: 2000, // optional outbound text chunk size (chars)
      chunkMode: "length", // optional chunking mode (length | newline)
      maxLinesPerMessage: 17, // soft max lines per message (Discord UI clipping)
      retry: {
        // outbound retry policy
        attempts: 3,
        minDelayMs: 500,
        maxDelayMs: 30000,
        jitter: 0.1,
      },
    },
  },
}
```

OpenClaw inicia Discord solo cuando existe una sección de configuración `channels.discord`. El token se resuelve desde `channels.discord.token`, con `DISCORD_BOT_TOKEN` como respaldo para la cuenta predeterminada (a menos que `channels.discord.enabled` sea `false`). Use `user:<id>` (DM) o `channel:<id>` (canal de gremio) al especificar destinos de entrega para comandos cron/CLI; los IDs numéricos sin prefijo son ambiguos y se rechazan.
Los slugs de gremio están en minúsculas con espacios reemplazados por `-`; las claves de canal usan el nombre del canal con slug (sin `#` inicial). Prefiera IDs de gremio como claves para evitar ambigüedad por renombres.
Los mensajes creados por el bot se ignoran de forma predeterminada. Habilítelos con `channels.discord.allowBots` (los mensajes propios aún se filtran para evitar bucles de autorrespuesta).
Modos de notificación de reacciones:

- `off`: sin eventos de reacción.
- `own`: reacciones en los mensajes propios del bot (predeterminado).
- `all`: todas las reacciones en todos los mensajes.
- `allowlist`: reacciones de `guilds.<id>.users` en todos los mensajes (lista vacía deshabilita).
  El texto saliente se fragmenta por `channels.discord.textChunkLimit` (predeterminado 2000). Establezca `channels.discord.chunkMode="newline"` para dividir por líneas en blanco (límites de párrafo) antes de fragmentar por longitud. Los clientes de Discord pueden recortar mensajes muy altos, por lo que `channels.discord.maxLinesPerMessage` (predeterminado 17) divide respuestas multilínea largas incluso cuando están por debajo de 2000 caracteres.
  Los valores predeterminados y el comportamiento de la política de reintentos están documentados en [Política de reintentos](/concepts/retry).

### `channels.googlechat` (webhook de Chat API)

Google Chat se ejecuta sobre webhooks HTTP con autenticación a nivel de aplicación (cuenta de servicio).
La compatibilidad multicuenta vive bajo `channels.googlechat.accounts` (ver la sección multicuenta arriba). Las variables de entorno solo aplican a la cuenta predeterminada.

```json5
{
  channels: {
    googlechat: {
      enabled: true,
      serviceAccountFile: "/path/to/service-account.json",
      audienceType: "app-url", // app-url | project-number
      audience: "https://gateway.example.com/googlechat",
      webhookPath: "/googlechat",
      botUser: "users/1234567890", // optional; improves mention detection
      dm: {
        enabled: true,
        policy: "pairing", // pairing | allowlist | open | disabled
        allowFrom: ["users/1234567890"], // optional; "open" requires ["*"]
      },
      groupPolicy: "allowlist",
      groups: {
        "spaces/AAAA": { allow: true, requireMention: true },
      },
      actions: { reactions: true },
      typingIndicator: "message",
      mediaMaxMb: 20,
    },
  },
}
```

Notas:

- El JSON de la cuenta de servicio puede ser en línea (`serviceAccount`) o basado en archivo (`serviceAccountFile`).
- Respaldos de entorno para la cuenta predeterminada: `GOOGLE_CHAT_SERVICE_ACCOUNT` o `GOOGLE_CHAT_SERVICE_ACCOUNT_FILE`.
- `audienceType` + `audience` deben coincidir con la configuración de autenticación del webhook de la app de Chat.
- Use `spaces/<spaceId>` o `users/<userId|email>` al establecer destinos de entrega.

### `channels.slack` (modo socket)

Slack se ejecuta en Modo Socket y requiere tanto un token de bot como un token de app:

```json5
{
  channels: {
    slack: {
      enabled: true,
      botToken: "xoxb-...",
      appToken: "xapp-...",
      dm: {
        enabled: true,
        policy: "pairing", // pairing | allowlist | open | disabled
        allowFrom: ["U123", "U456", "*"], // optional; "open" requires ["*"]
        groupEnabled: false,
        groupChannels: ["G123"],
      },
      channels: {
        C123: { allow: true, requireMention: true, allowBots: false },
        "#general": {
          allow: true,
          requireMention: true,
          allowBots: false,
          users: ["U123"],
          skills: ["docs"],
          systemPrompt: "Short answers only.",
        },
      },
      historyLimit: 50, // include last N channel/group messages as context (0 disables)
      allowBots: false,
      reactionNotifications: "own", // off | own | all | allowlist
      reactionAllowlist: ["U123"],
      replyToMode: "off", // off | first | all
      thread: {
        historyScope: "thread", // thread | channel
        inheritParent: false,
      },
      actions: {
        reactions: true,
        messages: true,
        pins: true,
        memberInfo: true,
        emojiList: true,
      },
      slashCommand: {
        enabled: true,
        name: "openclaw",
        sessionPrefix: "slack:slash",
        ephemeral: true,
      },
      textChunkLimit: 4000,
      chunkMode: "length",
      mediaMaxMb: 20,
    },
  },
}
```

La compatibilidad multicuenta vive bajo `channels.slack.accounts` (ver la sección multicuenta arriba). Los tokens de entorno solo aplican a la cuenta predeterminada.

OpenClaw inicia Slack cuando el proveedor está habilitado y ambos tokens están configurados (vía configuración o `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN`). Use `user:<id>` (DM) o `channel:<id>` al especificar destinos de entrega para comandos cron/CLI.
Establezca `channels.slack.configWrites: false` para bloquear escrituras de configuración iniciadas por Slack (incluidas migraciones de ID de canal y `/config set|unset`).

Los mensajes creados por el bot se ignoran de forma predeterminada. Habilítelos con `channels.slack.allowBots` o `channels.slack.channels.<id>.allowBots`.

Modos de notificación de reacciones:

- `off`: sin eventos de reacción.
- `own`: reacciones en los mensajes propios del bot (predeterminado).
- `all`: todas las reacciones en todos los mensajes.
- `allowlist`: reacciones de `channels.slack.reactionAllowlist` en todos los mensajes (lista vacía deshabilita).

Aislamiento de sesiones por hilo:

- `channels.slack.thread.historyScope` controla si el historial del hilo es por hilo (`thread`, predeterminado) o compartido en el canal (`channel`).
- `channels.slack.thread.inheritParent` controla si las nuevas sesiones de hilo heredan la transcripción del canal padre (predeterminado: false).

Grupos de acciones de Slack (controlan acciones de herramienta `slack`):

| Grupo de acciones | Predeterminado | Notas                          |
| ----------------- | -------------- | ------------------------------ |
| reactions         | habilitado     | Reaccionar + listar reacciones |
| messages          | habilitado     | Leer/enviar/editar/eliminar    |
| pins              | habilitado     | Anclar/desanclar/listar        |
| memberInfo        | habilitado     | Información de miembros        |
| emojiList         | habilitado     | Lista de emojis personalizados |

### `channels.mattermost` (token del bot)

Mattermost se distribuye como un plugin y no viene incluido con la instalación principal.
Instálelo primero: `openclaw plugins install @openclaw/mattermost` (o `./extensions/mattermost` desde un checkout de git).

Mattermost requiere un token de bot más la URL base de su servidor:

```json5
{
  channels: {
    mattermost: {
      enabled: true,
      botToken: "mm-token",
      baseUrl: "https://chat.example.com",
      dmPolicy: "pairing",
      chatmode: "oncall", // oncall | onmessage | onchar
      oncharPrefixes: [">", "!"],
      textChunkLimit: 4000,
      chunkMode: "length",
    },
  },
}
```

OpenClaw inicia Mattermost cuando la cuenta está configurada (token de bot + URL base) y habilitada. El token + URL base se resuelven desde `channels.mattermost.botToken` + `channels.mattermost.baseUrl` o `MATTERMOST_BOT_TOKEN` + `MATTERMOST_URL` para la cuenta predeterminada (a menos que `channels.mattermost.enabled` sea `false`).

Modos de chat:

- `oncall` (predeterminado): responder a mensajes del canal solo cuando se menciona con @.
- `onmessage`: responder a cada mensaje del canal.
- `onchar`: responder cuando un mensaje comienza con un prefijo disparador (`channels.mattermost.oncharPrefixes`, predeterminado `[">", "!"]`).

Control de acceso:

- DMs predeterminados: `channels.mattermost.dmPolicy="pairing"` (los remitentes desconocidos reciben un código de emparejamiento).
- DMs públicos: `channels.mattermost.dmPolicy="open"` más `channels.mattermost.allowFrom=["*"]`.
- Grupos: `channels.mattermost.groupPolicy="allowlist"` de forma predeterminada (controlado por menciones). Use `channels.mattermost.groupAllowFrom` para restringir remitentes.

La compatibilidad multicuenta vive bajo `channels.mattermost.accounts` (ver la sección multicuenta arriba). Las variables de entorno solo aplican a la cuenta predeterminada.
Use `channel:<id>` o `user:<id>` (o `@username`) al especificar destinos de entrega; los IDs sin prefijo se tratan como IDs de canal.

### `channels.signal` (signal-cli)

Las reacciones de Signal pueden emitir eventos del sistema (herramientas de reacción compartidas):

```json5
{
  channels: {
    signal: {
      reactionNotifications: "own", // off | own | all | allowlist
      reactionAllowlist: ["+15551234567", "uuid:123e4567-e89b-12d3-a456-426614174000"],
      historyLimit: 50, // include last N group messages as context (0 disables)
    },
  },
}
```

Modos de notificación de reacciones:

- `off`: sin eventos de reacción.
- `own`: reacciones en los mensajes propios del bot (predeterminado).
- `all`: todas las reacciones en todos los mensajes.
- `allowlist`: reacciones de `channels.signal.reactionAllowlist` en todos los mensajes (lista vacía deshabilita).

### `channels.imessage` (CLI de imsg)

OpenClaw lanza `imsg rpc` (JSON-RPC sobre stdio). No se requiere demonio ni puerto.

```json5
{
  channels: {
    imessage: {
      enabled: true,
      cliPath: "imsg",
      dbPath: "~/Library/Messages/chat.db",
      remoteHost: "user@gateway-host", // SCP for remote attachments when using SSH wrapper
      dmPolicy: "pairing", // pairing | allowlist | open | disabled
      allowFrom: ["+15555550123", "user@example.com", "chat_id:123"],
      historyLimit: 50, // include last N group messages as context (0 disables)
      includeAttachments: false,
      mediaMaxMb: 16,
      service: "auto",
      region: "US",
    },
  },
}
```

La compatibilidad multicuenta vive bajo `channels.imessage.accounts` (ver la sección multicuenta arriba).

Notas:

- Requiere Acceso Completo al Disco para la base de datos de Mensajes.
- El primer envío solicitará permiso de automatización de Mensajes.
- Prefiera destinos `chat_id:<id>`. Use `imsg chats --limit 20` para listar chats.
- `channels.imessage.cliPath` puede apuntar a un script contenedor (p. ej., `ssh` a otra Mac que ejecute `imsg rpc`); use claves SSH para evitar solicitudes de contraseña.
- Para contenedores SSH remotos, establezca `channels.imessage.remoteHost` para obtener adjuntos vía SCP cuando `includeAttachments` esté habilitado.

Ejemplo de contenedor:

```bash
#!/usr/bin/env bash
exec ssh -T gateway-host imsg "$@"
```

### `agents.defaults.workspace`

Establece el **directorio global único de espacio de trabajo** usado por el agente para operaciones de archivos.

Predeterminado: `~/.openclaw/workspace`.

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
}
```

Si `agents.defaults.sandbox` está habilitado, las sesiones no principales pueden anularlo con sus
propios espacios de trabajo por ámbito bajo `agents.defaults.sandbox.workspaceRoot`.

### `agents.defaults.repoRoot`

Raíz opcional del repositorio para mostrar en la línea Runtime del prompt del sistema. Si no se establece, OpenClaw
intenta detectar un directorio `.git` subiendo desde el espacio de trabajo (y el directorio
de trabajo actual). La ruta debe existir para usarse.

```json5
{
  agents: { defaults: { repoRoot: "~/Projects/openclaw" } },
}
```

### `agents.defaults.skipBootstrap`

Deshabilita la creación automática de los archivos de arranque del espacio de trabajo (`AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md` y `BOOTSTRAP.md`).

Use esto para despliegues presembrados donde los archivos del espacio de trabajo provienen de un repositorio.

```json5
{
  agents: { defaults: { skipBootstrap: true } },
}
```

### `agents.defaults.bootstrapMaxChars`

Máximo de caracteres de cada archivo de arranque del espacio de trabajo inyectado en el prompt del sistema
antes de truncar. Predeterminado: `20000`.

Cuando un archivo excede este límite, OpenClaw registra una advertencia e inyecta un
inicio/fin truncado con un marcador.

```json5
{
  agents: { defaults: { bootstrapMaxChars: 20000 } },
}
```

### `agents.defaults.userTimezone`

Establece la zona horaria del usuario para el **contexto del prompt del sistema** (no para marcas de tiempo en
sobres de mensajes). Si no se establece, OpenClaw usa la zona horaria del host en tiempo de ejecución.

```json5
{
  agents: { defaults: { userTimezone: "America/Chicago" } },
}
```

### `agents.defaults.timeFormat`

Controla el **formato de hora** mostrado en la sección Fecha y Hora Actual del prompt del sistema.
Predeterminado: `auto` (preferencia del SO).

```json5
{
  agents: { defaults: { timeFormat: "auto" } }, // auto | 12 | 24
}
```

### `messages`

Controla prefijos entrantes/salientes y reacciones opcionales de acuse.
Vea [Mensajes](/concepts/messages) para colas, sesiones y contexto de streaming.

```json5
{
  messages: {
    responsePrefix: "🦞", // or "auto"
    ackReaction: "👀",
    ackReactionScope: "group-mentions",
    removeAckAfterReply: false,
  },
}
```

`responsePrefix` se aplica a **todas las respuestas salientes** (resúmenes de herramientas, streaming por bloques, respuestas finales) en todos los canales a menos que ya esté presente.

Las anulaciones pueden configurarse por canal y por cuenta:

- `channels.<channel>.responsePrefix`
- `channels.<channel>.accounts.<id>.responsePrefix`

Orden de resolución (gana el más específico):

1. `channels.<channel>.accounts.<id>.responsePrefix`
2. `channels.<channel>.responsePrefix`
3. `messages.responsePrefix`

Semántica:

- `undefined` cae al siguiente nivel.
- `""` deshabilita explícitamente el prefijo y detiene la cascada.
- `"auto"` deriva `[{identity.name}]` para el agente enrutado.

Las anulaciones aplican a todos los canales, incluidas extensiones, y a cada tipo de respuesta saliente.

Si `messages.responsePrefix` no está configurado, no se aplica ningún prefijo de forma predeterminada. Las respuestas de autochat de WhatsApp
son la excepción: usan por defecto `[{identity.name}]` cuando está configurado, de lo contrario
`[openclaw]`, para que las conversaciones en el mismo teléfono sigan siendo legibles.
Establézcalo en `"auto"` para derivar `[{identity.name}]` para el agente enrutado (cuando esté configurado).

#### Variables de plantilla

La cadena `responsePrefix` puede incluir variables de plantilla que se resuelven dinámicamente:

| Variable          | Descripción                       | Ejemplo                      |
| ----------------- | --------------------------------- | ---------------------------- |
| `{model}`         | Nombre corto del modelo           | `claude-opus-4-6`, `gpt-4o`  |
| `{modelFull}`     | Identificador completo del modelo | `anthropic/claude-opus-4-6`  |
| `{provider}`      | Nombre del proveedor              | `anthropic`, `openai`        |
| `{thinkingLevel}` | Nivel de pensamiento actual       | `high`, `low`, `off`         |
| `{identity.name}` | Nombre de identidad del agente    | (igual que el modo `"auto"`) |

Las variables no distinguen mayúsculas/minúsculas (`{MODEL}` = `{model}`). `{think}` es un alias de `{thinkingLevel}`.
Las variables no resueltas permanecen como texto literal.

```json5
{
  messages: {
    responsePrefix: "[{model} | think:{thinkingLevel}]",
  },
}
```

Salida de ejemplo: `[claude-opus-4-6 | think:high] Here's my response...`

El prefijo entrante de WhatsApp se configura mediante `channels.whatsapp.messagePrefix` (obsoleto:
`messages.messagePrefix`). El valor predeterminado permanece **sin cambios**: `"[openclaw]"` cuando
`channels.whatsapp.allowFrom` está vacío; de lo contrario `""` (sin prefijo). Al usar
`"[openclaw]"`, OpenClaw usará en su lugar `[{identity.name}]` cuando el agente enrutado
tenga `identity.name` configurado.

`ackReaction` envía una reacción emoji de mejor esfuerzo para reconocer mensajes entrantes
en canales que admiten reacciones (Slack/Discord/Telegram/Google Chat). Por defecto usa el
`identity.emoji` del agente activo cuando está configurado; de lo contrario `"👀"`.
Establézcalo en `""` para deshabilitar.

`ackReactionScope` controla cuándo se disparan las reacciones:

- `group-mentions` (predeterminado): solo cuando un grupo/sala requiere menciones **y** el bot fue mencionado
- `group-all`: todos los mensajes de grupo/sala
- `direct`: solo mensajes directos
- `all`: todos los mensajes

`removeAckAfterReply` elimina la reacción de acuse del bot después de enviar una respuesta
(Slack/Discord/Telegram/Google Chat únicamente). Predeterminado: `false`.

---

_Siguiente: [Runtime del Agente](/concepts/agent)_ 🦞
