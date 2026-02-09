---
summary: "Plugins/extensiones de OpenClaw: descubrimiento, configuración y seguridad"
read_when:
  - Al agregar o modificar plugins/extensiones
  - Al documentar reglas de instalación o carga de plugins
title: "Plugins"
---

# Plugins (Extensiones)

## Inicio rápido (¿nuevo en plugins?)

Un plugin es simplemente un **pequeño módulo de código** que amplía OpenClaw con
funciones adicionales (comandos, herramientas y RPC del Gateway).

La mayoría de las veces, usará plugins cuando quiera una función que aún no está
integrada en el núcleo de OpenClaw (o cuando quiera mantener funciones opcionales
fuera de su instalación principal).

Ruta rápida:

1. Vea qué ya está cargado:

```bash
openclaw plugins list
```

2. Instale un plugin oficial (ejemplo: Voice Call):

```bash
openclaw plugins install @openclaw/voice-call
```

3. Reinicie el Gateway y luego configure en `plugins.entries.<id>.config`.

Consulte [Voice Call](/plugins/voice-call) para un ejemplo concreto de plugin.

## Plugins disponibles (oficiales)

- Microsoft Teams es solo por plugin desde 2026.1.15; instale `@openclaw/msteams` si usa Teams.
- Memory (Core) — plugin de búsqueda de memoria incluido (habilitado de forma predeterminada mediante `plugins.slots.memory`)
- Memory (LanceDB) — plugin de memoria a largo plazo incluido (auto‑recuperación/captura; configure `plugins.slots.memory = "memory-lancedb"`)
- [Voice Call](/plugins/voice-call) — `@openclaw/voice-call`
- [Zalo Personal](/plugins/zalouser) — `@openclaw/zalouser`
- [Matrix](/channels/matrix) — `@openclaw/matrix`
- [Nostr](/channels/nostr) — `@openclaw/nostr`
- [Zalo](/channels/zalo) — `@openclaw/zalo`
- [Microsoft Teams](/channels/msteams) — `@openclaw/msteams`
- Google Antigravity OAuth (auth de proveedor) — incluido como `google-antigravity-auth` (deshabilitado de forma predeterminada)
- Gemini CLI OAuth (auth de proveedor) — incluido como `google-gemini-cli-auth` (deshabilitado de forma predeterminada)
- Qwen OAuth (auth de proveedor) — incluido como `qwen-portal-auth` (deshabilitado de forma predeterminada)
- Copilot Proxy (auth de proveedor) — puente local de VS Code Copilot Proxy; distinto del inicio de sesión del dispositivo `github-copilot` integrado (incluido, deshabilitado de forma predeterminada)

Los plugins de OpenClaw son **módulos TypeScript** cargados en tiempo de ejecución mediante jiti. **La validación de configuración no ejecuta código del plugin**; utiliza el manifiesto del plugin y JSON Schema. Consulte [Plugin manifest](/plugins/manifest).

Los plugins pueden registrar:

- Métodos RPC del Gateway
- Manejadores HTTP del Gateway
- Herramientas del agente
- Comandos de la CLI
- Servicios en segundo plano
- Validación de configuración opcional
- **Skills** (enumerando directorios `skills` en el manifiesto del plugin)
- **Comandos de respuesta automática** (se ejecutan sin invocar al agente de IA)

Los plugins se ejecutan **en el mismo proceso** que el Gateway, así que trátelos como código de confianza.
Guía de creación de herramientas: [Plugin agent tools](/plugins/agent-tools).

## Ayudantes de tiempo de ejecución

Los plugins pueden acceder a ayudantes principales seleccionados mediante `api.runtime`. Para TTS de telefonía:

```ts
const result = await api.runtime.tts.textToSpeechTelephony({
  text: "Hello from OpenClaw",
  cfg: api.config,
});
```

Notas:

- Usa la configuración principal `messages.tts` (OpenAI o ElevenLabs).
- Devuelve un búfer de audio PCM + frecuencia de muestreo. Los plugins deben remuestrear/codificar para los proveedores.
- Edge TTS no es compatible con telefonía.

## Descubrimiento y precedencia

OpenClaw escanea, en orden:

1. Rutas de configuración

- `plugins.load.paths` (archivo o directorio)

2. Extensiones del espacio de trabajo

- `<workspace>/.openclaw/extensions/*.ts`
- `<workspace>/.openclaw/extensions/*/index.ts`

3. Extensiones globales

- `~/.openclaw/extensions/*.ts`
- `~/.openclaw/extensions/*/index.ts`

4. Extensiones incluidas (enviadas con OpenClaw, **deshabilitadas de forma predeterminada**)

- `<openclaw>/extensions/*`

Los plugins incluidos deben habilitarse explícitamente mediante `plugins.entries.<id>.enabled`
o `openclaw plugins enable <id>`. Los plugins instalados están habilitados de forma predeterminada,
pero pueden deshabilitarse del mismo modo.

Cada plugin debe incluir un archivo `openclaw.plugin.json` en su raíz. Si una ruta
apunta a un archivo, la raíz del plugin es el directorio del archivo y debe contener el
manifiesto.

Si varios plugins se resuelven al mismo id, gana la primera coincidencia en el orden
anterior y las copias de menor precedencia se ignoran.

### Paquetes de paquetes

Un directorio de plugin puede incluir un `package.json` con `openclaw.extensions`:

```json
{
  "name": "my-pack",
  "openclaw": {
    "extensions": ["./src/safety.ts", "./src/tools.ts"]
  }
}
```

Cada entrada se convierte en un plugin. Si el paquete enumera múltiples extensiones, el id del plugin
pasa a ser `name/<fileBase>`.

Si su plugin importa dependencias npm, instálelas en ese directorio para que
`node_modules` esté disponible (`npm install` / `pnpm install`).

### Metadatos del catálogo de canales

Los plugins de canal pueden anunciar metadatos de incorporación mediante `openclaw.channel` y
pistas de instalación mediante `openclaw.install`. Esto mantiene los datos del catálogo principal sin datos.

Ejemplo:

```json
{
  "name": "@openclaw/nextcloud-talk",
  "openclaw": {
    "extensions": ["./index.ts"],
    "channel": {
      "id": "nextcloud-talk",
      "label": "Nextcloud Talk",
      "selectionLabel": "Nextcloud Talk (self-hosted)",
      "docsPath": "/channels/nextcloud-talk",
      "docsLabel": "nextcloud-talk",
      "blurb": "Self-hosted chat via Nextcloud Talk webhook bots.",
      "order": 65,
      "aliases": ["nc-talk", "nc"]
    },
    "install": {
      "npmSpec": "@openclaw/nextcloud-talk",
      "localPath": "extensions/nextcloud-talk",
      "defaultChoice": "npm"
    }
  }
}
```

OpenClaw también puede fusionar **catálogos de canales externos** (por ejemplo, una exportación de registro MPM). Coloque un archivo JSON en uno de:

- `~/.openclaw/mpm/plugins.json`
- `~/.openclaw/mpm/catalog.json`
- `~/.openclaw/plugins/catalog.json`

O apunte `OPENCLAW_PLUGIN_CATALOG_PATHS` (o `OPENCLAW_MPM_CATALOG_PATHS`) a
uno o más archivos JSON (delimitados por coma/punto y coma/`PATH`). Cada archivo debe
contener `{ "entries": [ { "name": "@scope/pkg", "openclaw": { "channel": {...}, "install": {...} } } ] }`.

## IDs de plugins

IDs de plugin predeterminados:

- Paquetes de paquetes: `package.json` `name`
- Archivo independiente: nombre base del archivo (`~/.../voice-call.ts` → `voice-call`)

Si un plugin exporta `id`, OpenClaw lo usa pero advierte cuando no coincide con el
id configurado.

## Configuración

```json5
{
  plugins: {
    enabled: true,
    allow: ["voice-call"],
    deny: ["untrusted-plugin"],
    load: { paths: ["~/Projects/oss/voice-call-extension"] },
    entries: {
      "voice-call": { enabled: true, config: { provider: "twilio" } },
    },
  },
}
```

Campos:

- `enabled`: interruptor maestro (predeterminado: true)
- `allow`: lista de permitidos (opcional)
- `deny`: lista de denegados (opcional; la denegación gana)
- `load.paths`: archivos/directorios adicionales del plugin
- `entries.<id>`: interruptores por plugin + configuración

Los cambios de configuración **requieren reiniciar el Gateway**.

Reglas de validación (estrictas):

- IDs de plugin desconocidos en `entries`, `allow`, `deny` o `slots` son **errores**.
- Claves `channels.<id>` desconocidas son **errores** a menos que un manifiesto del plugin declare
  el id del canal.
- La configuración del plugin se valida usando el JSON Schema incrustado en
  `openclaw.plugin.json` (`configSchema`).
- Si un plugin está deshabilitado, su configuración se conserva y se emite una **advertencia**.

## Ranuras de plugins (categorías exclusivas)

Algunas categorías de plugins son **exclusivas** (solo una activa a la vez). Use
`plugins.slots` para seleccionar qué plugin posee la ranura:

```json5
{
  plugins: {
    slots: {
      memory: "memory-core", // or "none" to disable memory plugins
    },
  },
}
```

Si varios plugins declaran `kind: "memory"`, solo se carga el seleccionado. Los demás
se deshabilitan con diagnósticos.

## UI de control (schema + etiquetas)

La UI de Control usa `config.schema` (JSON Schema + `uiHints`) para renderizar mejores formularios.

OpenClaw amplía `uiHints` en tiempo de ejecución según los plugins descubiertos:

- Agrega etiquetas por plugin para `plugins.entries.<id>` / `.enabled` / `.config`
- Fusiona pistas de campos de configuración opcionales proporcionadas por plugins bajo:
  `plugins.entries.<id>.config.<field>`

Si desea que los campos de configuración de su plugin muestren buenas etiquetas/marcadores de posición (y marcar secretos como sensibles),
proporcione `uiHints` junto con su JSON Schema en el manifiesto del plugin.

Ejemplo:

```json
{
  "id": "my-plugin",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "apiKey": { "type": "string" },
      "region": { "type": "string" }
    }
  },
  "uiHints": {
    "apiKey": { "label": "API Key", "sensitive": true },
    "region": { "label": "Region", "placeholder": "us-east-1" }
  }
}
```

## CLI

```bash
openclaw plugins list
openclaw plugins info <id>
openclaw plugins install <path>                 # copy a local file/dir into ~/.openclaw/extensions/<id>
openclaw plugins install ./extensions/voice-call # relative path ok
openclaw plugins install ./plugin.tgz           # install from a local tarball
openclaw plugins install ./plugin.zip           # install from a local zip
openclaw plugins install -l ./extensions/voice-call # link (no copy) for dev
openclaw plugins install @openclaw/voice-call # install from npm
openclaw plugins update <id>
openclaw plugins update --all
openclaw plugins enable <id>
openclaw plugins disable <id>
openclaw plugins doctor
```

`plugins update` solo funciona para instalaciones npm registradas bajo `plugins.installs`.

Los plugins también pueden registrar sus propios comandos de nivel superior (ejemplo: `openclaw voicecall`).

## API de plugins (resumen)

Los plugins exportan cualquiera de:

- Una función: `(api) => { ... }`
- Un objeto: `{ id, name, configSchema, register(api) { ... } }`

## Hooks de plugins

Los plugins pueden incluir hooks y registrarlos en tiempo de ejecución. Esto permite que un plugin agrupe
automatización basada en eventos sin una instalación separada de paquetes de hooks.

### Ejemplo

```
import { registerPluginHooksFromDir } from "openclaw/plugin-sdk";

export default function register(api) {
  registerPluginHooksFromDir(api, "./hooks");
}
```

Notas:

- Los directorios de hooks siguen la estructura normal de hooks (`HOOK.md` + `handler.ts`).
- Las reglas de elegibilidad de hooks aún aplican (SO/binarios/variables de entorno/requisitos de configuración).
- Los hooks administrados por plugins aparecen en `openclaw hooks list` con `plugin:<id>`.
- No puede habilitar/deshabilitar hooks administrados por plugins mediante `openclaw hooks`; habilite/deshabilite el plugin en su lugar.

## Plugins de proveedor (auth de modelo)

Los plugins pueden registrar flujos de **auth de proveedor de modelo** para que los usuarios puedan ejecutar OAuth o
configuración de clave de API dentro de OpenClaw (no se necesitan scripts externos).

Registre un proveedor mediante `api.registerProvider(...)`. Cada proveedor expone uno
o más métodos de autenticación (OAuth, clave de API, código de dispositivo, etc.). Estos métodos alimentan:

- `openclaw models auth login --provider <id> [--method <id>]`

Ejemplo:

```ts
api.registerProvider({
  id: "acme",
  label: "AcmeAI",
  auth: [
    {
      id: "oauth",
      label: "OAuth",
      kind: "oauth",
      run: async (ctx) => {
        // Run OAuth flow and return auth profiles.
        return {
          profiles: [
            {
              profileId: "acme:default",
              credential: {
                type: "oauth",
                provider: "acme",
                access: "...",
                refresh: "...",
                expires: Date.now() + 3600 * 1000,
              },
            },
          ],
          defaultModel: "acme/opus-1",
        };
      },
    },
  ],
});
```

Notas:

- `run` recibe un `ProviderAuthContext` con ayudantes `prompter`, `runtime`,
  `openUrl` y `oauth.createVpsAwareHandlers`.
- Devuelva `configPatch` cuando necesite agregar modelos predeterminados o configuración del proveedor.
- Devuelva `defaultModel` para que `--set-default` pueda actualizar los valores predeterminados del agente.

### Registrar un canal de mensajería

Los plugins pueden registrar **plugins de canal** que se comportan como canales integrados
(WhatsApp, Telegram, etc.). La configuración del canal vive bajo `channels.<id>` y es
validada por el código de su plugin de canal.

```ts
const myChannel = {
  id: "acmechat",
  meta: {
    id: "acmechat",
    label: "AcmeChat",
    selectionLabel: "AcmeChat (API)",
    docsPath: "/channels/acmechat",
    blurb: "demo channel plugin.",
    aliases: ["acme"],
  },
  capabilities: { chatTypes: ["direct"] },
  config: {
    listAccountIds: (cfg) => Object.keys(cfg.channels?.acmechat?.accounts ?? {}),
    resolveAccount: (cfg, accountId) =>
      cfg.channels?.acmechat?.accounts?.[accountId ?? "default"] ?? {
        accountId,
      },
  },
  outbound: {
    deliveryMode: "direct",
    sendText: async () => ({ ok: true }),
  },
};

export default function (api) {
  api.registerChannel({ plugin: myChannel });
}
```

Notas:

- Coloque la configuración bajo `channels.<id>` (no `plugins.entries`).
- `meta.label` se usa para etiquetas en listas de CLI/UI.
- `meta.aliases` agrega ids alternativos para normalización y entradas de la CLI.
- `meta.preferOver` enumera ids de canal para omitir la habilitación automática cuando ambos están configurados.
- `meta.detailLabel` y `meta.systemImage` permiten que las UIs muestren etiquetas/iconos de canal más ricos.

### Escribir un nuevo canal de mensajería (paso a paso)

Use esto cuando quiera una **nueva superficie de chat** (un “canal de mensajería”), no un proveedor de modelos.
La documentación de proveedores de modelos vive bajo `/providers/*`.

1. Elija un id + forma de configuración

- Toda la configuración del canal vive bajo `channels.<id>`.
- Prefiera `channels.<id>.accounts.<accountId>` para configuraciones de múltiples cuentas.

2. Defina los metadatos del canal

- `meta.label`, `meta.selectionLabel`, `meta.docsPath`, `meta.blurb` controlan listas de CLI/UI.
- `meta.docsPath` debería apuntar a una página de documentación como `/channels/<id>`.
- `meta.preferOver` permite que un plugin reemplace otro canal (la habilitación automática lo prefiere).
- `meta.detailLabel` y `meta.systemImage` son usados por las UIs para texto/iconos de detalle.

3. Implemente los adaptadores requeridos

- `config.listAccountIds` + `config.resolveAccount`
- `capabilities` (tipos de chat, medios, hilos, etc.)
- `outbound.deliveryMode` + `outbound.sendText` (para envío básico)

4. Agregue adaptadores opcionales según sea necesario

- `setup` (asistente), `security` (política de DM), `status` (salud/diagnósticos)
- `gateway` (inicio/detención/inicio de sesión), `mentions`, `threading`, `streaming`
- `actions` (acciones de mensaje), `commands` (comportamiento de comandos nativos)

5. Registre el canal en su plugin

- `api.registerChannel({ plugin })`

Ejemplo mínimo de configuración:

```json5
{
  channels: {
    acmechat: {
      accounts: {
        default: { token: "ACME_TOKEN", enabled: true },
      },
    },
  },
}
```

Plugin de canal mínimo (solo salida):

```ts
const plugin = {
  id: "acmechat",
  meta: {
    id: "acmechat",
    label: "AcmeChat",
    selectionLabel: "AcmeChat (API)",
    docsPath: "/channels/acmechat",
    blurb: "AcmeChat messaging channel.",
    aliases: ["acme"],
  },
  capabilities: { chatTypes: ["direct"] },
  config: {
    listAccountIds: (cfg) => Object.keys(cfg.channels?.acmechat?.accounts ?? {}),
    resolveAccount: (cfg, accountId) =>
      cfg.channels?.acmechat?.accounts?.[accountId ?? "default"] ?? {
        accountId,
      },
  },
  outbound: {
    deliveryMode: "direct",
    sendText: async ({ text }) => {
      // deliver `text` to your channel here
      return { ok: true };
    },
  },
};

export default function (api) {
  api.registerChannel({ plugin });
}
```

Cargue el plugin (directorio de extensiones o `plugins.load.paths`), reinicie el gateway,
luego configure `channels.<id>` en su configuración.

### Herramientas del agente

Consulte la guía dedicada: [Plugin agent tools](/plugins/agent-tools).

### Registrar un método RPC del gateway

```ts
export default function (api) {
  api.registerGatewayMethod("myplugin.status", ({ respond }) => {
    respond(true, { ok: true });
  });
}
```

### Registrar comandos de la CLI

```ts
export default function (api) {
  api.registerCli(
    ({ program }) => {
      program.command("mycmd").action(() => {
        console.log("Hello");
      });
    },
    { commands: ["mycmd"] },
  );
}
```

### Registrar comandos de respuesta automática

Los plugins pueden registrar comandos de barra personalizados que se ejecutan **sin invocar al
agente de IA**. Esto es útil para comandos de alternancia, verificaciones de estado o acciones rápidas
que no necesitan procesamiento de LLM.

```ts
export default function (api) {
  api.registerCommand({
    name: "mystatus",
    description: "Show plugin status",
    handler: (ctx) => ({
      text: `Plugin is running! Channel: ${ctx.channel}`,
    }),
  });
}
```

Contexto del manejador de comandos:

- `senderId`: El ID del remitente (si está disponible)
- `channel`: El canal donde se envió el comando
- `isAuthorizedSender`: Si el remitente es un usuario autorizado
- `args`: Argumentos pasados después del comando (si `acceptsArgs: true`)
- `commandBody`: El texto completo del comando
- `config`: La configuración actual de OpenClaw

Opciones del comando:

- `name`: Nombre del comando (sin el `/` inicial)
- `description`: Texto de ayuda mostrado en listas de comandos
- `acceptsArgs`: Si el comando acepta argumentos (predeterminado: false). Si es false y se proporcionan argumentos, el comando no coincidirá y el mensaje pasará a otros manejadores
- `requireAuth`: Si requiere remitente autorizado (predeterminado: true)
- `handler`: Función que devuelve `{ text: string }` (puede ser async)

Ejemplo con autorización y argumentos:

```ts
api.registerCommand({
  name: "setmode",
  description: "Set plugin mode",
  acceptsArgs: true,
  requireAuth: true,
  handler: async (ctx) => {
    const mode = ctx.args?.trim() || "default";
    await saveMode(mode);
    return { text: `Mode set to: ${mode}` };
  },
});
```

Notas:

- Los comandos de plugins se procesan **antes** de los comandos integrados y del agente de IA
- Los comandos se registran globalmente y funcionan en todos los canales
- Los nombres de comandos no distinguen mayúsculas/minúsculas (`/MyStatus` coincide con `/mystatus`)
- Los nombres de comandos deben comenzar con una letra y contener solo letras, números, guiones y guiones bajos
- Los nombres de comandos reservados (como `help`, `status`, `reset`, etc.) no pueden ser reemplazados por plugins
- El registro duplicado de comandos entre plugins fallará con un error de diagnóstico

### Registrar servicios en segundo plano

```ts
export default function (api) {
  api.registerService({
    id: "my-service",
    start: () => api.logger.info("ready"),
    stop: () => api.logger.info("bye"),
  });
}
```

## Convenciones de nombres

- Métodos del Gateway: `pluginId.action` (ejemplo: `voicecall.status`)
- Herramientas: `snake_case` (ejemplo: `voice_call`)
- Comandos de la CLI: kebab o camel, pero evite colisiones con comandos principales

## Skills

Los plugins pueden incluir una skill en el repositorio (`skills/<name>/SKILL.md`).
Habilítela con `plugins.entries.<id>.enabled` (u otras puertas de configuración) y asegúrese de que
esté presente en las ubicaciones de skills de su espacio de trabajo/administradas.

## Distribución (npm)

Empaquetado recomendado:

- Paquete principal: `openclaw` (este repositorio)
- Plugins: paquetes npm separados bajo `@openclaw/*` (ejemplo: `@openclaw/voice-call`)

Contrato de publicación:

- El `package.json` del plugin debe incluir `openclaw.extensions` con uno o más archivos de entrada.
- Los archivos de entrada pueden ser `.js` o `.ts` (jiti carga TS en tiempo de ejecución).
- `openclaw plugins install <npm-spec>` usa `npm pack`, extrae en `~/.openclaw/extensions/<id>/` y lo habilita en la configuración.
- Estabilidad de claves de configuración: los paquetes con ámbito se normalizan al id **sin ámbito** para `plugins.entries.*`.

## Ejemplo de plugin: Voice Call

Este repositorio incluye un plugin de llamadas de voz (Twilio o respaldo de registro):

- Código fuente: `extensions/voice-call`
- Skill: `skills/voice-call`
- CLI: `openclaw voicecall start|status`
- Herramienta: `voice_call`
- RPC: `voicecall.start`, `voicecall.status`
- Configuración (twilio): `provider: "twilio"` + `twilio.accountSid/authToken/from` (opcional `statusCallbackUrl`, `twimlUrl`)
- Configuración (dev): `provider: "log"` (sin red)

Consulte [Voice Call](/plugins/voice-call) y `extensions/voice-call/README.md` para configuración y uso.

## Notas de seguridad

Los plugins se ejecutan en el mismo proceso que el Gateway. Trátelos como código de confianza:

- Instale solo plugins en los que confíe.
- Prefiera listas de permitidos `plugins.allow`.
- Reinicie el Gateway después de los cambios.

## Pruebas de plugins

Los plugins pueden (y deben) incluir pruebas:

- Los plugins en el repositorio pueden mantener pruebas de Vitest bajo `src/**` (ejemplo: `src/plugins/voice-call.plugin.test.ts`).
- Los plugins publicados por separado deben ejecutar su propio CI (lint/build/test) y validar que `openclaw.extensions` apunte al punto de entrada compilado (`dist/index.js`).
