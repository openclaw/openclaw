---
summary: "Hooks: automatización basada en eventos para comandos y eventos del ciclo de vida"
read_when:
  - Quieres automatización basada en eventos para /new, /reset, /stop y eventos del ciclo de vida del agente
  - Quieres construir, instalar o depurar hooks
title: "Hooks"
---

# Hooks

Los Hooks proporcionan un sistema extensible basado en eventos para automatizar acciones en respuesta a comandos y eventos del agente. Los hooks se descubren automáticamente desde directorios y pueden gestionarse mediante comandos CLI, de forma similar a cómo funcionan las habilidades en OpenClaw.

## Orientación inicial

Los hooks son pequeños scripts que se ejecutan cuando algo ocurre. Hay dos tipos:

- **Hooks** (esta página): se ejecutan dentro del Gateway cuando se disparan eventos del agente, como `/new`, `/reset`, `/stop` o eventos del ciclo de vida.
- **Webhooks**: webhooks HTTP externos que permiten a otros sistemas activar trabajo en OpenClaw. Ver [Webhook Hooks](/es-ES/automation/webhook) o usa `openclaw webhooks` para comandos auxiliares de Gmail.

Los hooks también pueden empaquetarse dentro de plugins; ver [Plugins](/es-ES/tools/plugin#plugin-hooks).

Usos comunes:

- Guardar una instantánea de memoria cuando reseteas una sesión
- Mantener un registro de auditoría de comandos para solución de problemas o cumplimiento normativo
- Activar automatizaciones de seguimiento cuando una sesión inicia o termina
- Escribir archivos en el espacio de trabajo del agente o llamar APIs externas cuando se disparan eventos

Si puedes escribir una pequeña función TypeScript, puedes escribir un hook. Los hooks se descubren automáticamente, y los habilitas o deshabilitas mediante la CLI.

## Vista general

El sistema de hooks te permite:

- Guardar el contexto de la sesión en memoria cuando se ejecuta `/new`
- Registrar todos los comandos para auditoría
- Activar automatizaciones personalizadas en eventos del ciclo de vida del agente
- Extender el comportamiento de OpenClaw sin modificar el código central

## Primeros pasos

### Hooks incluidos

OpenClaw se distribuye con cuatro hooks incluidos que se descubren automáticamente:

- **💾 session-memory**: Guarda el contexto de la sesión en tu espacio de trabajo del agente (por defecto `~/.openclaw/workspace/memory/`) cuando ejecutas `/new`
- **📎 bootstrap-extra-files**: Inyecta archivos adicionales de inicialización del espacio de trabajo desde patrones glob/path configurados durante `agent:bootstrap`
- **📝 command-logger**: Registra todos los eventos de comandos en `~/.openclaw/logs/commands.log`
- **🚀 boot-md**: Ejecuta `BOOT.md` cuando el gateway inicia (requiere hooks internos habilitados)

Listar hooks disponibles:

```bash
openclaw hooks list
```

Habilitar un hook:

```bash
openclaw hooks enable session-memory
```

Verificar el estado del hook:

```bash
openclaw hooks check
```

Obtener información detallada:

```bash
openclaw hooks info session-memory
```

### Incorporación

Durante la incorporación (`openclaw onboard`), se te pedirá habilitar los hooks recomendados. El asistente descubre automáticamente los hooks elegibles y los presenta para su selección.

## Descubrimiento de hooks

Los hooks se descubren automáticamente desde tres directorios (en orden de precedencia):

1. **Hooks del espacio de trabajo**: `<workspace>/hooks/` (por agente, precedencia más alta)
2. **Hooks gestionados**: `~/.openclaw/hooks/` (instalados por el usuario, compartidos entre espacios de trabajo)
3. **Hooks incluidos**: `<openclaw>/dist/hooks/bundled/` (distribuidos con OpenClaw)

Los directorios de hooks gestionados pueden ser un **único hook** o un **paquete de hooks** (directorio de paquete).

Cada hook es un directorio que contiene:

```
my-hook/
├── HOOK.md          # Metadatos + documentación
└── handler.ts       # Implementación del manejador
```

## Paquetes de hooks (npm/archivos)

Los paquetes de hooks son paquetes npm estándar que exportan uno o más hooks mediante `openclaw.hooks` en
`package.json`. Instálalos con:

```bash
openclaw hooks install <path-or-spec>
```

Las especificaciones npm son solo de registro (nombre de paquete + versión/etiqueta opcional). Las especificaciones Git/URL/archivo son rechazadas.

Ejemplo de `package.json`:

```json
{
  "name": "@acme/my-hooks",
  "version": "0.1.0",
  "openclaw": {
    "hooks": ["./hooks/my-hook", "./hooks/other-hook"]
  }
}
```

Cada entrada apunta a un directorio de hook que contiene `HOOK.md` y `handler.ts` (o `index.ts`).
Los paquetes de hooks pueden distribuir dependencias; se instalarán bajo `~/.openclaw/hooks/<id>`.

Nota de seguridad: `openclaw hooks install` instala dependencias con `npm install --ignore-scripts`
(sin scripts de ciclo de vida). Mantén los árboles de dependencias de paquetes de hooks "puros JS/TS" y evita paquetes que dependen de construcciones `postinstall`.

## Estructura de hooks

### Formato HOOK.md

El archivo `HOOK.md` contiene metadatos en frontmatter YAML más documentación Markdown:

```markdown
---
name: my-hook
description: "Descripción breve de lo que hace este hook"
homepage: https://docs.openclaw.ai/automation/hooks#my-hook
metadata:
  { "openclaw": { "emoji": "🔗", "events": ["command:new"], "requires": { "bins": ["node"] } } }
---

# My Hook

La documentación detallada va aquí...

## Qué hace

- Escucha comandos `/new`
- Realiza alguna acción
- Registra el resultado

## Requisitos

- Node.js debe estar instalado

## Configuración

No se necesita configuración.
```

### Campos de metadatos

El objeto `metadata.openclaw` admite:

- **`emoji`**: Emoji de visualización para CLI (ej. `"💾"`)
- **`events`**: Array de eventos a escuchar (ej. `["command:new", "command:reset"]`)
- **`export`**: Exportación nombrada a usar (por defecto `"default"`)
- **`homepage`**: URL de documentación
- **`requires`**: Requisitos opcionales
  - **`bins`**: Binarios requeridos en PATH (ej. `["git", "node"]`)
  - **`anyBins`**: Al menos uno de estos binarios debe estar presente
  - **`env`**: Variables de entorno requeridas
  - **`config`**: Rutas de configuración requeridas (ej. `["workspace.dir"]`)
  - **`os`**: Plataformas requeridas (ej. `["darwin", "linux"]`)
- **`always`**: Omitir verificaciones de elegibilidad (booleano)
- **`install`**: Métodos de instalación (para hooks incluidos: `[{"id":"bundled","kind":"bundled"}]`)

### Implementación del manejador

El archivo `handler.ts` exporta una función `HookHandler`:

```typescript
import type { HookHandler } from "../../src/hooks/hooks.js";

const myHandler: HookHandler = async (event) => {
  // Solo activar en comando 'new'
  if (event.type !== "command" || event.action !== "new") {
    return;
  }

  console.log(`[my-hook] Comando new activado`);
  console.log(`  Sesión: ${event.sessionKey}`);
  console.log(`  Marca de tiempo: ${event.timestamp.toISOString()}`);

  // Tu lógica personalizada aquí

  // Opcionalmente enviar mensaje al usuario
  event.messages.push("✨ ¡Mi hook se ejecutó!");
};

export default myHandler;
```

#### Contexto del evento

Cada evento incluye:

```typescript
{
  type: 'command' | 'session' | 'agent' | 'gateway',
  action: string,              // ej. 'new', 'reset', 'stop'
  sessionKey: string,          // Identificador de sesión
  timestamp: Date,             // Cuándo ocurrió el evento
  messages: string[],          // Agregar mensajes aquí para enviar al usuario
  context: {
    sessionEntry?: SessionEntry,
    sessionId?: string,
    sessionFile?: string,
    commandSource?: string,    // ej. 'whatsapp', 'telegram'
    senderId?: string,
    workspaceDir?: string,
    bootstrapFiles?: WorkspaceBootstrapFile[],
    cfg?: OpenClawConfig
  }
}
```

## Tipos de eventos

### Eventos de comando

Activados cuando se emiten comandos del agente:

- **`command`**: Todos los eventos de comando (oyente general)
- **`command:new`**: Cuando se ejecuta el comando `/new`
- **`command:reset`**: Cuando se ejecuta el comando `/reset`
- **`command:stop`**: Cuando se ejecuta el comando `/stop`

### Eventos del agente

- **`agent:bootstrap`**: Antes de que se inyecten los archivos de inicialización del espacio de trabajo (los hooks pueden mutar `context.bootstrapFiles`)

### Eventos del Gateway

Activados cuando el gateway inicia:

- **`gateway:startup`**: Después de que los canales inicien y los hooks se carguen

### Hooks de resultado de herramientas (API de Plugin)

Estos hooks no son oyentes de flujo de eventos; permiten a los plugins ajustar sincrónicamente los resultados de herramientas antes de que OpenClaw los persista.

- **`tool_result_persist`**: transforma los resultados de herramientas antes de que se escriban en la transcripción de la sesión. Debe ser sincrónico; devuelve la carga útil del resultado de herramienta actualizada o `undefined` para mantenerla como está. Ver [Agent Loop](/es-ES/concepts/agent-loop).

### Eventos futuros

Tipos de eventos planificados:

- **`session:start`**: Cuando comienza una nueva sesión
- **`session:end`**: Cuando termina una sesión
- **`agent:error`**: Cuando un agente encuentra un error
- **`message:sent`**: Cuando se envía un mensaje
- **`message:received`**: Cuando se recibe un mensaje

## Crear hooks personalizados

### 1. Elegir ubicación

- **Hooks del espacio de trabajo** (`<workspace>/hooks/`): Por agente, precedencia más alta
- **Hooks gestionados** (`~/.openclaw/hooks/`): Compartidos entre espacios de trabajo

### 2. Crear estructura de directorios

```bash
mkdir -p ~/.openclaw/hooks/my-hook
cd ~/.openclaw/hooks/my-hook
```

### 3. Crear HOOK.md

```markdown
---
name: my-hook
description: "Hace algo útil"
metadata: { "openclaw": { "emoji": "🎯", "events": ["command:new"] } }
---

# My Custom Hook

Este hook hace algo útil cuando ejecutas `/new`.
```

### 4. Crear handler.ts

```typescript
import type { HookHandler } from "../../src/hooks/hooks.js";

const handler: HookHandler = async (event) => {
  if (event.type !== "command" || event.action !== "new") {
    return;
  }

  console.log("[my-hook] ¡Ejecutando!");
  // Tu lógica aquí
};

export default handler;
```

### 5. Habilitar y probar

```bash
# Verificar que el hook se descubre
openclaw hooks list

# Habilitarlo
openclaw hooks enable my-hook

# Reinicia tu proceso gateway (reinicio de app de barra de menú en macOS, o reinicia tu proceso dev)

# Activar el evento
# Envía /new mediante tu canal de mensajería
```

## Configuración

### Nuevo formato de configuración (recomendado)

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "session-memory": { "enabled": true },
        "command-logger": { "enabled": false }
      }
    }
  }
}
```

### Configuración por hook

Los hooks pueden tener configuración personalizada:

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "my-hook": {
          "enabled": true,
          "env": {
            "MY_CUSTOM_VAR": "value"
          }
        }
      }
    }
  }
}
```

### Directorios adicionales

Cargar hooks desde directorios adicionales:

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "load": {
        "extraDirs": ["/path/to/more/hooks"]
      }
    }
  }
}
```

### Formato de configuración heredado (aún compatible)

El formato de configuración antiguo aún funciona por compatibilidad hacia atrás:

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "handlers": [
        {
          "event": "command:new",
          "module": "./hooks/handlers/my-handler.ts",
          "export": "default"
        }
      ]
    }
  }
}
```

Nota: `module` debe ser una ruta relativa al espacio de trabajo. Las rutas absolutas y el recorrido fuera del espacio de trabajo son rechazados.

**Migración**: Usa el nuevo sistema basado en descubrimiento para nuevos hooks. Los manejadores heredados se cargan después de los hooks basados en directorios.

## Comandos CLI

### Listar hooks

```bash
# Listar todos los hooks
openclaw hooks list

# Mostrar solo hooks elegibles
openclaw hooks list --eligible

# Salida detallada (mostrar requisitos faltantes)
openclaw hooks list --verbose

# Salida JSON
openclaw hooks list --json
```

### Información del hook

```bash
# Mostrar información detallada sobre un hook
openclaw hooks info session-memory

# Salida JSON
openclaw hooks info session-memory --json
```

### Verificar elegibilidad

```bash
# Mostrar resumen de elegibilidad
openclaw hooks check

# Salida JSON
openclaw hooks check --json
```

### Habilitar/Deshabilitar

```bash
# Habilitar un hook
openclaw hooks enable session-memory

# Deshabilitar un hook
openclaw hooks disable command-logger
```

## Referencia de hooks incluidos

### session-memory

Guarda el contexto de la sesión en memoria cuando ejecutas `/new`.

**Eventos**: `command:new`

**Requisitos**: `workspace.dir` debe estar configurado

**Salida**: `<workspace>/memory/YYYY-MM-DD-slug.md` (por defecto `~/.openclaw/workspace`)

**Qué hace**:

1. Usa la entrada de sesión pre-reset para localizar la transcripción correcta
2. Extrae las últimas 15 líneas de conversación
3. Usa LLM para generar un slug descriptivo de nombre de archivo
4. Guarda los metadatos de sesión en un archivo de memoria fechado

**Ejemplo de salida**:

```markdown
# Session: 2026-01-16 14:30:00 UTC

- **Session Key**: agent:main:main
- **Session ID**: abc123def456
- **Source**: telegram
```

**Ejemplos de nombres de archivo**:

- `2026-01-16-vendor-pitch.md`
- `2026-01-16-api-design.md`
- `2026-01-16-1430.md` (marca de tiempo de respaldo si falla la generación de slug)

**Habilitar**:

```bash
openclaw hooks enable session-memory
```

### bootstrap-extra-files

Inyecta archivos de inicialización adicionales (por ejemplo `AGENTS.md` / `TOOLS.md` locales de monorepo) durante `agent:bootstrap`.

**Eventos**: `agent:bootstrap`

**Requisitos**: `workspace.dir` debe estar configurado

**Salida**: No se escriben archivos; el contexto de inicialización se modifica solo en memoria.

**Config**:

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "bootstrap-extra-files": {
          "enabled": true,
          "paths": ["packages/*/AGENTS.md", "packages/*/TOOLS.md"]
        }
      }
    }
  }
}
```

**Notas**:

- Las rutas se resuelven relativas al espacio de trabajo.
- Los archivos deben permanecer dentro del espacio de trabajo (verificados con realpath).
- Solo se cargan nombres base de inicialización reconocidos.
- Se preserva la lista de permitidos de subagentes (solo `AGENTS.md` y `TOOLS.md`).

**Habilitar**:

```bash
openclaw hooks enable bootstrap-extra-files
```

### command-logger

Registra todos los eventos de comandos en un archivo de auditoría centralizado.

**Eventos**: `command`

**Requisitos**: Ninguno

**Salida**: `~/.openclaw/logs/commands.log`

**Qué hace**:

1. Captura detalles del evento (acción de comando, marca de tiempo, clave de sesión, ID de remitente, origen)
2. Agrega al archivo de registro en formato JSONL
3. Se ejecuta silenciosamente en segundo plano

**Ejemplos de entradas de registro**:

```jsonl
{"timestamp":"2026-01-16T14:30:00.000Z","action":"new","sessionKey":"agent:main:main","senderId":"+1234567890","source":"telegram"}
{"timestamp":"2026-01-16T15:45:22.000Z","action":"stop","sessionKey":"agent:main:main","senderId":"user@example.com","source":"whatsapp"}
```

**Ver registros**:

```bash
# Ver comandos recientes
tail -n 20 ~/.openclaw/logs/commands.log

# Imprimir con formato usando jq
cat ~/.openclaw/logs/commands.log | jq .

# Filtrar por acción
grep '"action":"new"' ~/.openclaw/logs/commands.log | jq .
```

**Habilitar**:

```bash
openclaw hooks enable command-logger
```

### boot-md

Ejecuta `BOOT.md` cuando el gateway inicia (después de que los canales inicien).
Los hooks internos deben estar habilitados para que esto se ejecute.

**Eventos**: `gateway:startup`

**Requisitos**: `workspace.dir` debe estar configurado

**Qué hace**:

1. Lee `BOOT.md` de tu espacio de trabajo
2. Ejecuta las instrucciones mediante el ejecutor del agente
3. Envía cualquier mensaje de salida solicitado mediante la herramienta de mensaje

**Habilitar**:

```bash
openclaw hooks enable boot-md
```

## Mejores prácticas

### Mantén los manejadores rápidos

Los hooks se ejecutan durante el procesamiento de comandos. Manténlos ligeros:

```typescript
// ✓ Bueno - trabajo asíncrono, retorna inmediatamente
const handler: HookHandler = async (event) => {
  void processInBackground(event); // Lanzar y olvidar
};

// ✗ Malo - bloquea el procesamiento de comandos
const handler: HookHandler = async (event) => {
  await slowDatabaseQuery(event);
  await evenSlowerAPICall(event);
};
```

### Maneja los errores con gracia

Siempre envuelve operaciones riesgosas:

```typescript
const handler: HookHandler = async (event) => {
  try {
    await riskyOperation(event);
  } catch (err) {
    console.error("[my-handler] Falló:", err instanceof Error ? err.message : String(err));
    // No lanzar - dejar que otros manejadores se ejecuten
  }
};
```

### Filtra eventos temprano

Retorna temprano si el evento no es relevante:

```typescript
const handler: HookHandler = async (event) => {
  // Solo manejar comandos 'new'
  if (event.type !== "command" || event.action !== "new") {
    return;
  }

  // Tu lógica aquí
};
```

### Usa claves de evento específicas

Especifica eventos exactos en metadatos cuando sea posible:

```yaml
metadata: { "openclaw": { "events": ["command:new"] } } # Específico
```

En lugar de:

```yaml
metadata: { "openclaw": { "events": ["command"] } } # General - más sobrecarga
```

## Depuración

### Habilitar registro de hooks

El gateway registra la carga de hooks al inicio:

```
Registered hook: session-memory -> command:new
Registered hook: bootstrap-extra-files -> agent:bootstrap
Registered hook: command-logger -> command
Registered hook: boot-md -> gateway:startup
```

### Verificar descubrimiento

Listar todos los hooks descubiertos:

```bash
openclaw hooks list --verbose
```

### Verificar registro

En tu manejador, registra cuando se llame:

```typescript
const handler: HookHandler = async (event) => {
  console.log("[my-handler] Activado:", event.type, event.action);
  // Tu lógica
};
```

### Verificar elegibilidad

Verifica por qué un hook no es elegible:

```bash
openclaw hooks info my-hook
```

Busca requisitos faltantes en la salida.

## Pruebas

### Registros del Gateway

Monitorea los registros del gateway para ver la ejecución de hooks:

```bash
# macOS
./scripts/clawlog.sh -f

# Otras plataformas
tail -f ~/.openclaw/gateway.log
```

### Probar hooks directamente

Prueba tus manejadores de forma aislada:

```typescript
import { test } from "vitest";
import { createHookEvent } from "./src/hooks/hooks.js";
import myHandler from "./hooks/my-hook/handler.js";

test("my handler works", async () => {
  const event = createHookEvent("command", "new", "test-session", {
    foo: "bar",
  });

  await myHandler(event);

  // Afirmar efectos secundarios
});
```

## Arquitectura

### Componentes principales

- **`src/hooks/types.ts`**: Definiciones de tipos
- **`src/hooks/workspace.ts`**: Escaneo y carga de directorios
- **`src/hooks/frontmatter.ts`**: Análisis de metadatos HOOK.md
- **`src/hooks/config.ts`**: Verificación de elegibilidad
- **`src/hooks/hooks-status.ts`**: Informe de estado
- **`src/hooks/loader.ts`**: Cargador de módulos dinámicos
- **`src/cli/hooks-cli.ts`**: Comandos CLI
- **`src/gateway/server-startup.ts`**: Carga hooks al inicio del gateway
- **`src/auto-reply/reply/commands-core.ts`**: Activa eventos de comando

### Flujo de descubrimiento

```
Inicio del Gateway
    ↓
Escanear directorios (workspace → gestionado → incluido)
    ↓
Analizar archivos HOOK.md
    ↓
Verificar elegibilidad (bins, env, config, os)
    ↓
Cargar manejadores de hooks elegibles
    ↓
Registrar manejadores para eventos
```

### Flujo de eventos

```
Usuario envía /new
    ↓
Validación de comando
    ↓
Crear evento de hook
    ↓
Activar hook (todos los manejadores registrados)
    ↓
Continúa procesamiento de comando
    ↓
Reset de sesión
```

## Solución de problemas

### Hook no descubierto

1. Verifica la estructura de directorios:

   ```bash
   ls -la ~/.openclaw/hooks/my-hook/
   # Debería mostrar: HOOK.md, handler.ts
   ```

2. Verifica el formato de HOOK.md:

   ```bash
   cat ~/.openclaw/hooks/my-hook/HOOK.md
   # Debería tener frontmatter YAML con name y metadata
   ```

3. Lista todos los hooks descubiertos:

   ```bash
   openclaw hooks list
   ```

### Hook no elegible

Verifica los requisitos:

```bash
openclaw hooks info my-hook
```

Busca faltantes:

- Binarios (verifica PATH)
- Variables de entorno
- Valores de configuración
- Compatibilidad de SO

### Hook no se ejecuta

1. Verifica que el hook está habilitado:

   ```bash
   openclaw hooks list
   # Debería mostrar ✓ junto a hooks habilitados
   ```

2. Reinicia tu proceso gateway para que los hooks se recarguen.

3. Verifica los registros del gateway en busca de errores:

   ```bash
   ./scripts/clawlog.sh | grep hook
   ```

### Errores del manejador

Verifica errores de TypeScript/importación:

```bash
# Probar importación directamente
node -e "import('./path/to/handler.ts').then(console.log)"
```

## Guía de migración

### De configuración heredada a descubrimiento

**Antes**:

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "handlers": [
        {
          "event": "command:new",
          "module": "./hooks/handlers/my-handler.ts"
        }
      ]
    }
  }
}
```

**Después**:

1. Crear directorio de hook:

   ```bash
   mkdir -p ~/.openclaw/hooks/my-hook
   mv ./hooks/handlers/my-handler.ts ~/.openclaw/hooks/my-hook/handler.ts
   ```

2. Crear HOOK.md:

   ```markdown
   ---
   name: my-hook
   description: "Mi hook personalizado"
   metadata: { "openclaw": { "emoji": "🎯", "events": ["command:new"] } }
   ---

   # My Hook

   Hace algo útil.
   ```

3. Actualizar config:

   ```json
   {
     "hooks": {
       "internal": {
         "enabled": true,
         "entries": {
           "my-hook": { "enabled": true }
         }
       }
     }
   }
   ```

4. Verificar y reiniciar tu proceso gateway:

   ```bash
   openclaw hooks list
   # Debería mostrar: 🎯 my-hook ✓
   ```

**Beneficios de la migración**:

- Descubrimiento automático
- Gestión CLI
- Verificación de elegibilidad
- Mejor documentación
- Estructura consistente

## Ver también

- [Referencia CLI: hooks](/es-ES/cli/hooks)
- [README de Hooks incluidos](https://github.com/openclaw/openclaw/tree/main/src/hooks/bundled)
- [Webhook Hooks](/es-ES/automation/webhook)
- [Configuración](/es-ES/gateway/configuration#hooks)
