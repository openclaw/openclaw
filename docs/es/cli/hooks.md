---
summary: "Referencia de la CLI para `openclaw hooks` (hooks del agente)"
read_when:
  - Quiere administrar hooks del agente
  - Quiere instalar o actualizar hooks
title: "hooks"
---

# `openclaw hooks`

Administre hooks del agente (automatizaciones impulsadas por eventos para comandos como `/new`, `/reset` y el inicio del Gateway).

Relacionado:

- Hooks: [Hooks](/automation/hooks)
- Hooks de plugins: [Plugins](/tools/plugin#plugin-hooks)

## Listar todos los hooks

```bash
openclaw hooks list
```

Enumera todos los hooks descubiertos desde los directorios del espacio de trabajo, gestionados y empaquetados.

**Opciones:**

- `--eligible`: Mostrar solo hooks elegibles (requisitos cumplidos)
- `--json`: Salida en formato JSON
- `-v, --verbose`: Mostrar información detallada, incluidos los requisitos faltantes

**Ejemplo de salida:**

```
Hooks (4/4 ready)

Ready:
  🚀 boot-md ✓ - Run BOOT.md on gateway startup
  📝 command-logger ✓ - Log all command events to a centralized audit file
  💾 session-memory ✓ - Save session context to memory when /new command is issued
  😈 soul-evil ✓ - Swap injected SOUL content during a purge window or by random chance
```

**Ejemplo (detallado):**

```bash
openclaw hooks list --verbose
```

Muestra los requisitos faltantes para hooks no elegibles.

**Ejemplo (JSON):**

```bash
openclaw hooks list --json
```

Devuelve JSON estructurado para uso programático.

## Obtener información de un hook

```bash
openclaw hooks info <name>
```

Muestra información detallada sobre un hook específico.

**Argumentos:**

- `<name>`: Nombre del hook (p. ej., `session-memory`)

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
  Homepage: https://docs.openclaw.ai/hooks#session-memory
  Events: command:new

Requirements:
  Config: ✓ workspace.dir
```

## Comprobar la elegibilidad de los hooks

```bash
openclaw hooks check
```

Muestra un resumen del estado de elegibilidad de los hooks (cuántos están listos frente a los que no).

**Opciones:**

- `--json`: Salida en formato JSON

**Ejemplo de salida:**

```
Hooks Status

Total hooks: 4
Ready: 4
Not ready: 0
```

## Habilitar un hook

```bash
openclaw hooks enable <name>
```

Habilita un hook específico agregándolo a su configuración (`~/.openclaw/config.json`).

**Nota:** Los hooks gestionados por plugins muestran `plugin:<id>` en `openclaw hooks list` y
no se pueden habilitar/deshabilitar aquí. Habilite o deshabilite el plugin en su lugar.

**Argumentos:**

- `<name>`: Nombre del hook (p. ej., `session-memory`)

**Ejemplo:**

```bash
openclaw hooks enable session-memory
```

**Salida:**

```
✓ Enabled hook: 💾 session-memory
```

**Qué hace:**

- Verifica si el hook existe y es elegible
- Actualiza `hooks.internal.entries.<name>.enabled = true` en su configuración
- Guarda la configuración en el disco

**Después de habilitar:**

- Reinicie el Gateway para que los hooks se recarguen (reinicio de la app de la barra de menú en macOS, o reinicie su proceso del Gateway en desarrollo).

## Deshabilitar un hook

```bash
openclaw hooks disable <name>
```

Deshabilita un hook específico actualizando su configuración.

**Argumentos:**

- `<name>`: Nombre del hook (p. ej., `command-logger`)

**Ejemplo:**

```bash
openclaw hooks disable command-logger
```

**Salida:**

```
⏸ Disabled hook: 📝 command-logger
```

**Después de deshabilitar:**

- Reinicie el Gateway para que los hooks se recarguen

## Instalar hooks

```bash
openclaw hooks install <path-or-spec>
```

Instala un paquete de hooks desde una carpeta/archivo local o npm.

**Qué hace:**

- Copia el paquete de hooks en `~/.openclaw/hooks/<id>`
- Habilita los hooks instalados en `hooks.internal.entries.*`
- Registra la instalación en `hooks.internal.installs`

**Opciones:**

- `-l, --link`: Vincular un directorio local en lugar de copiarlo (lo agrega a `hooks.internal.load.extraDirs`)

**Archivos compatibles:** `.zip`, `.tgz`, `.tar.gz`, `.tar`

**Ejemplos:**

```bash
# Local directory
openclaw hooks install ./my-hook-pack

# Local archive
openclaw hooks install ./my-hook-pack.zip

# NPM package
openclaw hooks install @openclaw/my-hook-pack

# Link a local directory without copying
openclaw hooks install -l ./my-hook-pack
```

## Actualizar hooks

```bash
openclaw hooks update <id>
openclaw hooks update --all
```

Actualiza los paquetes de hooks instalados (solo instalaciones desde npm).

**Opciones:**

- `--all`: Actualizar todos los paquetes de hooks rastreados
- `--dry-run`: Mostrar qué cambiaría sin escribir cambios

## Hooks incluidos

### session-memory

Guarda el contexto de la sesión en memoria cuando emite `/new`.

**Habilitar:**

```bash
openclaw hooks enable session-memory
```

**Salida:** `~/.openclaw/workspace/memory/YYYY-MM-DD-slug.md`

**Ver:** [documentación de session-memory](/automation/hooks#session-memory)

### command-logger

Registra todos los eventos de comandos en un archivo de auditoría centralizado.

**Habilitar:**

```bash
openclaw hooks enable command-logger
```

**Salida:** `~/.openclaw/logs/commands.log`

**Ver registros:**

```bash
# Recent commands
tail -n 20 ~/.openclaw/logs/commands.log

# Pretty-print
cat ~/.openclaw/logs/commands.log | jq .

# Filter by action
grep '"action":"new"' ~/.openclaw/logs/commands.log | jq .
```

**Ver:** [documentación de command-logger](/automation/hooks#command-logger)

### soul-evil

Intercambia contenido inyectado de `SOUL.md` con `SOUL_EVIL.md` durante una ventana de purga o por probabilidad aleatoria.

**Habilitar:**

```bash
openclaw hooks enable soul-evil
```

**Ver:** [SOUL Evil Hook](/hooks/soul-evil)

### boot-md

Ejecuta `BOOT.md` cuando el Gateway se inicia (después de que los canales se inician).

**Eventos**: `gateway:startup`

**Habilitar**:

```bash
openclaw hooks enable boot-md
```

**Ver:** [documentación de boot-md](/automation/hooks#boot-md)
