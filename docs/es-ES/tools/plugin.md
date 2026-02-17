---
summary: "Plugins/extensiones de OpenClaw: descubrimiento, configuración y seguridad"
read_when:
  - Agregar o modificar plugins/extensiones
  - Documentar reglas de instalación o carga de plugins
title: "Plugins"
---

# Plugins (Extensiones)

## Inicio Rápido (¿Nuevo en Plugins?)

Un plugin es simplemente un **pequeño módulo de código** que extiende OpenClaw con características adicionales (comandos, herramientas y RPC de Gateway).

La mayoría de las veces, usarás plugins cuando quieras una característica que aún no está incorporada en el núcleo de OpenClaw (o quieras mantener características opcionales fuera de tu instalación principal).

Ruta rápida:

1. Ver qué está ya cargado:

```bash
openclaw plugins list
```

2. Instalar un plugin oficial (ejemplo: Voice Call):

```bash
openclaw plugins install @openclaw/voice-call
```

Las especificaciones npm son **solo de registro** (nombre de paquete + versión/etiqueta opcional). Las especificaciones Git/URL/archivo son rechazadas.

3. Reinicia el Gateway, luego configura bajo `plugins.entries.<id>.config`.

Ver [Voice Call](/plugins/voice-call) para un ejemplo concreto de plugin.

## Plugins Disponibles (Oficiales)

- Microsoft Teams es solo plugin desde 2026.1.15; instala `@openclaw/msteams` si usas Teams.
- Memory (Core) — plugin de búsqueda de memoria incluido (habilitado por defecto vía `plugins.slots.memory`)
- Memory (LanceDB) — plugin de memoria a largo plazo incluido (auto-recuerdo/captura; establece `plugins.slots.memory = "memory-lancedb"`)
- [Voice Call](/plugins/voice-call) — `@openclaw/voice-call`
- [Zalo Personal](/plugins/zalouser) — `@openclaw/zalouser`
- [Matrix](/channels/matrix) — `@openclaw/matrix`
- [Nostr](/channels/nostr) — `@openclaw/nostr`
- [Zalo](/channels/zalo) — `@openclaw/zalo`
- [Microsoft Teams](/channels/msteams) — `@openclaw/msteams`
- Google Antigravity OAuth (autenticación de proveedor) — incluido como `google-antigravity-auth` (deshabilitado por defecto)
- Gemini CLI OAuth (autenticación de proveedor) — incluido como `google-gemini-cli-auth` (deshabilitado por defecto)
- Qwen OAuth (autenticación de proveedor) — incluido como `qwen-portal-auth` (deshabilitado por defecto)
- Copilot Proxy (autenticación de proveedor) — puente local de VS Code Copilot Proxy; distinto del inicio de sesión de dispositivo `github-copilot` incorporado (incluido, deshabilitado por defecto)

Los plugins de OpenClaw son **módulos TypeScript** cargados en tiempo de ejecución vía jiti. **La validación de configuración no ejecuta código de plugin**; usa el manifiesto del plugin y JSON Schema en su lugar. Ver [Manifiesto de plugin](/plugins/manifest).

Los plugins pueden registrar:

- Métodos RPC de Gateway
- Manejadores HTTP de Gateway
- Herramientas de agentes
- Comandos CLI
- Servicios en segundo plano
- Validación de configuración opcional
- **Habilidades** (listando directorios `skills` en el manifiesto del plugin)
- **Comandos de auto-respuesta** (ejecutar sin invocar al agente AI)

Los plugins se ejecutan **en proceso** con el Gateway, así que trátalos como código de confianza.
Guía de autoría de herramientas: [Herramientas de agente de plugin](/plugins/agent-tools).

## Helpers de Runtime

Los plugins pueden acceder a helpers centrales seleccionados vía `api.runtime`. Para TTS de telefonía:

```ts
const result = await api.runtime.tts.textToSpeechTelephony({
  text: "Hola desde OpenClaw",
  cfg: api.config,
});
```

Notas:

- Usa la configuración central `messages.tts` (OpenAI o ElevenLabs).
- Devuelve buffer de audio PCM + tasa de muestra. Los plugins deben remuestrear/codificar para proveedores.
- Edge TTS no está soportado para telefonía.

## Descubrimiento y Precedencia

OpenClaw escanea, en orden:

1. Rutas de configuración

- `plugins.load.paths` (archivo o directorio)

2. Extensiones de workspace

- `<workspace>/.openclaw/extensions/*.ts`
- `<workspace>/.openclaw/extensions/*/index.ts`

3. Extensiones globales

- `~/.openclaw/extensions/*.ts`
- `~/.openclaw/extensions/*/index.ts`

4. Extensiones incluidas (enviadas con OpenClaw, **deshabilitadas por defecto**)

- `<openclaw>/extensions/*`

Los plugins incluidos deben ser habilitados explícitamente vía `plugins.entries.<id>.enabled` o `openclaw plugins enable <id>`. Los plugins instalados están habilitados por defecto, pero pueden ser deshabilitados de la misma manera.

Cada plugin debe incluir un archivo `openclaw.plugin.json` en su raíz. Si una ruta apunta a un archivo, la raíz del plugin es el directorio del archivo y debe contener el manifiesto.

Si múltiples plugins se resuelven al mismo id, la primera coincidencia en el orden anterior gana y las copias de menor precedencia son ignoradas.

### Paquetes de Paquetes

Un directorio de plugin puede incluir un `package.json` con `openclaw.extensions`:

```json
{
  "name": "my-pack",
  "openclaw": {
    "extensions": ["./src/safety.ts", "./src/tools.ts"]
  }
}
```

Cada entrada se convierte en un plugin. Si el paquete lista múltiples extensiones, el id del plugin se convierte en `name/<fileBase>`.

Si tu plugin importa dependencias npm, instálalas en ese directorio para que `node_modules` esté disponible (`npm install` / `pnpm install`).

Nota de seguridad: `openclaw plugins install` instala dependencias de plugin con `npm install --ignore-scripts` (sin scripts de ciclo de vida). Mantén los árboles de dependencias de plugin "JS/TS puro" y evita paquetes que requieren construcciones `postinstall`.

### Metadatos del Catálogo de Canales

Los plugins de canal pueden anunciar metadatos de onboarding vía `openclaw.channel` e indicaciones de instalación vía `openclaw.install`. Esto mantiene el catálogo central libre de datos.

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
      "blurb": "Chat auto-alojado vía bots de webhook de Nextcloud Talk.",
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

OpenClaw también puede fusionar **catálogos de canal externos** (por ejemplo, una exportación de registro MPM). Coloca un archivo JSON en uno de:

- `~/.openclaw/mpm/plugins.json`
- `~/.openclaw/mpm/catalog.json`
- `~/.openclaw/plugins/catalog.json`

O apunta `OPENCLAW_PLUGIN_CATALOG_PATHS` (o `OPENCLAW_MPM_CATALOG_PATHS`) a uno o más archivos JSON (delimitados por coma/punto y coma/`PATH`). Cada archivo debe contener `{ "entries": [ { "name": "@scope/pkg", "openclaw": { "channel": {...}, "install": {...} } } ] }`.

## IDs de Plugin

IDs de plugin predeterminados:

- Paquetes de paquetes: `name` de `package.json`
- Archivo independiente: nombre base del archivo (`~/.../voice-call.ts` → `voice-call`)

Si un plugin exporta `id`, OpenClaw lo usa pero advierte cuando no coincide con el id configurado.

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
- `allow`: lista blanca (opcional)
- `deny`: lista negra (opcional; deny gana)
- `load.paths`: archivos/directorios de plugin extra
- `entries.<id>`: interruptores por plugin + config

Los cambios de configuración **requieren un reinicio del gateway**.

Reglas de validación (estrictas):

- IDs de plugin desconocidos en `entries`, `allow`, `deny` o `slots` son **errores**.
- Claves `channels.<id>` desconocidas son **errores** a menos que un manifiesto de plugin declare el id del canal.
- La configuración de plugin se valida usando el JSON Schema embebido en `openclaw.plugin.json` (`configSchema`).
- Si un plugin está deshabilitado, su configuración se preserva y se emite una **advertencia**.

## Slots de Plugin (Categorías Exclusivas)

Algunas categorías de plugin son **exclusivas** (solo una activa a la vez). Usa `plugins.slots` para seleccionar qué plugin posee el slot:

```json5
{
  plugins: {
    slots: {
      memory: "memory-core", // o "none" para deshabilitar plugins de memoria
    },
  },
}
```

Si múltiples plugins declaran `kind: "memory"`, solo el seleccionado se carga. Los demás son deshabilitados con diagnósticos.

## UI de Control (Esquema + Etiquetas)

La UI de Control usa `config.schema` (JSON Schema + `uiHints`) para renderizar mejores formularios.

OpenClaw aumenta `uiHints` en tiempo de ejecución basándose en plugins descubiertos:

- Agrega etiquetas por plugin para `plugins.entries.<id>` / `.enabled` / `.config`
- Fusiona indicaciones de campo de configuración opcionales proporcionadas por el plugin bajo:
  `plugins.entries.<id>.config.<field>`

Si quieres que los campos de configuración de tu plugin muestren buenas etiquetas/placeholders (y marcar secretos como sensibles), proporciona `uiHints` junto con tu JSON Schema en el manifiesto del plugin.

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
    "apiKey": { "label": "Clave API", "sensitive": true },
    "region": { "label": "Región", "placeholder": "us-east-1" }
  }
}
```

## CLI

```bash
openclaw plugins list
openclaw plugins info <id>
openclaw plugins install <path>                 # copiar un archivo/dir local a ~/.openclaw/extensions/<id>
openclaw plugins install ./extensions/voice-call # ruta relativa ok
openclaw plugins install ./plugin.tgz           # instalar desde un tarball local
openclaw plugins install ./plugin.zip           # instalar desde un zip local
openclaw plugins install -l ./extensions/voice-call # enlazar (sin copia) para desarrollo
openclaw plugins install @openclaw/voice-call # instalar desde npm
openclaw plugins update <id>
openclaw plugins update --all
openclaw plugins enable <id>
openclaw plugins disable <id>
openclaw plugins doctor
```

`plugins update` solo funciona para instalaciones npm rastreadas bajo `plugins.installs`.

Los plugins también pueden registrar sus propios comandos de nivel superior (ejemplo: `openclaw voicecall`).

## API de Plugin (Descripción General)

Los plugins exportan ya sea:

- Una función: `(api) => { ... }`
- Un objeto: `{ id, name, configSchema, register(api) { ... } }`

## Hooks de Plugin

Los plugins pueden enviar hooks y registrarlos en tiempo de ejecución. Esto permite que un plugin incluya automatización impulsada por eventos sin una instalación de paquete de hook separada.

### Ejemplo

```
import { registerPluginHooksFromDir } from "openclaw/plugin-sdk";

export default function register(api) {
  registerPluginHooksFromDir(api, "./hooks");
}
```

Notas:

- Los directorios de hook siguen la estructura normal de hook (`HOOK.md` + `handler.ts`).
- Las reglas de elegibilidad de hook aún aplican (requisitos de OS/bins/env/config).
- Los hooks gestionados por plugin aparecen en `openclaw hooks list` con `plugin:<id>`.
- No puedes habilitar/deshabilitar hooks gestionados por plugin vía `openclaw hooks`; habilita/deshabilita el plugin en su lugar.

## Plugins de Proveedor (Autenticación de Modelo)

Los plugins pueden registrar flujos de **autenticación de proveedor de modelo** para que los usuarios puedan ejecutar OAuth o configuración de clave API dentro de OpenClaw (sin necesidad de scripts externos).

Registra un proveedor vía `api.registerProvider(...)`. Cada proveedor expone uno o más métodos de autenticación (OAuth, clave API, código de dispositivo, etc.). Estos métodos impulsan:

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
        // Ejecutar flujo OAuth y devolver perfiles de autenticación.
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

- `run` recibe un `ProviderAuthContext` con helpers `prompter`, `runtime`, `openUrl` y `oauth.createVpsAwareHandlers`.
- Devuelve `configPatch` cuando necesites agregar modelos o configuración de proveedor predeterminados.
- Devuelve `defaultModel` para que `--set-default` pueda actualizar los predeterminados del agente.

### Registrar un Canal de Mensajería

Los plugins pueden registrar **plugins de canal** que se comportan como canales incorporados (WhatsApp, Telegram, etc.). La configuración del canal vive bajo `channels.<id>` y es validada por tu código de plugin de canal.

```ts
const myChannel = {
  id: "acmechat",
  meta: {
    id: "acmechat",
    label: "AcmeChat",
    selectionLabel: "AcmeChat (API)",
    docsPath: "/channels/acmechat",
    blurb: "plugin de canal demo.",
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

- Coloca la configuración bajo `channels.<id>` (no `plugins.entries`).
- `meta.label` se usa para etiquetas en listas CLI/UI.
- `meta.aliases` agrega ids alternos para normalización y entradas CLI.
- `meta.preferOver` lista ids de canal para omitir auto-habilitación cuando ambos están configurados.
- `meta.detailLabel` y `meta.systemImage` permiten que las UIs muestren etiquetas/íconos de canal más ricos.

### Escribir un Nuevo Canal de Mensajería (Paso a Paso)

Usa esto cuando quieras una **nueva superficie de chat** (un "canal de mensajería"), no un proveedor de modelo.
Los documentos de proveedor de modelo viven bajo `/providers/*`.

1. Elige un id + forma de configuración

- Toda la configuración del canal vive bajo `channels.<id>`.
- Prefiere `channels.<id>.accounts.<accountId>` para configuraciones multi-cuenta.

2. Define los metadatos del canal

- `meta.label`, `meta.selectionLabel`, `meta.docsPath`, `meta.blurb` controlan listas CLI/UI.
- `meta.docsPath` debe apuntar a una página de documentos como `/channels/<id>`.
- `meta.preferOver` permite que un plugin reemplace otro canal (auto-habilitación lo prefiere).
- `meta.detailLabel` y `meta.systemImage` son usados por UIs para texto/íconos de detalle.

3. Implementa los adaptadores requeridos

- `config.listAccountIds` + `config.resolveAccount`
- `capabilities` (tipos de chat, medios, hilos, etc.)
- `outbound.deliveryMode` + `outbound.sendText` (para envío básico)

4. Agrega adaptadores opcionales según sea necesario

- `setup` (asistente), `security` (política DM), `status` (salud/diagnósticos)
- `gateway` (iniciar/detener/iniciar sesión), `mentions`, `threading`, `streaming`
- `actions` (acciones de mensaje), `commands` (comportamiento de comando nativo)

5. Registra el canal en tu plugin

- `api.registerChannel({ plugin })`

Ejemplo de configuración mínima:

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
    blurb: "Canal de mensajería AcmeChat.",
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
      // entregar `text` a tu canal aquí
      return { ok: true };
    },
  },
};

export default function (api) {
  api.registerChannel({ plugin });
}
```

Carga el plugin (directorio de extensiones o `plugins.load.paths`), reinicia el gateway, luego configura `channels.<id>` en tu configuración.

### Herramientas de Agente

Ver la guía dedicada: [Herramientas de agente de plugin](/plugins/agent-tools).

### Registrar un Método RPC de Gateway

```ts
export default function (api) {
  api.registerGatewayMethod("myplugin.status", ({ respond }) => {
    respond(true, { ok: true });
  });
}
```

### Registrar Comandos CLI

```ts
export default function (api) {
  api.registerCli(
    ({ program }) => {
      program.command("mycmd").action(() => {
        console.log("Hola");
      });
    },
    { commands: ["mycmd"] },
  );
}
```

### Registrar Comandos de Auto-Respuesta

Los plugins pueden registrar comandos slash personalizados que se ejecutan **sin invocar al agente AI**. Esto es útil para comandos de alternancia, verificaciones de estado o acciones rápidas que no necesitan procesamiento LLM.

```ts
export default function (api) {
  api.registerCommand({
    name: "mystatus",
    description: "Mostrar estado del plugin",
    handler: (ctx) => ({
      text: `Plugin en ejecución! Canal: ${ctx.channel}`,
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

Opciones de comando:

- `name`: Nombre del comando (sin el `/` inicial)
- `description`: Texto de ayuda mostrado en listas de comandos
- `acceptsArgs`: Si el comando acepta argumentos (predeterminado: false). Si es false y se proporcionan argumentos, el comando no coincidirá y el mensaje pasará a otros manejadores
- `requireAuth`: Si requerir remitente autorizado (predeterminado: true)
- `handler`: Función que devuelve `{ text: string }` (puede ser async)

Ejemplo con autorización y argumentos:

```ts
api.registerCommand({
  name: "setmode",
  description: "Establecer modo del plugin",
  acceptsArgs: true,
  requireAuth: true,
  handler: async (ctx) => {
    const mode = ctx.args?.trim() || "default";
    await saveMode(mode);
    return { text: `Modo establecido a: ${mode}` };
  },
});
```

Notas:

- Los comandos de plugin se procesan **antes** que los comandos incorporados y el agente AI
- Los comandos se registran globalmente y funcionan en todos los canales
- Los nombres de comando no distinguen mayúsculas/minúsculas (`/MyStatus` coincide con `/mystatus`)
- Los nombres de comando deben comenzar con una letra y contener solo letras, números, guiones y guiones bajos
- Los nombres de comando reservados (como `help`, `status`, `reset`, etc.) no pueden ser anulados por plugins
- El registro de comando duplicado entre plugins fallará con un error de diagnóstico

### Registrar Servicios en Segundo Plano

```ts
export default function (api) {
  api.registerService({
    id: "my-service",
    start: () => api.logger.info("listo"),
    stop: () => api.logger.info("adiós"),
  });
}
```

## Convenciones de Nomenclatura

- Métodos de gateway: `pluginId.action` (ejemplo: `voicecall.status`)
- Herramientas: `snake_case` (ejemplo: `voice_call`)
- Comandos CLI: kebab o camel, pero evita chocar con comandos centrales

## Habilidades

Los plugins pueden enviar una habilidad en el repositorio (`skills/<name>/SKILL.md`).
Habilítala con `plugins.entries.<id>.enabled` (u otras puertas de configuración) y asegúrate de que esté presente en tus ubicaciones de workspace/habilidades gestionadas.

## Distribución (npm)

Empaquetado recomendado:

- Paquete principal: `openclaw` (este repositorio)
- Plugins: paquetes npm separados bajo `@openclaw/*` (ejemplo: `@openclaw/voice-call`)

Contrato de publicación:

- El `package.json` del plugin debe incluir `openclaw.extensions` con uno o más archivos de entrada.
- Los archivos de entrada pueden ser `.js` o `.ts` (jiti carga TS en tiempo de ejecución).
- `openclaw plugins install <npm-spec>` usa `npm pack`, extrae en `~/.openclaw/extensions/<id>/`, y lo habilita en la configuración.
- Estabilidad de clave de configuración: los paquetes con alcance se normalizan al id **sin alcance** para `plugins.entries.*`.

## Ejemplo de Plugin: Voice Call

Este repositorio incluye un plugin de llamada de voz (Twilio o respaldo de log):

- Fuente: `extensions/voice-call`
- Habilidad: `skills/voice-call`
- CLI: `openclaw voicecall start|status`
- Herramienta: `voice_call`
- RPC: `voicecall.start`, `voicecall.status`
- Configuración (twilio): `provider: "twilio"` + `twilio.accountSid/authToken/from` (opcional `statusCallbackUrl`, `twimlUrl`)
- Configuración (dev): `provider: "log"` (sin red)

Ver [Voice Call](/plugins/voice-call) y `extensions/voice-call/README.md` para configuración y uso.

## Notas de Seguridad

Los plugins se ejecutan en proceso con el Gateway. Trátalos como código de confianza:

- Solo instala plugins en los que confíes.
- Prefiere listas blancas `plugins.allow`.
- Reinicia el Gateway después de cambios.

## Probar Plugins

Los plugins pueden (y deberían) enviar pruebas:

- Los plugins en el repositorio pueden mantener pruebas Vitest bajo `src/**` (ejemplo: `src/plugins/voice-call.plugin.test.ts`).
- Los plugins publicados por separado deben ejecutar su propia CI (lint/build/test) y validar que `openclaw.extensions` apunte al punto de entrada construido (`dist/index.js`).
