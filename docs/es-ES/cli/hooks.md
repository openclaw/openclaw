---
summary: "Referencia CLI para `openclaw hooks` (hooks de agente)"
read_when:
  - Quieres gestionar hooks de agente
  - Quieres instalar o actualizar hooks
title: "hooks"
---

# `openclaw hooks`

Gestionar hooks de agente (automatizaciones basadas en eventos para comandos como `/new`, `/reset` e inicio del gateway).

Relacionado:

- Hooks: [Hooks](/es-ES/automation/hooks)
- Hooks de plugins: [Plugins](/es-ES/tools/plugin#plugin-hooks)

## Listar Todos los Hooks

```bash
openclaw hooks list
```

Lista todos los hooks descubiertos de los directorios de workspace, gestionados y empaquetados.

**Opciones:**

- `--eligible`: Mostrar solo hooks elegibles (requisitos cumplidos)
- `--json`: Salida en formato JSON
- `-v, --verbose`: Mostrar información detallada incluyendo requisitos faltantes

**Salida de ejemplo:**

```
Hooks (4/4 ready)

Ready:
  🚀 boot-md ✓ - Run BOOT.md on gateway startup
  📎 bootstrap-extra-files ✓ - Inject extra workspace bootstrap files during agent bootstrap
  📝 command-logger ✓ - Log all command events to a centralized audit file
  💾 session-memory ✓ - Save session context to memory when /new command is issued
```

**Ejemplo (verbose):**

```bash
openclaw hooks list --verbose
```

Muestra requisitos faltantes para hooks no elegibles.

**Ejemplo (JSON):**

```bash
openclaw hooks list --json
```

Devuelve JSON estructurado para uso programático.

## Obtener Información del Hook

```bash
openclaw hooks info <name>
```

Mostrar información detallada sobre un hook específico.

**Argumentos:**

- `<name>`: Nombre del hook (ej., `session-memory`)

**Opciones:**

- `--json`: Salida en formato JSON

**Ejemplo:**

```bash
openclaw hooks info session-memory
```

**Salida:**

```
💾 session-memory ✓ Ready

Save session context to memory when /new command is issued

Details:
  Source: openclaw-bundled
  Path: /path/to/openclaw/hooks/bundled/session-memory/HOOK.md
  Handler: /path/to/openclaw/hooks/bundled/session-memory/handler.ts
  Homepage: https://docs.openclaw.ai/automation/hooks#session-memory
  Events: command:new

Requirements:
  Config: ✓ workspace.dir
```

## Verificar Elegibilidad de Hooks

```bash
openclaw hooks check
```

Mostrar resumen del estado de elegibilidad de hooks (cuántos están listos vs. no listos).

**Opciones:**

- `--json`: Salida en formato JSON

**Salida de ejemplo:**

```
Hooks Status

Total hooks: 4
Ready: 4
Not ready: 0
```

## Habilitar un Hook

```bash
openclaw hooks enable <name>
```

Habilitar un hook específico agregándolo a tu configuración (`~/.openclaw/config.json`).

**Nota:** Los hooks gestionados por plugins muestran `plugin:<id>` en `openclaw hooks list` y
no pueden habilitarse/deshabilitarse aquí. Habilita/deshabilita el plugin en su lugar.

**Argumentos:**

- `<name>`: Nombre del hook (ej., `session-memory`)

**Ejemplo:**

```bash
openclaw hooks enable session-memory
```

**Salida:**

```
✓ Enabled hook: 💾 session-memory
```

**Lo que hace:**

- Verifica si el hook existe y es elegible
- Actualiza `hooks.internal.entries.<name>.enabled = true` en tu configuración
- Guarda la configuración en disco

**Después de habilitar:**

- Reinicia el gateway para que los hooks se recarguen (reinicio de la app de barra de menú en macOS, o reinicia tu proceso de gateway en desarrollo).

## Deshabilitar un Hook

```bash
openclaw hooks disable <name>
```

Deshabilitar un hook específico actualizando tu configuración.

**Argumentos:**

- `<name>`: Nombre del hook (ej., `command-logger`)

**Ejemplo:**

```bash
openclaw hooks disable command-logger
```

**Salida:**

```
⏸ Disabled hook: 📝 command-logger
```

**Después de deshabilitar:**

- Reinicia el gateway para que los hooks se recarguen

## Instalar Hooks

```bash
openclaw hooks install <path-or-spec>
```

Instalar un paquete de hooks desde una carpeta/archivo local o npm.

Las especificaciones npm son **solo de registro** (nombre del paquete + versión/etiqueta opcional). Las
especificaciones git/URL/archivo son rechazadas. Las instalaciones de dependencias se ejecutan con `--ignore-scripts` por seguridad.

**Lo que hace:**

- Copia el paquete de hooks en `~/.openclaw/hooks/<id>`
- Habilita los hooks instalados en `hooks.internal.entries.*`
- Registra la instalación bajo `hooks.internal.installs`

**Opciones:**

- `-l, --link`: Vincular un directorio local en lugar de copiar (lo agrega a `hooks.internal.load.extraDirs`)

**Archivos compatibles:** `.zip`, `.tgz`, `.tar.gz`, `.tar`

**Ejemplos:**

```bash
# Directorio local
openclaw hooks install ./my-hook-pack

# Archivo local
openclaw hooks install ./my-hook-pack.zip

# Paquete NPM
openclaw hooks install @openclaw/my-hook-pack

# Vincular un directorio local sin copiar
openclaw hooks install -l ./my-hook-pack
```

## Actualizar Hooks

```bash
openclaw hooks update <id>
openclaw hooks update --all
```

Actualizar paquetes de hooks instalados (solo instalaciones de npm).

**Opciones:**

- `--all`: Actualizar todos los paquetes de hooks rastreados
- `--dry-run`: Mostrar qué cambiaría sin escribir

## Hooks Empaquetados

### session-memory

Guarda el contexto de la sesión en memoria cuando ejecutas `/new`.

**Habilitar:**

```bash
openclaw hooks enable session-memory
```

**Salida:** `~/.openclaw/workspace/memory/YYYY-MM-DD-slug.md`

**Ver:** [documentación de session-memory](/es-ES/automation/hooks#session-memory)

### bootstrap-extra-files

Inyecta archivos de bootstrap adicionales (por ejemplo, `AGENTS.md` / `TOOLS.md` locales de monorepo) durante `agent:bootstrap`.

**Habilitar:**

```bash
openclaw hooks enable bootstrap-extra-files
```

**Ver:** [documentación de bootstrap-extra-files](/es-ES/automation/hooks#bootstrap-extra-files)

### command-logger

Registra todos los eventos de comando en un archivo de auditoría centralizado.

**Habilitar:**

```bash
openclaw hooks enable command-logger
```

**Salida:** `~/.openclaw/logs/commands.log`

**Ver registros:**

```bash
# Comandos recientes
tail -n 20 ~/.openclaw/logs/commands.log

# Formato bonito
cat ~/.openclaw/logs/commands.log | jq .

# Filtrar por acción
grep '"action":"new"' ~/.openclaw/logs/commands.log | jq .
```

**Ver:** [documentación de command-logger](/es-ES/automation/hooks#command-logger)

### boot-md

Ejecuta `BOOT.md` cuando el gateway inicia (después de que los canales inicien).

**Eventos**: `gateway:startup`

**Habilitar**:

```bash
openclaw hooks enable boot-md
```

**Ver:** [documentación de boot-md](/es-ES/automation/hooks#boot-md)
