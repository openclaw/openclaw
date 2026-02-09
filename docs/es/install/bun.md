---
summary: "Flujo de trabajo con Bun (experimental): instalación y consideraciones frente a pnpm"
read_when:
  - Desea el ciclo de desarrollo local más rápido (bun + watch)
  - Tiene problemas con la instalación/parches/scripts de ciclo de vida de Bun
title: "Bun (Experimental)"
---

# Bun (experimental)

Objetivo: ejecutar este repositorio con **Bun** (opcional, no recomendado para WhatsApp/Telegram)
sin divergir de los flujos de trabajo de pnpm.

⚠️ **No recomendado para el runtime del Gateway** (errores en WhatsApp/Telegram). Use Node para producción.

## Estado

- Bun es un runtime local opcional para ejecutar TypeScript directamente (`bun run …`, `bun --watch …`).
- `pnpm` es el valor predeterminado para los builds y sigue siendo totalmente compatible (y usado por algunas herramientas de documentación).
- Bun no puede usar `pnpm-lock.yaml` y lo ignorará.

## Instalación

Predeterminado:

```sh
bun install
```

Nota: `bun.lock`/`bun.lockb` están en gitignore, por lo que no hay cambios en el repositorio de cualquier forma. Si desea _no escribir archivos de bloqueo_:

```sh
bun install --no-save
```

## Build / Test (Bun)

```sh
bun run build
bun run vitest run
```

## Scripts de ciclo de vida de Bun (bloqueados por defecto)

Bun puede bloquear scripts de ciclo de vida de dependencias a menos que se confíen explícitamente (`bun pm untrusted` / `bun pm trust`).
Para este repositorio, los scripts que suelen bloquearse no son necesarios:

- `@whiskeysockets/baileys` `preinstall`: verifica Node mayor >= 20 (ejecutamos Node 22+).
- `protobufjs` `postinstall`: emite advertencias sobre esquemas de versión incompatibles (sin artefactos de build).

Si encuentra un problema real en tiempo de ejecución que requiera estos scripts, confíe en ellos explícitamente:

```sh
bun pm trust @whiskeysockets/baileys protobufjs
```

## Cañadas

- Algunos scripts aún codifican pnpm (p. ej., `docs:build`, `ui:*`, `protocol:check`). Ejecútelos mediante pnpm por ahora.
