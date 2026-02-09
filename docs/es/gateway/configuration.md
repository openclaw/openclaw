---
summary: "Todas las opciones de configuración para ~/.openclaw/openclaw.json con ejemplos"
read_when:
  - Al agregar o modificar campos de configuración
title: "Configuración"
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

### Incluye anidados

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
- **Rutas absolutas**: Utilizado como es
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

### Env vars + `.env`

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

Equivalente de var Env:

- `OPENCLAW_LOAD_SHELL_ENV=1`
- `OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000`

### Sustitución de var Env en configuración

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

| Variable          | Descripción                       | Ejemplo                                         |
| ----------------- | --------------------------------- | ----------------------------------------------- |
| `{model}`         | Nombre corto del modelo           | `claude-opus-4-6`, `gpt-4o`                     |
| `{modelFull}`     | Identificador completo del modelo | `anthropic/claude-opus-4-6`                     |
| `{provider}`      | Nombre del proveedor              | `anthropic`, `openai`                           |
| `{thinkingLevel}` | Nivel de pensamiento actual       | `high`, `low`, `off`                            |
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
`identity.emoji` del agente activo cuando está configurado; de lo contrario `"👀"`. Establézcalo en `""` para deshabilitar.

`ackReactionScope` controla cuándo se disparan las reacciones:

- `group-mentions` (predeterminado): solo cuando un grupo/sala requiere menciones **y** el bot fue mencionado
- `group-all`: todos los mensajes de grupo/sala
- `direct`: solo mensajes directos
- `all`: todos los mensajes

`removeAckAfterReply` elimina la reacción de acuse del bot después de enviar una respuesta
(Slack/Discord/Telegram/Google Chat únicamente). Predeterminado: `false`.

#### `mensajes.tts`

Habilitar texto a voz para respuestas salientes. Cuando está encendido, OpenClaw genera audio
usando TACenLabs o OpenAI y lo adjunta a las respuestas. Telegram usa notas de voz Opus
; otros canales envían audio MP3.

```json5
{
  messages: {
    tts: {
      auto: "always", // off | always | inbound | tagged
      mode: "final", // final | all (include tool/block replies)
      provider: "elevenlabs",
      summaryModel: "openai/gpt-4.1-mini",
      modelOverrides: {
        enabled: true,
      },
      maxTextLength: 4000,
      timeoutMs: 30000,
      prefsPath: "~/.openclaw/settings/tts.json",
      elevenlabs: {
        apiKey: "elevenlabs_api_key",
        baseUrl: "https://api.elevenlabs.io",
        voiceId: "voice_id",
        modelId: "eleven_multilingual_v2",
        seed: 42,
        applyTextNormalization: "auto",
        languageCode: "en",
        voiceSettings: {
          stability: 0.5,
          similarityBoost: 0.75,
          style: 0.0,
          useSpeakerBoost: true,
          speed: 1.0,
        },
      },
      openai: {
        apiKey: "openai_api_key",
        model: "gpt-4o-mini-tts",
        voice: "alloy",
      },
    },
  },
}
```

Notas:

- `messages.tts.auto` controla automáticamente TTS (`off`, `siempre`, `inbound`, `tagged`).
- `/tts apagado|siempre|inbound|tagged` establece el modo automático de la sesión permanente (sobreescribe la configuración).
- `messages.tts.enabled` es legado; doctor lo migra a `messages.tts.auto`.
- `prefsPath` almacena anulaciones locales (proveedor/límite/resumen).
- `maxTextLength` es un tapón duro para la entrada TTS; los resúmenes se truncan para que encajen.
- `TextyModel` anula `agents.defaults.model.primary` para autoresumir.
  - Acepta `provider/model` o un alias de `agents.defaults.models`.
- `modelOverrides` habilita anulaciones basadas en modelos como etiquetas `[[tts:...]]` (por defecto).
- `/tts limit` y `/tts Resumy` controlan la configuración de resumen por usuario.
- Los valores `apiKey` regresan a `ELEVENLABS_API_KEY`/`XI_API_KEY` y `OPENAI_API_KEY`.
- `elevenlabs.baseUrl` anula la URL base de la API.
- `elevenlabs.voiceSettings` soporta `stability`/`similarityBoost`/`style` (0..1),
  `useSpeakerBoost`, y `speed` (0.5..2.0).

### `hablar`

Por defecto para modo Talk (macOS/iOS/Android). Los ID de voz vuelven a `ELEVENLABS_VOICE_ID` o `SAG_VOICE_ID` cuando se desactiva.
`apiKey` regresa a `ELEVENLABS_API_KEY` (o el perfil de shell de la pasarela) cuando se desactiva.
`voiceAliases` deja que las directivas de Talk usen nombres amigables (por ejemplo, `"voice":"Clawd"`).

```json5
{
  talk: {
    voiceId: "elevenlabs_voice_id",
    voiceAliases: {
      Clawd: "EXAVITQu4vr4xnSDxMaL",
      Roger: "CwhRBWXzGAHq8TQ4Fs17",
    },
    modelId: "eleven_v3",
    outputFormat: "mp3_44100_128",
    apiKey: "elevenlabs_api_key",
    interruptOnSpeech: true,
  },
}
```

### `agents.defaults`

Controla el tiempo de ejecución del agente embebido (modelo/pensando/verbose/timeouts).
`agents.defaults.models` define el catálogo de modelos configurado (y actúa como la lista permitida para `/model`).
`agents.defaults.model.primary` establece el modelo predeterminado; `agents.defaults.model.fallbacks` son fallos globales.
`agents.defaults.imageModel` es opcional y es **solo usado si el modelo principal carece de entrada de imagen**.
Cada entrada `agents.defaults.models` puede incluir:

- `alias` (atajo de modelo opcional, por ejemplo, `/opus`).
- `params` (parámetros API específicos del proveedor opcional pasaron a través de la solicitud del modelo).

`params` también se aplica a las ejecuciones de streaming (agente embebido + compacción). Claves soportadas hoy: `temperature`, `maxTokens`. Estas combinaciones con opciones de tiempo de llamada; los valores suministrados por la llamada ganan. `temperature` es un nudo avanzado: deje sin establecer a menos que sepa los valores predeterminados del modelo y necesite un cambio.

Ejemplo:

```json5
{
  agents: {
    defaults: {
      models: {
        "anthropic/claude-sonnet-4-5-20250929": {
          params: { temperature: 0.6 },
        },
        "openai/gpt-5. ": {
          parámetros: { maxTokens: 8192 },
        },
      },
    },
  },
}
```

Los modelos Z.AI GLM-4.x activan automáticamente el modo de pensamiento a menos que tú:

- establecer `--thinking off`, o
- defina `agents.defaults.models["zai/<model>"].params.thinking` usted mismo.

OpenClaw también incluye algunos abreviados de alias incorporados. Por defecto solo se aplica cuando el modelo
ya está presente en `agents.defaults.models`:

- `opus` -> `antropic/claude-opus-4-6`
- `sonnet` -> `anthropic/claude-sonnet-4-5`
- `gpt` -> `openai/gpt-5.2`
- `gpt-mini` -> `openai/gpt-5-mini`
- `gemini` -> `google/gemini-3-pro-preview`
- `gemini-flash` -> `google/gemini-3-flash-preview`

Si configura el mismo nombre de alias (mayúsculas y minúsculas), su valor gana (los valores por defecto nunca se anulan).

Ejemplo: Opus 4.6 primario con respaldo MiniMax M2.1 (alojado MiniMax):

```json5
{
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": { alias: "opus" },
        "minimax/MiniMax-M2.1": { alias: "minimax" },
      },
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["minimax/MiniMax-M2.1"],
      },
    },
  },
}
```

Autor MiniMax: establece `MINIMAX_API_KEY` (env) o configure `models.providers.minimax`.

#### `agents.defaults.cliBackends` (CLI fallback)

Los backends opcionales de CLI para operaciones de retorno de solo texto (sin llamadas de herramientas). Estos son útiles como una ruta de respaldoformat@@0
cuando los proveedores de API fallan. El paso de la imagen es compatible cuando configuras
un `imageArg` que acepta rutas de archivos.

Notas:

- Los backends de CLI son **text-first**; las herramientas siempre están deshabilitadas.
- Las sesiones son soportadas cuando `sessionArg` está establecido; los ids de sesión persisten por backend.
- Para `claude-cli`, los valores por defecto están conectados. Reemplazar la ruta del comando si PATH es mínimo
  (launchd/systemd).

Ejemplo:

```json5
{
  agents: {
    defaults: {
      cliBackends: {
        "claude-cli": {
          command: "/opt/homebrew/bin/claude",
        },
        "my-cli": {
          command: "my-cli",
          args: ["--json"],
          output: "json",
          modelArg: "--model",
          sessionArg: "--session",
          sessionMode: "existing",
          systemPromptArg: "--system",
          systemPromptWhen: "first",
          imageArg: "--image",
          imageMode: "repeat",
        },
      },
    },
  },
}
```

```json5
{
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": { alias: "Opus" },
        "anthropic/claude-sonnet-4-1": { alias: "Sonnet" },
        "openrouter/deepseek/deepseek-r1:free": {},
        "zai/glm-4.7": {
          alias: "GLM",
          params: {
            thinking: {
              type: "enabled",
              clear_thinking: false,
            },
          },
        },
      },
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: [
          "openrouter/deepseek/deepseek-r1:free",
          "openrouter/meta-llama/llama-3.3-70b-instruct:free",
        ],
      },
      imageModel: {
        primary: "openrouter/qwen/qwen-2.5-vl-72b-instruct:free",
        fallbacks: ["openrouter/google/gemini-2.0-flash-vision:free"],
      },
      thinkingDefault: "low",
      verboseDefault: "off",
      elevatedDefault: "on",
      timeoutSeconds: 600,
      mediaMaxMb: 5,
      heartbeat: {
        every: "30m",
        target: "last",
      },
      maxConcurrent: 3,
      subagents: {
        model: "minimax/MiniMax-M2.1",
        maxConcurrent: 1,
        archiveAfterMinutes: 60,
      },
      exec: {
        backgroundMs: 10000,
        timeoutSec: 1800,
        cleanupMs: 1800000,
      },
      contextTokens: 200000,
    },
  },
}
```

#### `agents.defaults.contextPruning` (tool-result poding)

`agents.defaults.contextPruning` limpia **antiguos resultados de herramientas** desde el contexto en memoria justo antes de que una solicitud sea enviada al LLM.
**no** modifica el historial de sesiones en el disco (`*.jsonl` permanece completo).

Esto pretende reducir el uso de tokens para los agentes de chatty que acumulan grandes salidas de herramientas con el tiempo.

Nivel alto:

- Nunca toca los mensajes del usuario/asistente.
- Protege los últimos mensajes de asistente `keepLastAssistants` (no se podarán los resultados de la herramienta después de ese punto).
- Protege el prefijo de la correa de arranque (nada antes de que el primer mensaje del usuario sea podado).
- Modos:
  - `adaptive`: resultados de herramientas de gran tamaño (mantener cabeza/tail) cuando la proporción de contexto estimada cruza `softTrimRatio`.
    Entonces limpia duramente los resultados de la herramienta elegible más antiguos cuando la proporción de contexto estimada cruza `hardClearRatio` **y**
    hay suficiente granel de resultado de herramientas prunable (`minPrunableTools`).
  - `agresivo`: siempre reemplaza los resultados de herramientas elegibles antes del corte con el `hardClear.placeholder` (sin comprobación de la relación).

Soft vs poda dura (qué cambios en el contexto enviado a la LLM):

- **Suave-trim**: sólo para los resultados de la herramienta _oversized_. Mantiene el principio + final e inserta `...` en el medio.
  - Before: `toolResult("…salida muy larga…")`
  - Después: `toolResult("HEAD…\n...\n…TAIL\n\n[resultado de la herramienta recortado: …]")`
- **Hard-clear**: reemplaza todo el resultado de la herramienta con el marcador de posición.
  - Before: `toolResult("…salida muy larga…")`
  - Después: `toolResult("[Contenido de la herramienta antigua borrado]")`

Notas / limitaciones actuales:

- Los resultados de la herramienta que contienen **bloques de imagen son omitidos** (nunca borrados) ahora mismo.
- La “relación de contexto” estimada se basa en **caracteres** (aproximadamente), no en tokens exactos.
- Si la sesión no contiene al menos mensajes de asistente de `keepLastAssistants` todavía, se omite la poda.
- En modo `agresivo`, `hardClear.enabled` es ignorado (los resultados de herramientas elegibles siempre son reemplazados por `hardClear.placeholder`).

Por defecto (adaptativo):

```json5
{
  agents: { defaults: { contextPruning: { mode: "adaptive" } },
}
```

Deshabilitar:

```json5
{
  agents: { defaults: { contextPruning: { mode: "off" } },
}
```

Por defecto (cuando `mode` es `"adaptive"` o `"agresiva"`):

- `keepLastAssistants`: `3`
- `softTrimRatio`: `0.3` (sólo adaptativo)
- `hardClearRatio`: `0.5` (sólo adaptativo)
- `minPrunableToolChars`: `50000` (sólo adaptativo)
- `softTrim`: `{ maxChars: 4000, headChars: 1500, tailChars: 1500 }` (solo adaptativo)
- `hardClear`: `{ enabled: true, placeholder: "[Old tool result content cleared]" }`

Ejemplo (agresivo, mínimo):

```json5
{
  agents: { defaults: { contextPruning: { mode: "aggressive" } } },
}
```

Ejemplo (sintonizado adaptativo):

```json5
{
  agents: {
    defaults: {
      contextPruning: {
        mode: "adaptive",
        keepLastAssistants: 3,
        softTrimRatio: 0. ,
        Relación de cierre duro: 0. ,
        minPrunableToolChars: 50000,
        softTrim: { maxChars: 4000, headChars: 1500, tailChars: 1500 },
        hardClear: { enabled: true, marcador de posición: "[Contenido de resultado de la herramienta antigua eliminado]" },
        // Opcional: restringir la poda a herramientas específicas (negar ganancias; soporta "*" comodín)
        herramientas: { deny: ["browser", "canvas"] },
      },
    },
  },
}
```

Vea [/concepts/session-pruning](/concepts/session-poding) para detalles de comportamiento.

#### `agents.defaults.compaction` (reserva cabecera + memoria de flush)

`agents.defaults.compaction.mode` selecciona la estrategia de resumen de compactación. Por defecto es `default`; establece `salvaguard` para habilitar resumen fragmentado para historias muy largas. Consulte [/concepts/compaction](/concepts/compaction).

`agents.defaults.compaction.reserveTokensFloor` impone un valor mínimo `reserveTokens`
para la compacción de Pi (por defecto: `20000`). Establécelo en `0` para desactivar el suelo.

`agents.defaults.compaction.memoryFlush` ejecuta un giro de agente **silencio** antes de
auto-compacción, indicando al modelo que almacene memorias durables en el disco (por ejemplo,
`memory/AAY-MM-DD.md`). Se activa cuando la estimación del token de sesión cruza un umbral blandoformat@@0
debajo del límite de compacción.

Predeterminados antiguos:

- `memoryFlush.enabled`: `true`
- `memoryFlush.softThresholdTokens`: `4000`
- `memoryFlush.prompt` / `memoryFlush.systemPrompt`: predeterminado integrado con `NO_REPLY`
- Nota: la descarga de memoria se omite cuando el espacio de trabajo de sesión es de solo lectura
  (`agents.defaults.sandbox.workspaceAccess: "ro"` o `"ninguno"`).

Ejemplo (sintonizado):

```json5
{
  agents: {
    defaults: {
      compaction: {
        mode: "salvaguard",
        reserveTokensFloor: 24000,
        memoryFlush: {
          habilitado: true,
          soft ThresholdTokens: 6000,
          systemPrompt: "Sesión cerca de la compacción. Almacena recuerdos duraderos ahora.",
          indica: "Escribe cualquier nota duradera para memorar/AAA-MM-DD. d; responder con NO_REPLY si no hay nada que almacenar. ,
        },
      },
    },
  },
}
```

Transmisión de bloques:

- `agents.defaults.blockStreamingDefault`: `"on"`/`"off"` (desactivado por defecto).

- Anulaciones del canal: `*.blockStreaming` (y variantes por cuenta) para bloquear el streaming activado/apagado.
  Los canales que no sean de Telegram requieren un `*.blockStreaming: true` explícito para habilitar las respuestas de bloques.

- `agents.defaults.blockStreamingBreak`: `"text_end"` o `"message_end"` (por defecto: text_end).

- `agents.defaults.blockStreamingChunk`: chunking suave para bloques streamed. Por defecto es
  800–1200 caracteres, prefiere saltos de párrafo (`\n\n`), luego nuevas líneas, luego frases.
  Ejemplo:

  ```json5
  {
    agents: { defaults: { blockStreamingChunk: { minChars: 800, maxChars: 1200 } } },
  }
  ```

- `agents.defaults.blockStreamingCoalesce`: combina bloques streaming antes de enviar.
  Por defecto es `{ idleMs: 1000 }` y hereda `minChars` de `blockStreamingChunk`
  con `maxChars` limitado al límite de texto del canal. Signal/Slack/Discord/Google Chat predeterminado
  a `minChars: 1500` a menos que sea reemplazado.
  Anulaciones del canal: `channels.whatsapp.blockStreamingCoalesce`, `channels.telegram.blockStreamingCoalesce`,
  `channels.discord.blockStreamingCoalesce`, `channels.slack.blockStreamingCoalesce`, `channels.msteams.blockStreamingCoalesce`,
  `channels.signal.blockStreamingCoalesce`, `channels.imessage.blockStreamingCoalesce`, `channels.msteamingCoalesce`,
  `channels.googlechat.blockStreamingCoalesce`
  (y variantes de la cuenta).

- `agents.defaults.humanDelay`: pausa aleatoriamente entre **respuestas de bloque** después de la primera.
  Modos: `off` (por defecto), `natural` (800–2500ms), `custom` (usa `minMs`/`maxMs`).
  Por agente anular: `agents.list[].humanDelay`.
  Ejemplo:

  ```json5
  {
    agents: { defaults: { humanDelay: { mode: "natural" } } },
  }
  ```

  Vea [/concepts/streaming](/concepts/streaming) para el comportamiento + detalles de chunking.

Indicadores de escritura:

- `agents.defaults.typingMode`: `"nunca" | "instantáneo" | "pensando" | "mensaje"`. Por defecto
  `instantáneo` para chats directos / menciones y `mensaje` para chats de grupo no mencionados.
- `session.typingMode`: sobreescritura por sesión para el modo.
- `agents.defaults.typingIntervalSeconds`: con qué frecuencia se actualiza la señal de escritura (por defecto: 6s).
- `session.typingIntervalSegundos`: sobreescritura por sesión para el intervalo de actualización.
  Vea [/concepts/typing-indicators](/concepts/typing-indicators) para detalles de comportamiento.

`agents.defaults.model.primary` debe establecerse como `provider/model` (por ejemplo, `anthropic/claude-opis) 4-6`).
Los alias vienen de `agents.defaults.models.*.alias` (e.g. `Opus`).
Si omites el proveedor, OpenClaw asume actualmente `antropic` como una regresión temporal de la degradación
.
Los modelos Z.AI están disponibles como `zai/<model>` (por ejemplo, `zai/glm-4.7`) y requieren
`ZAI_API_KEY` (o legado `Z_AI_API_KEY`) en el entorno.

`agents.defaults.heartbeat` configura ejecuciones latidos periódicos:

- `cada`: cadena de duración (`ms`, `s`, `m`, `h`); minutos unitarios por defecto. Predeterminado:
  `30m`. Establece `0m` para desactivar.
- `model`: modelo opcional de anulación para ejecuciones de heartbeat (`provider/model`).
- `includeReasoning`: cuando `true`, heartbeats también entregará el mensaje separado `Reasoning:` cuando esté disponible (misma forma que `/reasoning on`). Predeterminado: `false`.
- `session`: tecla opcional de sesión para controlar en qué sesión se ejecuta el latido del corazón. Por defecto: `main`.
- `to`: reemplazo opcional del destinatario (id específico del canal, p.e. E.164 para WhatsApp, id del chat para Telegram).
- `target`: canal opcional de entrega (`last`, `whatsapp`, `telegram`, `discord`, `slack`, `msteams`, `signal`, `imessage`, `ninguno`). Predeterminado: `last`.
- `prompt`: sobreescritura opcional para el cuerpo del latido del corazón (por defecto: `Leer HEARTBEAT.md si existe (contexto del espacio de trabajo). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`). Los overrides se envían literalmente; incluye una línea `Read HEARTBEAT.md` si quieres que el archivo lea.
- `ackMaxChars`: caracteres máximos permitidos después de `HEARTBEAT_OK` antes de la entrega (por defecto: 300).

Heartbeats por agente:

- Establece `agents.list[].heartbeat` para activar o anular la configuración de latido cardíaco para un agente específico.
- Si cualquier entrada de agente define `heartbeat`, **solo esos agentes** ejecutan heartbeats; por defecto
  se convierte en la línea base compartida para esos agentes.

Los heartbeats ejecutan turnos completos del agente. Los intervalos cortos queman más tokens; ten cuidado
de `cada`, mantén `HEARTBEAT.md` pequeño, y/o elige un `modelo` más barato.

`tools.exec` configura los valores de exec de fondo:

- `backgroundMs`: tiempo antes del auto-background (ms, predeterminado 10000)
- `timeoutSec`: auto-kill después de este tiempo de ejecución (segundos, por defecto 1800)
- `cleanupMs`: cuánto tiempo mantener las sesiones terminadas en memoria (ms, por defecto 18000)
- `notifyOnExit`: encolar un evento del sistema + solicitar latido al salir en segundo plano de exec (por defecto true)
- `applyPatch.enabled`: habilita el `apply_patch` experimental (sólo OpenAI/OpenAI Codex; por defecto falso)
- `applyPatch.allowModels`: lista permitida opcional de ids de modelo (por ejemplo, `gpt-5.2` o `openai/gpt-5.2`)
  Nota: `applyPatch` sólo está bajo `tools.exec`.

`tools.web` configura la búsqueda web + obtener herramientas:

- `tools.web.search.enabled` (por defecto: verdadero cuando la clave está presente)
- `tools.web.search.apiKey` (recomendado: establece a través de `openclaw configure --section web`, o usa `BRAVE_API_KEY` var)
- `tools.web.search.maxResults` (1–10, por defecto 5)
- `tools.web.search.timeoutSeconds` (predeterminado 30)
- `tools.web.search.cacheTtlMinutes` (predeterminado 15)
- `tools.web.fetch.enabled` (por defecto true)
- `tools.web.fetch.maxChars` (predeterminado 50000)
- `tools.web.fetch.maxCharsCap` (por defecto 50000; clampa maxChars de las llamadas config/tools)
- `tools.web.fetch.timeoutSeconds` (predeterminado 30)
- `tools.web.fetch.cacheTtlMinutes` (predeterminado 15)
- `tools.web.fetch.userAgent` (anulación opcional)
- `tools.web.fetch.readability` (por defecto true; deshabilita para usar sólo limpieza básica de HTML)
- `tools.web.fetch.firecrawl.enabled` (por defecto es verdad cuando se establece una clave API)
- `tools.web.fetch.firecrawl.apiKey` (opcional; por defecto `FIRECRAWL_API_KEY`)
- `tools.web.fetch.firecrawl.baseUrl` (por defecto [https://api.firecrawl.dev](https://api.firecrawl.dev))
- `tools.web.fetch.firecrawl.onlyMainContent` (por defecto true)
- `tools.web.fetch.firecrawl.maxAgeMs` (opcional)
- `tools.web.fetch.firecrawl.timeoutSeconds` (opcional)

`tools.media` configura la comprensión de medios entrantes (image/audio/video):

- `tools.media.models`: lista de modelos compartidos (capacidad etiquetada; usada después de listas por cap).
- `tools.media.concurrency`: ejecución máxima de capacidad concurrente (por defecto 2).
- `tools.media.image` / `tools.media.audio` / `tools.media.video`:
  - `enabled`: opt-out switch (predeterminado verdadero cuando los modelos están configurados).
  - `prompt`: opción de anulación del prompt (imagen/video añade una pista de `maxChars` automáticamente).
  - `maxChars`: caracteres de salida máximos (por defecto 500 para imagen/vídeo; unset para audio).
  - `maxBytes`: tamaño máximo de medios a enviar (por defecto: imagen 10MB, audio 20MB, vídeo 50MB).
  - `timeoutSegundos`: timeout de solicitud (por defecto: imagen 60s, audio 60s, video 120s).
  - `language`: pista de audio opcional.
  - `attachments`: política de adjuntos (`mode`, `maxAttachments`, `prefer`).
  - `scope`: compuerta opcional (primero coincide con ganancias) con `match.channel`, `match.chatType`, o `match.keyPrefix`.
  - `models`: lista ordenada de entradas de modelo; fallos o soportes sobredimensionados caen en la siguiente entrada.
- Cada entrada `modelos[]`:
  - Entrada del proveedor (`type: "provider"` o omitido):
    - `provider`: API provider id (`openai`, `anthropic`, `google`/`gemini`, `groq`, etc).
    - `model`: model id override (requerido para la imagen; predeterminado para `gpt-4o-mini-transcribe`/`whisper-(0)[video] v3-turbo` para proveedores de audio, y `gemini-3-flash-preview` para video).
    - `profile` / `preferredProfile`: selección de perfil de autor.
  - Entrada CLI (`type: "cli"`):
    - `command`: ejecutable a ejecutar.
    - `args`: argumentos con plantillas (soporta `{{MediaPath}}`, `{{Prompt}}`, `{{MaxChars}}`, etc).
  - `capabilities`: lista opcional (`image`, `audio`, `video`) para comprimir una entrada compartida. Por defecto al omitir: `openai`/`anthropic`/`minimax` → imagen, `google` → image+audio+video, `groq` → audio.
  - `prompt`, `maxChars`, `maxBytes`, `timeoutSegundds`, `language` puede ser anulado por entrada.

Si no hay modelos configurados (o `habilitados: false`), se omite el entendimiento; el modelo todavía recibe los archivos adjuntos originales.

La autenticación del proveedor sigue el orden de autenticación del modelo estándar (perfiles de autor, vars env como `OPENAI_API_KEY`/`GROQ_API_KEY`/`GEMINI_API_KEY`, o `models.providers.*.apiKey`).

Ejemplo:

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        maxBytes: 20971520,
        scope: {
          default: "deny",
          rules: [{ action: "allow", match: { chatType: "direct" } }],
        },
        models: [
          { provider: "openai", model: "gpt-4o-mini-transcribe" },
          { type: "cli", command: "whisper", args: ["--model", "base", "{{MediaPath}}"] },
        ],
      },
      video: {
        enabled: true,
        maxBytes: 52428800,
        models: [{ provider: "google", model: "gemini-3-flash-preview" }],
      },
    },
  },
}
```

`agents.defaults.subagents` configura los valores predeterminados de sub-agente:

- `model`: modelo predeterminado para los subagentes generados (cadena o `{ primary, fallbacks }`). Si se omite, los subagentes heredan el modelo de la persona que llama a menos que se sobreescriba por agente o por llamada.
- `maxConcurrent`: ejecución máxima de sub-agente simultáneo (por defecto 1)
- `archiveAfterMinutes`: sesiones de sub-agente autoarchivadas después de N minutos (por defecto 60; establece `0` a desactivar)
- Política de herramientas por subagente: `tools.subagents.tools.allow` / `tools.subagents.tools.deny` (negar victorias)

`tools.profile` establece una **herramienta base allowlist** antes de `tools.allow`/`tools.deny`:

- `minimal`: solo `session_status`
- `coding`: `group:fs`, `group:runtime`, `group:sessions`, `group:memory`, `image`
- `messaging`: `group:messaging`, `sessions_list`, `sessions_history`, `sessions_send`, `session_status`
- `full`: sin restricción (igual que no configurado)

Anulación por agente: `agents.list[].tools.profile`.

Ejemplo (solo mensajería por defecto, permitir también herramientas de Slack + Discord):

```json5
{
  tools: {
    profile: "messaging",
    allow: ["slack", "discord"],
  },
}
```

Ejemplo (perfil de programación, pero denegar exec/process en todas partes):

```json5
{
  tools: {
    profile: "coding",
    deny: ["group:runtime"],
  },
}
```

`tools.byProvider` te permite **restringir más** herramientas para proveedores específicos (o un único `provider/model`).
Anulación por agente: `agents.list[].tools.byProvider`.

Pedido: perfil base → perfil de proveedor → permitir / denegar políticas.
Las claves del proveedor aceptan ya sea `provider` (por ejemplo, `google-antigravity`) o `provider/model`
(por ejemplo, `openai/gpt-5.2`).

Ejemplo (mantener el perfil global de programación, pero herramientas mínimas para Google Antigravity):

```json5
{
  tools: {
    profile: "coding",
    byProvider: {
      "google-antigravity": { profile: "minimal" },
    },
  },
}
```

Ejemplo (lista permitida específica de proveedor/modelo):

```json5
{
  tools: {
    allow: ["group:fs", "group:runtime", "sessions_list"],
    byProvider: {
      "openai/gpt-5.2": { allow: ["group:fs", "sessions_list"] },
    },
  },
}
```

`tools.allow` / `tools.deny` configura una herramienta global allow/deny policy (negar ganancias).
La coincidencia es insensible a mayúsculas y minúsculas y soporta comodines `*` (`"*"` significa todas las herramientas).
Esto se aplica incluso cuando el sandbox Docker está **apagado**.

Ejemplo (desactivar navegador/lienzo en todas partes):

```json5
{
  tools: { deny: ["browser", "canvas"] },
}
```

Los grupos de herramientas (abreviados) trabajan en las políticas de herramientas **global** y **por agente**:

- `group:runtime`: `exec`, `bash`, `process`
- `group:fs`: `read`, `write`, `edit`, `apply_patch`
- `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory`: `memory_search`, `memory_get`
- `group:web`: `web_search`, `web_fetch`
- `group:ui`: `browser`, `canvas`
- `group:automation`: `cron`, `gateway`
- `group:messaging`: `message`
- `group:nodes`: `nodes`
- `group:openclaw`: todas las herramientas integradas de OpenClaw (excluye plugins de proveedores)

Controles `tools.elevated` elevados (host):

- `activado`: permitir modo elevado (por defecto verdadero)
- `allowFrom`: listas permitidas por canal (vacío = deshabilitado)
  - `whatsapp`: E.164 números
  - `telegram`: identificadores de chat o nombres de usuario
  - `discord`: identificadores de usuario o nombres de usuario (se repite a `channels.discord.dm.allowFrom` si se omite)
  - `signal`: E.164 números
  - `imessage`: manejadores/identificadores de chat
  - `webchat`: identificadores de sesión o nombres de usuario

Ejemplo:

```json5
{
  tools: {
    elevado: {
      enabled: true,
      allowFrom: {
        whatsapp: ["+15555550123"],
        discord: ["steipete", "1234567890123"],
      },
    },
  },
}
```

Anulación por agente (restricción adicional):

```json5
{
  agents: {
    list: [
      {
        id: "family", Herramientas
        : {
          elevado: { enabled: false },
        },
      },
    ],
  },
}
```

Notas:

- `tools.elevated` es la línea de base global. `agents.list[].tools.elevated` sólo puede restringir aún más (ambos deben permitir).
- `/elevated on|off|ask|full` almacena el estado por clave de sesión; las directivas en línea se aplican a un solo mensaje.
- Ejecutado `exec` se ejecuta en el anfitrión y evita el sandboxing.
- La política de herramientas sigue aplicándose; si `exec` es negada, no se puede usar elevado.

`agents.defaults.maxConcurrent` establece el número máximo de ejecuciones de agentes integrados que pueden ejecutarse en paralelo entre sesiones. Cada sesión sigue serializada (una ejecute
por clave de sesión a la vez). Predeterminado: 1.

### `agents.defaults.sandbox`

Opcional **sandbox Docker** para el agente incrustado. Dirigido a sesiones
no principales, por lo que no pueden acceder a su sistema host.

Detalles: [Sandboxing](/gateway/sandboxing)

Por defecto (si está habilitado):

- scope: `"agent"` (un contenedor + espacio de trabajo por agente)
- Imagen basada en gusanos de libros de Debian
- agente de acceso al espacio de trabajo: `workspaceAccess: "None "` (por defecto)
  - `"ninguno "`: usa un espacio de trabajo sandbox por ámbito bajo `~/.openclaw/sandboxes`
- `"ro"`: mantén el espacio de trabajo del entorno de pruebas en `/workspace`, y monta el espacio de trabajo del agente sólo en `/agent` (desactiva `write`/`edit`/`apply_patch`)
  - `"rw"`: montar el área de trabajo del agente leer/escribir en `/workspace`
- poda automática: inactivo > 24 h O antigüedad > 7 d
- política de herramientas: permitir sólo `exec`, `process`, `read`, `write`, `edit`, `apply_patch`, `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status` (denegar victorias)
  - configure a través de `tools.sandbox.tools`, sobreescribe por agente a través de `agents.list[].tools.sandbox.tools`
  - grupos de herramientas soportados en la política de sandbox: `group:runtime`, `group:fs`, `group:sessions`, `group:memory` (ver [Sandbox vs Tool Policy vs Applicated](/gateway/sandbox-vs-tool-policy-vs-elevated#tool-groups-shorthands))
- navegador opcional de arena (Chromium + CDP, observador noVNC)
- knobs: `network`, `user`, `pidsLimit`, `memory`, `cpus`, `ulimits`, `seccompProfile`, `apparmorProfile`

Advertencia: `scope: "shared"` significa un contenedor compartido y espacio de trabajo compartido. Sin
aislamiento multisesión. Usa `scope: "session"` para el aislamiento por sesión.

Legancia: `perSession` sigue soportado (`true` → `scope: "session"`,
`false` → `scope: "shared"`).

`setupCommand` ejecuta **una vez** después de que el contenedor sea creado (dentro del contenedor a través de `sh -lc`).
Para la instalación de paquetes, asegúrese de egresos de red, un root FS escribible y un usuario root.

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main", // off | non-main | all
        scope: "agent", // session | agent | shared (agent is default)
        workspaceAccess: "none", // none | ro | rw
        workspaceRoot: "~/.openclaw/sandboxes",
        docker: {
          image: "openclaw-sandbox:bookworm-slim",
          containerPrefix: "openclaw-sbx-",
          workdir: "/workspace",
          readOnlyRoot: true,
          tmpfs: ["/tmp", "/var/tmp", "/run"],
          network: "none",
          user: "1000:1000",
          capDrop: ["ALL"],
          env: { LANG: "C.UTF-8" },
          setupCommand: "apt-get update && apt-get install -y git curl jq",
          // Per-agent override (multi-agent): agents.list[].sandbox.docker.*
          pidsLimit: 256,
          memory: "1g",
          memorySwap: "2g",
          cpus: 1,
          ulimits: {
            nofile: { soft: 1024, hard: 2048 },
            nproc: 256,
          },
          seccompProfile: "/path/to/seccomp.json",
          apparmorProfile: "openclaw-sandbox",
          dns: ["1.1.1.1", "8.8.8.8"],
          extraHosts: ["internal.service:10.0.0.5"],
          binds: ["/var/run/docker.sock:/var/run/docker.sock", "/home/user/source:/source:rw"],
        },
        browser: {
          enabled: false,
          image: "openclaw-sandbox-browser:bookworm-slim",
          containerPrefix: "openclaw-sbx-browser-",
          cdpPort: 9222,
          vncPort: 5900,
          noVncPort: 6080,
          headless: false,
          enableNoVnc: true,
          allowHostControl: false,
          allowedControlUrls: ["http://10.0.0.42:18791"],
          allowedControlHosts: ["browser.lab.local", "10.0.0.42"],
          allowedControlPorts: [18791],
          autoStart: true,
          autoStartTimeoutMs: 12000,
        },
        prune: {
          idleHours: 24, // 0 disables idle pruning
          maxAgeDays: 7, // 0 disables max-age pruning
        },
      },
    },
  },
  tools: {
    sandbox: {
      tools: {
        allow: [
          "exec",
          "process",
          "read",
          "write",
          "edit",
          "apply_patch",
          "sessions_list",
          "sessions_history",
          "sessions_send",
          "sessions_spawn",
          "session_status",
        ],
        deny: ["browser", "canvas", "nodes", "cron", "discord", "gateway"],
      },
    },
  },
}
```

Construye la imagen sandbox por defecto con:

```bash
scripts/sandbox-setup.sh
```

Nota: los contenedores sandbox predeterminados a `network: "outer"`; establece `agents.defaults.sandbox.docker.network`
a `"puente"` (o tu red personalizada) si el agente necesita acceso saliente.

Nota: los archivos adjuntos entrantes se introducen en el espacio de trabajo activo en `media/inbound/*`. Con `workspaceAccess: "rw"`, esto significa que los archivos se escriben en el espacio de trabajo del agente.

Nota: `docker.binds` monta directorios de host adicionales; los enlaces globales y por agente son fusionados.

Construye la imagen opcional del navegador con:

```bash
scripts/sandbox-browser-setup.sh
```

Cuando `agents.defaults.sandbox.browser.enabled=true`, la herramienta de navegador utiliza una instancia de Chromium aislada en sandbox (CDP). Si noVNC está habilitado (por defecto cuando headless=false),
la URL de noVNC se inyecta en el prompt del sistema para que el agente pueda hacer referencia a ella.
Esto no requiere `browser.enabled` en la configuración principal; el control sandbox
URL es inyectado por sesión.

`agents.defaults.sandbox.browser.allowHostControl` (por defecto: false) permite que
sesiones enrolladas apunte explícitamente al servidor de control de navegador **host**
mediante la herramienta del navegador (`target: "host"`). Deja esto desactivado si deseas un aislamiento estricto del sandbox.

Listas de permisos para el control remoto:

- `allowedControlUrls`: URL de control exacto permitidas para `target: "custom"`.
- `allowedControlHosts`: nombres de host permitidos (sólo nombre de host, sin puerto).
- `allowedControlPorts`: puertos permitidos (por defecto: http=80, https=443).
  Por defecto: todas las listas permitidas no están definidas (sin restricción). `allowHostControl` por defecto es falso.

### `models` (proveedores personalizados + URL base)

OpenClaw utiliza el catálogo de modelos **pi-coding-agent**. Puede añadir proveedores personalizados
(LiteLLM, servidores locales compatibles con OpenAI, proxies Antrópicos, etc.) escribiendo
`~/.openclaw/agents/<agentId>/agent/models.json` o definiendo el mismo esquema dentro de tu configuración
OpenClaw bajo `models.providers`.
Vista general de proveedor por proveedor + ejemplos: [/concepts/model-providers](/concepts/model-providers).

Cuando `models.providers` está presente, OpenClaw escribe/combina un `models.json` en
`~/.openclaw/agents/<agentId>/agent/` al iniciar:

- comportamiento por defecto: **fusionar** (mantiene a los proveedores existentes, sobrescritos en el nombre)
- establecer `models.mode: "reemplazar"` para sobreescribir el contenido del archivo

Seleccione el modelo a través de `agents.defaults.model.primary` (proveedor/modelo).

```json5
{
  agents: {
    defaults: {
      model: { primary: "custom-proxy/llama-3.1-8b" },
      models: {
        "custom-proxy/llama-3.1-8b": {},
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      "custom-proxy": {
        baseUrl: "http://localhost:4000/v1",
        apiKey: "LITELLM_KEY",
        api: "openai-completions",
        models: [
          {
            id: "llama-3.1-8b",
            name: "Llama 3.1 8B",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 32000,
          },
        ],
      },
    },
  },
}
```

### Código abierto Zen (proxy multimodelo)

OpenCode Zen es una pasarela multimodelo con puntos finales por modelo. OpenClaw usa
el proveedor integrado `opencode` de pi-ai; establece `OPENCODE_API_KEY` (o
`OPENCODE_ZEN_API_KEY`) de [https://opencode.ai/auth](https://opencode.ai/auth).

Notas:

- Las referencias de modelos usan `opencode/<modelId>` (ejemplo: `opencode/claude-op)[video] 4-6`).
- Si activas una lista permitida a través de `agents.defaults.models`, añade cada modelo que planeas usar.
- Atajo: `openclaw a bordo --auth-choice opencode-zen`.

```json5
{
  agents: {
    defaults: {
      model: { primary: "opencode/claude-opichard 4-6" },
      modelos: { "opencode/claude-op)[video] 4-6": { alias: "Opus" } },
    },
  },
}
```

### Z.AI (GLM-4.7) — Soporte para alias

Los modelos Z.AI están disponibles a través del proveedor integrado `zai`. Establezca `ZAI_API_KEY`
en su entorno y haga referencia al modelo por proveedor/modelo.

Atajo: `openclaw a bordo --auth-choice zai-api-key`.

```json5
{
  agents: {
    defaults: {
      model: { primary: "zai/glm-4.7" },
      models: { "zai/glm-4.7": {} },
    },
  },
}
```

Notas:

- `z.ai/*` y `z-ai/*` son alias aceptados y normalizan a `zai/*`.
- Si `ZAI_API_KEY` no se encuentra, las peticiones a `zai/*` fallarán con un error de autenticación en tiempo de ejecución.
- Error de ejemplo: `No hay clave API para el proveedor "zai".`
- El endpoint general de la API de Z.AI es `https://api.z.ai/api/paas/v4`. Las solicitudes de codificación
  de GLM usan el endpoint de codificación dedicado `https://api.z.ai/api/coding/paas/v4`.
  El proveedor integrado `zai` utiliza el punto final de codificación. Si necesita el extremo general
  , defina un proveedor personalizado en `models.providers` con la URL base
  sobrescribir (ver la sección de proveedores personalizados de arriba).
- Usar un marcador de posición falso en docs/configs; nunca comprometer claves API reales.

### Moonshot AI (Kimi)

Usar el punto final compatible con OpenAI de Moonshot:

```json5
{
  env: { MOONSHOT_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "moonshot/kimi-k2.5" },
      models: { "moonshot/kimi-k2.5": { alias: "Kimi K2.5" } },
    },
  },
  models: {
    mode: "merge",
    providers: {
      moonshot: {
        baseUrl: "https://api.moonshot.ai/v1",
        apiKey: "${MOONSHOT_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "kimi-k2.5",
            name: "Kimi K2.5",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 256000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

Notas:

- Establece `MOONSHOT_API_KEY` en el entorno o usa `openclaw a bordo --auth-choice moonshot-api-key`.
- Modelo ref: `moonshot/kimi-k2.5`.
- Para el punto final de China, tampoco:
  - Ejecuta `openclaw a bordo --auth-choice moonshot-api-key-cn` (asistente establecerá `https://api.moonshot.cn/v1`), o
  - Configura manualmente `baseUrl: "https://api.moonshot.cn/v1"` en `models.providers.moonshot`.

### Kimi Coding

Usar el punto final de codificación Kimi de Moonshot AI (proveedor integrado compatible con Antropica):

```json5
{
  env: { KIMI_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "kimi-coding/k2p5" },
      models: { "kimi-coding/k2p5": { alias: "Kimi K2.5" } },
    },
  },
}
```

Notas:

- Establece `KIMI_API_KEY` en el entorno o usa `openclaw a bordo --auth-choice kimi-code-api-key`.
- Modelo ref: `kimi-coding/k2p5`.

### Sintético (compatible con Antrópicos)

Usa el punto final compatible con Synthetic's Anthropic:

```json5
{
  env: { SYNTHETIC_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "synthetic/hf:MiniMaxAI/MiniMax-M2.1" },
      models: { "synthetic/hf:MiniMaxAI/MiniMax-M2.1": { alias: "MiniMax M2.1" } },
    },
  },
  models: {
    mode: "merge",
    providers: {
      synthetic: {
        baseUrl: "https://api.synthetic.new/anthropic",
        apiKey: "${SYNTHETIC_API_KEY}",
        api: "anthropic-messages",
        models: [
          {
            id: "hf:MiniMaxAI/MiniMax-M2.1",
            name: "MiniMax M2.1",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 192000,
            maxTokens: 65536,
          },
        ],
      },
    },
  },
}
```

Notas:

- Establece `SYNTHETIC_API_KEY` o usa `openclaw a bordo --auth-choice synthetic-api-key`.
- Modelo ref: `synthetic/hf:MiniMaxAI/MiniMax-M2.1`.
- La URL base debe omitir `/v1` porque el cliente Antrópico lo añade.

### Modelos locales (LM Studio) — configuración recomendada

Vea [/gateway/local-models](/gateway/local-models) para la guía local actual. TL;DR: ejecuta MiniMax M2.1 a través de LM Studio Responses API con hardware serio; mantén los modelos alojados fusionados por segunda vez.

### MiniMax M2.1

Usar MiniMax M2.1 directamente sin LM Studio:

```json5
{
  agent: {
    model: { primary: "minimax/MiniMax-M2.1" },
    models: {
      "anthropic/claude-opus-4-6": { alias: "Opus" },
      "minimax/MiniMax-M2.1": { alias: "Minimax" },
    },
  },
  models: {
    mode: "merge",
    providers: {
      minimax: {
        baseUrl: "https://api.minimax.io/anthropic",
        apiKey: "${MINIMAX_API_KEY}",
        api: "anthropic-messages",
        models: [
          {
            id: "MiniMax-M2.1",
            name: "MiniMax M2.1",
            reasoning: false,
            input: ["text"],
            // Pricing: update in models.json if you need exact cost tracking.
            cost: { input: 15, output: 60, cacheRead: 2, cacheWrite: 10 },
            contextWindow: 200000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

Notas:

- Establece la variable de entorno `MINIMAX_API_KEY` o usa `openclaw a bordo --auth-choice minimax-api`.
- Modelo disponible: `MiniMax-M2.1` (por defecto).
- Actualiza los precios en `models.json` si necesitas un seguimiento exacto de costes.

### Cerebras (GLM 4.6 / 4.7)

Usar Cerebras a través de su punto final compatible con OpenAI:

```json5
{
  env: { CEREBRAS_API_KEY: "sk-... },
  agents: {
    defaults: {
      model: {
        primary: "cerebras/zai-glm-4. ",
        fallos: ["cerebras/zai-glm-4. "],
      },
      modelos: {
        "cerebras/zai-glm-4. ": { alias: "GLM 4.7 (Cerebras)" },
        "cerebras/zai-glm-4.6": { alias: "GLM 4. (Cerebras)" },
      },
    },
  },
  modelos: {
    modo: "merge",
    proveedores: {
      cerebras: {
        baseUrl: "https://api. erebras. i/v1",
        apiKey: "${CEREBRAS_API_KEY}",
        api: "openai-complettions",
        modelos: [
          { id: "zai-glm-4. ", nombre: "GLM 4. (Cerebras)" },
          { id: "zai-glm-4.6", nombre: "GLM 4. (Cerebras)" },
        ],
      },
    },
  },
}
```

Notas:

- Usa `cerebras/zai-glm-4.7` para Cerebras; usa `zai/glm-4.7` para Z.AI direct.
- Establece `CEREBRAS_API_KEY` en el entorno o la configuración.

Notas:

- APIs soportadas: `openai-completions`, `openai-responses`, `anthropic-messages`,
  `google-generative-ai`
- Usa `authHeader: true` + `headers` para necesidades de autenticación personalizadas.
- Reemplaza la raíz de configuración del agente con `OPENCLAW_AGENT_DIR` (o `PI_CODING_AGENT_DIR`)
  si quieres `models.json` almacenado en otro lugar (por defecto: `~/.openclaw/agents/main/agent`).

### `sesión`

Controla el alcance de la sesión, restablece la política, restablece los activadores y donde se escribe el almacén de sesiones.

```json5
{
  session: {
    scope: "per-sender",
    dmScope: "main",
    identityLinks: {
      alice: ["telegram:123456789", "discord:987654321012345678"],
    },
    reset: {
      modo: "daily",
      hora: 4,
      idleMinutes: 60,
    },
    resetByType: {
      hilo: { mode: "daily", atHour: 4 },
      dm: { mode: "idle", idleMinutes: 240 },
      grupo: { mode: "idle", idleMinutes: 120 },
    },
    resetTriggers: ["/new", "/reset"],
    // Por defecto ya es por agente en ~/. penclaw/agents/<agentId>/sessions/sessions.json
    // Puedes reemplazar con {agentId} templating:
    store: "~/. penclaw/agents/{agentId}/sessions/sessions.json",
    // Dirigir chats directamente al agente:<agentId>:<mainKey> (por defecto: "main").
    mainKey: "main",
    agentToAgent: {
      // Respuesta máxima de ping-pong entre requester/target (0–5).
      maxPingPongTurns: 5,
    },
    sendPolicy: {
      rules: [{ action: "deny", coincidencia: { channel: "discord", chatType: "group" } }],
      por defecto: "permitir",
    },
  },
}
```

Campos:

- `mainKey`: tecla direct-chat (predeterminado: `"main"`). Útil cuando se quiere “renombrar” el hilo principal de DM sin cambiar `agentId`.
  - Nota de Sandbox: `agents.defaults.sandbox.mode: "non-main"` utiliza esta clave para detectar la sesión principal. Cualquier clave de sesión que no coincida con `mainKey` (grupos/canales) es sandboxed.
- `dmScope`: cómo agrupar las sesiones DM (por defecto: `"main"`).
  - `main`: todas las DMs comparten la sesión principal para continuidad.
  - `per-peer`: aísla DMs por el identificador del remitente a través de los canales.
  - `por canal-par`: aislar DMs por canal + emisor (recomendado para entradas multiusuario).
  - `por cuenta-canal-par`: aislar DMs por cuenta + canal + emisor (recomendado para entradas multicuenta).
  - Modo DM seguro (recomendado): establezca `session.dmScope: "per-channel-peer"` cuando varias personas pueden DM el bot (entradas compartidas, listas de permisos multipersona, o \`dmPolicy: "open").
- `identityLinks`: mapea ids canónicos a los pares prefijados por el proveedor para que la misma persona comparta una sesión DM a través de los canales al usar `per-peer`, `per-channel-peer`, o `per-account-channel-peer`.
  - Ejemplo: `alice: ["telegram:123456789", "discord:987654321012345678"]`.
- `reset`: política de reinicio primario. Por defecto los reinicios diarios a las 4:00 AM hora local en el host de la puerta de enlace.
  - `mode`: `daily` o `idle` (por defecto: `daily` cuando `reset` está presente).
  - `atHour`: hora local (0-23) para el límite diario de reinicio.
  - `idleMinutes`: desliza la ventana inactiva en minutos. Cuando se configuran tanto el reinicio diario como la inactividad, gana el que expire primero.
- `resetByType`: sobreescritura por sesión para `dm`, `group`, y `thread`.
  - Si solo estableces `session.idleMinutes` legado sin ningún `reset`/`resetByType`, OpenClaw permanece en modo de sólo idle-only para compatibilidad con versiones anteriores.
- `heartbeatIdleMinutes`: anulación opcional de inactividad para las comprobaciones de latido cardiaco (restablecimiento diario aún se aplica cuando está activado).
- `agentToAgent.maxPingPongTurns`: vueltas máximas de respuesta entre solicitante/objetivo (0–5, por defecto 5).
- `sendPolicy.default`: `allow` o `deny` fallback cuando no coincide ninguna regla.
- `sendPolicy.rules[]`: match by `channel`, `chatType` (`direct|group|room`), or `keyPrefix` (e.g. `cron:`). Primero negar las ganancias; de lo contrario permitirá.

### `habilidades` (configuración de habilidades)

Controla la lista de permisos empaquetados, instala preferencias, carpetas de habilidades extra y anula
habilidades. Se aplica a las habilidades **empaquetadas** y `~/.openclaw/skills` (las habilidades del espacio de trabajo
todavía ganan en conflictos de nombres).

Campos:

- `allowBundled`: lista de permitidos opcional solo para skills **incluidas**. Si se establece, solo esas habilidades empaquetadas son elegibles (las habilidades gestionadas/del espacio de trabajo no se ven afectadas).
- `load.extraDirs`: directorios adicionales de Skills para escanear (menor precedencia).
- `install.preferBrew`: preferir instaladores de brew cuando estén disponibles (predeterminado: true).
- `install.nodeManager`: preferencia del instalador de node (`npm` | `pnpm` | `yarn`, por defecto: npm).
- `entries.<skillKey>`: anulaciones de configuración por habilidad.

Campos por Skill:

- `enabled`: establezca `false` para deshabilitar una Skill incluso si está integrada/instalada.
- `env`: variables de entorno inyectadas para la ejecución del agente (solo si no están ya configuradas).
- `apiKey`: conveniencia opcional para habilidades que declaran una variable env primaria (por ejemplo, `nano-banana-pro` → `GEMINI_API_KEY`).

Ejemplo:

```json5
{
  habilidades: {
    allowBundled: ["gemini", "peekaboo"],
    carga: {
      extraDirs: ["~/Projects/agent-scripts/skills", "~/Projects/oss/some-skill-pack/skills"],
    },
    instalar: {
      preferBrew: true,
      nodeManager: "npm",
    },
    entradas: {
      "nano-banana-pro": {
        apiKey: "GEMINI_KEY_HERE",
        env: {
          GEMINI_API_KEY: "GEMINI_KEY_HERE",
        },
      },
      peekaboo: { enabled: true },
      sag: { enabled: false },
    },
  },
}
```

### `plugins` (extensiones)

Controla el descubrimiento del plugin, permite/deny, y la configuración por plugin. Los plugins se cargan desde `~/.openclaw/extensions`, `<workspace>/.openclaw/extensions`, además de cualquier entrada en `plugins.load.paths`. **Los cambios en la configuración requieren un reinicio de la puerta de enlace.**
Ver [/plugin](/tools/plugin) para un uso completo.

Campos:

- `enabled`: interruptor maestro para la carga del plugin (por defecto: true).
- `permitir`: lista opcional permitida de ID de plugin; cuando se establece, sólo la carga de plugins listados.
- `deny`: lista de denegación opcional de ids del plugin (negar ganas).
- `load.paths`: archivos extra de plugins o directorios a cargar (absoluto o `~`).
- `entradas.<pluginId>`: por plugin anula.
  - `enabled`: establece `false` a desactivar.
  - `config`: objeto de configuración específico del plugin (validado por el plugin si se proporciona).

Ejemplo:

```json5
{
  plugins: {
    activado: true,
    allow: ["voice-call"],
    carga: {
      rutas: ["~/Projects/oss/voice-call-extension"],
    }, Entradas de
    : {
      "voice-call": {
        habilitado: true,
        config: {
          provider: "twilio",
        },
      },
    },
  },
}
```

### `browser` (navegador administrado por openclaw)

OpenClaw puede iniciar una instancia de Chrome/Brave/Edge/Chromium **dedicada y aislada** para openclaw y exponer un pequeño servicio de control de bucles.
Los perfiles pueden apuntar a un navegador basado en Chromium **remoto** a través de `profiles.<name>.cdpUrl`. Los perfiles
Remoto son de solo conexión (iniciar/detener/restablecer están desactivados).

`browser.cdpUrl` permanece para configuraciones legadas de un perfil único y como la base
esquema/host para perfiles que sólo establecen `cdpPort`.

Valores predeterminados:

- habilitado: `true`
- evaluateEnabled: `true` (establece `false` para desactivar `act:evaluate` y `wait --fn`)
- servicio de control: loopback sólo (puerto derivado de `gateway.port`, predeterminado `18791`)
- URL CDP: `http://127.0.0.1:18792` (servicio de control + 1, legado de un único perfil)
- color del perfil: `#FF4500` (lobster-naranja)
- Nota: el servidor de control es iniciado por el gateway en ejecución (menú OpenClaw.app o `openclaw gateway`).
- Detectar automáticamente el orden: navegador predeterminado si se basa en Chromium; de lo contrario Chrome → Brazo → Borde → Chrome Canario.

```json5
{
  browser: {
    activado: true,
    evaluateEnabled: true,
    // cdpUrl: "http://127. .0. :18792", // legado un solo perfil anular
    defaultProfile: "chrome", Perfiles
    : {
      openclaw: { cdpPort: 18800, color: "#FF4500" },
      trabajo: { cdpPort: 18801, color: "#0066CC" },
      remote: { cdpUrl: "http://10. .0.42:9222", color: "#00AA00" },
    },
    color: "#FF4500",
    // Avanzado:
    // sin cabeza: falso,
    // noSandbox: false,
    // executablePath: "/Applications/Brave Browser. pp/Contents/MacOS/Brave Browser",
    // Adjuntar solamente: false, // establecer verdadero cuando se túnel un CDP remoto a localhost
  },
}
```

### `ui` Textpearance)

Color de acento opcional utilizado por las aplicaciones nativas para el cromo de la interfaz (por ejemplo, color burbuja del Modo Talk).

Si no se establece, los clientes vuelven a caer a una luz silenciada.

```json5
{
  ui: {
    seamColor: "#FF4500", // hex (RRGGBB or #RRGGBB)
    // Optional: Control UI assistant identity override.
    // If unset, the Control UI uses the active agent identity (config or IDENTITY.md).
    assistant: {
      name: "OpenClaw",
      avatar: "CB", // emoji, short text, or image URL/data URI
    },
  },
}
```

### `gateway` (modo servidor Gateway + bind)

Usa `gateway.mode` para declarar explícitamente si esta máquina debe ejecutar la puerta de enlace.

Valores predeterminados:

- modo: **unset** (tratado como “no auto-iniciar”)
- bind: `loopback`
- puerto: `18789` (puerto único para WS + HTTP)

```json5
{
  gateway: {
    mode: "local", // o "remote"
    port: 18789, // WS + HTTP multiplex
    bind: "loopback",
    // controlUi: { enabled: true, basePath: "/openclaw" }
    // auth: { mode: "token", token: "your-token" } // token compuerta WS + Control UI access
    // tailscale: { mode: "off" | "serve" | "funnel" }
  },
}
```

Controlar ruta base de la interfaz de usuario:

- `gateway.controlUi.basePath` establece el prefijo URL donde se sirve la interfaz de control.
- Ejemplos: `"/ui"`, `"/openclaw"`, `"/apps/openclaw"`.
- Por defecto: root (`/`) (sin cambiar).
- `gateway.controlUi.root` establece la raíz del sistema de archivos para los activos de la interfaz de control (por defecto: `dist/control-ui`).
- `gateway.controlUi.allowInsecureAuth` permite la autenticación de sólo token-only para la interfaz de control cuando se omite la identidad del dispositivo
  (normalmente sobre HTTP). Predeterminado: `false`. HTTPS preferidos
  (Servicio de escala) o `127.0.0.1`.
- `gateway.controlUi.dangerouslyDisableDeviceAuth` deshabilita las verificaciones de identidad del dispositivo para la interfaz de control
  (sólo token/contraseña). Predeterminado: `false`. Solo rompe vidrio.

Documentación relacionada:

- [UI de control](/web/control-ui)
- [Vista general de la Web](/web)
- [Tailscale](/gateway/tailscale)
- [Acceso remoto](/gateway/remote)

Proxies de confianza:

- `gateway.trustedProxies`: lista de IP proxy inversa que terminan TLS delante de la puerta de enlace.
- Cuando una conexión viene de una de estas IPs, OpenClaw usa `x-forwarded-for` (o `x-real-ip`) para determinar la IP del cliente para comprobaciones de emparejamiento locales y comprobaciones HTTP auth/local.
- Sólo listar los proxies que controlas completamente, y asegurarse de que **sobreescriban** entrante `x-forwarded-for`.

Notas:

- `openclaw gateway` se niega a iniciar a menos que `gateway.mode` esté establecido en `local` (o que pases la bandera de anulación).
- `gateway.port` controla el puerto multiplexado único usado para WebSocket + HTTP (interfaz de control, ganchos, A2UI).
- Finalizaciones de OpenAI Chat: **desactivado por defecto**; habilitar con `gateway.http.endpoints.chatCompletions.enabled: true`.
- Precedencia: `--port` > `OPENCLAW_GATEWAY_PORT` > `gateway.port` > por defecto `18789`.
- La autenticación de la pasarela es requerida por defecto (identificación del token/contraseña o escala de engranaje Serve). Los enlaces no-loopback requieren un token o contraseña compartidos.
- El asistente de incorporación genera un token de puerta de enlace por defecto (incluso en bucle).
- `gateway.remote.token` es **sólo** para llamadas remotas a CLI; no habilita la autenticación de puerta de enlace local. `gateway.token` es ignorado.

Auth y escala posterior:

- `gateway.auth.mode` establece los requisitos de handshake (`token` o `password`). Cuando no se establece, la autenticación de token es asumida.
- `gateway.auth.token` almacena el token compartido para autenticación de token (usado por el CLI en la misma máquina).
- Cuando se establece `gateway.auth.mode`, sólo se acepta ese método (además de cabeceras opcionales escala de carácter).
- `gateway.auth.password` puede establecerse aquí, o a través de `OPENCLAW_GATEWAY_PASSWORD` (recomendado).
- `gateway.auth.allowus-scale` permite que las cabeceras de identidad de Serve
  (`tailscale-user-login`) satisfagan la autenticación cuando la solicitud llega en bucle
  con `x-forwarded-for`, `x-forwarded-proto`, y `x-forwarded-host`. OpenClaw
  verifica la identidad resolviendo la dirección `x-forwarded-for` vía
  `tailscale whois` antes de aceptarla. Cuando es `true`, las solicitudes de Serve no necesitan
  un token/contraseña; establece `false` para requerir credenciales explícitas. Por defecto a
  `true` cuando `tailscale.mode = "serve"` y el modo de autenticación no es `password`.
- `gateway.tailscale.mode: "serve"` utiliza la escala de menú Serve (sólo tailnet, enlace de loopback).
- `gateway.tailscale.mode: "funnel"` expone el panel públicamente; requiere autenticación.
- `gateway.tailscale.resetOnExit` reinicia la configuración Serve/Funnel al apagar.

Cliente remoto por defecto (CLI):

- `gateway.remote.url` establece la URL predeterminada de Gateway WebSocket para llamadas CLI cuando `gateway.mode = "remote"`.
- `gateway.remote.transport` selecciona el transporte remoto macOS (por defecto `ssh`, `direct` para ws/wss). Cuando `direct`, `gateway.remote.url` debe ser `ws://` o `wss://`. `ws://host` por defecto al puerto `18789`.
- `gateway.remote.token` suministra el token para llamadas remotas (dejar unset para no autentica).
- `gateway.remote.password` proporciona la contraseña para llamadas remotas (dejar sin establecer para no autenticación).

comportamiento de la aplicación macOS:

- OpenClaw.app observa `~/.openclaw/openclaw.json` y cambia modos en vivo cuando `gateway.mode` o `gateway.remote.url` cambia.
- Si `gateway.mode` no está establecido pero `gateway.remote.url` está definido, la aplicación macOS lo trata como modo remoto.
- Cuando cambias el modo de conexión en la aplicación macOS, escribe `gateway.mode` (y `gateway.remote.url` + `gateway.remote.transport` en modo remoto) de vuelta al archivo de configuración.

```json5
{
  gateway: {
    mode: "remote",
    remote: {
      url: "ws://gateway.tailnet:18789",
      token: "your-token",
      password: "your-password",
    },
  },
}
```

Ejemplo de transporte directo (aplicación macOS):

```json5
{
  gateway: {
    mode: "remote",
    remote: {
      transport: "direct",
      url: "wss://gateway.example.ts.net",
      token: "your-token",
    },
  },
}
```

### `gateway.reload` (Configurar recarga caliente)

El Gateway reproduce `~/.openclaw/openclaw.json` (o `OPENCLAW_CONFIG_PATH`) y aplica los cambios automáticamente.

Modos:

- `hybrid` (por defecto): caliente aplicar cambios seguros; reiniciar el Gateway para cambios críticos.
- `hot`: sólo aplicar cambios hot-safe; log cuando se requiere un reinicio.
- `restart`: reinicie el Gateway en cualquier cambio de configuración.
- `apagado`: deshabilita recarga caliente.

```json5
{
  gateway: {
    reload: {
      mode: "hybrid",
      debounceMs: 300,
    },
  },
}
```

#### Matrix de recarga caliente (archivos + impacto)

Archivos vistos:

- `~/.openclaw/openclaw.json` (o `OPENCLAW_CONFIG_PATH`)

Acceso directo (sin reinicio completo de la pasarela de enlaces):

- `hooks` (webhook auth/path/mappings) + `hooks.gmail` (Gmail watcher reiniciado)
- `navegador` (reinicio del servidor de control del navegador)
- `cron` (reinicio del servicio cron + actualización simultánea)
- `agents.defaults.heartbeat` (runner heartbeat reiniciar)
- `web` (canal web de WhatsApp reiniciar)
- `telegram`, `discord`, `signal`, `imessage` (canal se reinicia)
- `agent`, `models`, `routing`, `messages`, `session`, `whatsapp`, `logging`, `skills`, `ui`, `talk`, `identity`, `wizard` (lecturas dinámicas)

Requiere reiniciar la puerta de enlace completa:

- `gateway` (port/bind/auth/control UI/tailscale)
- `puente` (legado)
- `descubrimiento`
- `canvasHost`
- `plugins`
- Cualquier ruta de configuración desconocida/no soportada (por defecto se reiniciará para el futuro)

### Aislamiento múltiple

Para ejecutar múltiples pasarelas en un host (para redundancia o un bot de rescate), aislar estado por instancia + configuración y utilizar puertos únicos:

- `OPENCLAW_CONFIG_PATH` (configuración por instancia)
- `OPENCLAW_STATE_DIR` (sesiones/créditos)
- `agents.defaults.workspace` (memorias)
- `gateway.port` (único por instancia)

Banderas de conveniencia (CLI):

- `openclaw --dev …` → usa `~/.openclaw-dev` + desplaza puertos de la base `19001`
- `openclaw --profile <name> …` → usa `~/.openclaw-<name>` (puerto a través de config/env/flags)

Ver [Enciclopedia de pasarela de pasarela (/gateway) para el mapeo de puertos derivados (pasarela/navegador/lienzo).
Ver [Múltiples pasarelas](/gateway/multiple-gateways) para detalles de aislamiento del puerto del navegador/CDP.

Ejemplo:

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/a.json \
OPENCLAW_STATE_DIR=~/.openclaw-a \
puerta de enlace de openclaw --port 19001
```

### `hooks` (webhooks de Gateway)

Habilitar un simple punto final de webhook HTTP en el servidor HTTP de Gateway.

Valores predeterminados:

- habilitado: `false`
- ruta: `/hooks`
- maxBodyBytes: `262144` (256 KB)

```json5
{
  hooks: {
    actived: true,
    token: "shared-secret",
    ruta: "/hooks",
    presets: ["gmail"],
    transformsDir: "~/. penclaw/ganchos",
    mapeos: [
      {
        match: { path: "gmail" },
        acción: "agente",
        wakeMode: "ahora",
        nombre: "Gmail",
        sessionKey: "hook:gmail:{{messages[0].id}}",
        messageTemplate: "De: {{messages[0].from}}\nAsunto: {{messages[0].subject}}\n{{messages[0].snippet}}",
        deliver: true,
        channel: "last",
        modelo: "openai/gpt-5. -mini",
      },
    ],
  },
}
```

Las solicitudes deben incluir el token gancho:

- `Autorización: portador <token>` **o**
- `x-openclaw-token: <token>`

Puntos finales:

- `POST /hooks/wake` → `{ texto, mode?: "ahora"|"next-heartbeat" }`
- `POST /hooks/agent` → `{ message, name?, sessionKey?, wakeMode?, deliver?, channel?, to?, model?, thinking?, timeoutSegundds? }`
- `POST /hooks/<name>` → resuelto a través de `hooks.mappings`

`/hooks/agent` siempre publica un resumen en la sesión principal (y opcionalmente puede activar un latido inmediato a través de \`wakeMode: "ahora").

Notas de mapeo:

- `match.path` coincide con la subruta después de `/hooks` (por ejemplo, `/hooks/gmail` → `gmail`).
- `match.source` coincide con un campo de carga (por ejemplo, `{ source: "gmail" }`) para que puedas usar una ruta genérica `/hooks/ingest`.
- Plantillas como `{{messages[0].subject}}` leídas desde la carga útil.
- `transform` puede apuntar a un módulo JS/TS que devuelve una acción hook.
- `deliver: true` envía la respuesta final a un canal; `channel` por defecto a `last` (se vuelve a WhatsApp).
- Si no hay una ruta de entrega previa, establezca explícitamente `channel` + `to` (requerido para Telegram/Discord/Google Chat/Slack/Signal/iMessage/MS Teams).
- `model` anula el LLM para este gancho de ejecución (`provider/model` o alias; debe permitirse si `agents.defaults.models` está establecido).

Configuración del ayudante de Gmail (usado por `openclaw webhooks gmail setup` / `run`):

```json5
{
  hooks: {
    gmail: {
      accountt: "openclaw@gmail. om",
      tema: "projects/<project-id>/topics/gog-gmail-watch",
      suscripción: "gog-gmail-watch-push",
      pushToken: "shared-push-token",
      hookUrl: "http://127. .0.1:18789/hooks/gmail",
      includeBody: true,
      maxBytes: 20000,
      renewEveryMinutes: 720,
      serve: { bind: "127. .0. ", port: 8788, ruta: "/" },
      tailscale: { mode: "funnel", path: "/gmail-pubsub" },

      // Opcional: use un modelo más barato para el procesamiento de Gmail hook
      // Volver a los agentes. efaults.model. allbacks, luego primario, en auth/rate-limit/timeout
      modelo: "openrouter/meta-llama/llama-3. -70b-instruct:free",
      // Opcional: nivel de pensamiento predeterminado para Gmail hooks
      thinking: "off",
    },
  },
}
```

Anulación de modelo para Gmail hooks:

- `hooks.gmail.model` especifica un modelo a usar para el procesamiento de Gmail hook (por defecto para la sesión principal).
- Acepta referencias de `provider/model` o alias de `agents.defaults.models`.
- Vuelve a `agents.defaults.model.fallbacks`, luego `agents.defaults.model.primary`, en auth/rate-limit/timeouts.
- Si `agents.defaults.models` está definido, incluya el modelo gancho en la lista permitida.
- Al iniciar, advierte si el modelo configurado no está en el catálogo de modelos o lista permitida.
- `hooks.gmail.thinking` establece el nivel de pensamiento predeterminado para los ganchos de Gmail y es anulado por `pensando`.

Inicio automático de Gateway:

- Si `hooks.enabled=true` y `hooks.gmail.account` está definido, el Gateway inicia
  `gog gmail watch serve` en el arranque y auto-renueva el reloj.
- Establece `OPENCLAW_SKIP_GMAIL_WATCHER=1` para desactivar el auto-start (para ejecuciones manuales).
- Evita ejecutar un `gog gmail watch serve` separado junto a la Gateway; fallará
  con `listen tcp 127.0.0.1:8788: bind: dirección ya en uso`.

Nota: cuando `tailscale.mode` está encendido, OpenClaw predetermina `serve.path` a `/` para que
aescalar puede proxy `/gmail-pubsub` correctamente (quita el prefijo set-path).
Si necesitas el backend para recibir la ruta prefijada, establece
`hooks.gmail.tailscale.target` a una URL completa (y alinear `serve.path`).

### `canvasHost` (Servidor de archivos LAN/tailnet Canvas + Recarga en vivo)

El Gateway sirve un directorio de HTML/CSS/JS sobre HTTP, por lo que los nodos iOS/Android pueden simplemente `canvas.navigate` a él.

Raíz predeterminada: `~/. penclaw/workspace/canvas`  
Puerto por defecto: `18793` (elegido para evitar el puerto CDP del navegador openclaw `18792`)  
El servidor escucha en el **host de enlace de puerta de enlaza** (LAN o vectorial) para que los nodos puedan alcanzarlo.

El servidor:

- sirve archivos bajo `canvasHost.root`
- inyecta un pequeño cliente live-reload en HTML servido
- revisa el directorio y transmite recargas sobre un endpoint WebSocket en `/__openclaw__/ws`
- auto-crea un inicio `index.html` cuando el directorio está vacío (por lo que ves algo inmediatamente)
- también sirve A2UI en `/__openclaw__/a2ui/` y se anuncia en los nodos como `canvasHostUrl`
  (siempre usado por los nodos para Canvas/A2UI)

Deshabilita la recarga en vivo (y la visualización de archivos) si el directorio es grande o pulsa `EMFILE`:

- config: `canvasHost: { liveReload: false }`

```json5
{
  canvasHost: {
    root: "~/.openclaw/workspace/canvas",
    port: 18793,
    liveReload: true,
  },
}
```

Los cambios a `canvasHost.*` requieren un reinicio de la puerta de enlace (la recarga de configuración se reiniciará).

Deshabilitar con:

- config: `canvasHost: { enabled: false }`
- env: `OPENCLAW_SKIP_CANVAS_HOST=1`

### `puente` (puente TCP antiguo, eliminado)

Las compilaciones actuales ya no incluyen el escuchador de puente TCP; las claves de configuración `bridge.*` son ignoradas.
Los nodos se conectan a través del WebSocket Gateway. Esta sección se mantiene para referencia histórica.

Comportamiento antiguo:

- El Gateway podría exponer un simple puente TCP para nodos (iOS/Android), típicamente en el puerto `18790`.

Valores predeterminados:

- habilitado: `true`
- puerto: `18790`
- enlazar: `lan` (enlaza a `0.0.0.0`)

Bind modes:

- `lan`: `0.0.0.0` (accesible en cualquier interfaz, incluyendo LAN/Wi-Fi y Escala)
- `tailnet`: enlaza sólo con la IP de la máquina a escala de la máquina (recomendado para Viena, Londres)
- `loopback`: `127.0.0.1` (sólo local)
- `auto`: prefiere IP de tailnet si está presente, sino `lan`

TLS:

- `bridge.tls.enabled`: habilitar TLS para conexiones de puente (TLS-only cuando está activado).
- `bridge.tls.autoGenerate`: genera un certificado autofirmado cuando no hay cert/clave presente (por defecto: true).
- `bridge.tls.certPath` / `bridge.tls.keyPath`: rutas PEM para el certificado de puente + clave privada.
- `bridge.tls.caPath`: paquete opcional PEM CA (raíces personalizadas o mTLS futuro).

Cuando TLS está activado, la puerta de enlace anuncia `bridgeTls=1` y `bridgeTlsSha256` en registros de descubrimiento TXT
para que los nodos puedan fijar el certificado. Las conexiones manuales usan confianza-on-first-use si aún no hay huella dactilar
.
Los certificados autogenerados requieren 'openssl' en PATH; si la generación falla, el puente no comenzará.

```json5
{
  bridge: {
    activado: true, Puerto
    : 18790,
    bind: "tailnet",
    tls: {
      habilitado: true,
      // Usa ~/. penclaw/puente/tls/puente-{cert,key}.
      // certPath: "~/.openclaw/bridge/tls/bridge-cert.pem",
      // keyPath: "~/. penclaw/puente/tls/puente-key.pem"
    },
  },
}
```

### `discovery.mdns` (modo Bonjour / mDNS broadcast mode)

Controla las transmisiones de descubrimiento de mDNS LAN (`_openclaw-gw._tcp`).

- `minimal` (por defecto): omite `cliPath` + `sshPort` de registros TXT
- `full`: incluye `cliPath` + `sshPort` en registros TXT
- `apagado`: deshabilita completamente las transmisiones mDNS
- Hostname: por defecto es `openclaw` (anuncia `openclaw.local`). Sobrescribir con `OPENCLAW_MDNS_HOSTNAME`.

```json5
{
  discovery: { mdns: { mode: "minimal" } },
}
```

### `discovery.wideArea` (Ancho de área Bonjour / unicast DNS)[video] SD)

Cuando está activado, el Gateway escribe una zona unicast DNS-SD para `_openclaw-gw._tcp` bajo `~/.openclaw/dns/` usando el dominio de descubrimiento configurado (ejemplo: `openclaw.internal.`).

Para hacer que iOS/Android descubra a través de las redes (Viena, Londres), emparejar esto con:

- un servidor DNS en la pasarela que sirve el dominio elegido (se recomienda CoreDNS)
- escala de detalle **DNS dividido** para que los clientes resuelvan ese dominio a través del servidor DNS de puerta de enlace

Ayuda de configuración de una sola vez (host de gateway):

```bash
openclaw dns setup --apply
```

```json5
{
  discovery: { wideArea: { enabled: true } },
}
```

## Variables de plantilla de modelo multimedia

Los marcadores de posición de plantillas se expanden en `tools.media.*.models[].args` y `tools.media.models[].args` (y cualquier campo de argumentos futuros de plantilla).

\| Variable | Descripción |
\| ------------------ | --------------------------------------------------------------- | -------- | ------- | ------- | ---------- | ------ | -------- | ------- | ------- | ------- | --- |
\| `{{Body}}` | cuerpo de mensaje entrante |
\| `{{RawBody}}` | Mensaje entrante sin envoltorio (no envoltorio history/sender; best for command parsing) |
\| `{{BodyStripped}}` | Cuerpo con menciones de grupo eliminadas (mejor por defecto para los agentes) |
\| `{{From}}` | Identificador del remitente (E. 64 para WhatsApp; can differ per channel) |
\| `{{To}}` | Destino identificador |
\| `{{MessageSid}}` | Channel message id (cuando está disponible) |
\| `{{SessionId}}` | Current session UUID |
\| `{{IsNewSession}}` | `"true"` cuando se creó una nueva sesión |
\| `{{MediaUrl}}` | Inbound media pseudo-URL (si está presente) |
\| `{{MediaPath}}` | `{{MediaPath}}` | Local media path (si está descargado) |
\| `{{MediaType}}` | Media type (image/audio/document/…)                                             |
\| `{{Transcript}}`   | Transcripción de audio (cuando está habilitada)                                 |
\| `{{Prompt}}`       | Prompt de medios resuelto para entradas de CLI                                  |
\| `{{MaxChars}}`     | Máximo de caracteres de salida resuelto para entradas de CLI                    |
\| `{{ChatType}}`     | `"direct"` o `"group"`                                                       |
\| `{{GroupSubject}}` | Asunto del grupo (mejor esfuerzo)                                                |
\| `{{GroupMembers}}` | Vista previa de los miembros del grupo (mejor esfuerzo)                         |
\| `{{SenderName}}`   | Nombre para mostrar del remitente (mejor esfuerzo)                              |
\| `{{SenderE164}}`   | Número de teléfono del remitente (mejor esfuerzo)                               |
\| `{{Provider}}`     | Pista del proveedor (whatsapp                                                         | telegram | discord | googlechat | slack | signal | imessage | msteams | webchat | …)  |

## Cron (Planificador de Gateway)

Cron es un planificador propiedad de Gateway para despertar y tareas programadas. Ver [Trabajos Cronales](/automation/cron-jobs) para ver el resumen de características y ejemplos de CLI.

```json5
{
  cron: {
    enabled: true,
    maxConcurrentRuns: 2,
  },
}
```

---

_Siguiente: [Runtime del Agente](/concepts/agent)_ 🦞
