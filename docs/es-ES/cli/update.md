---
summary: "Referencia CLI para `openclaw update` (actualización segura de código fuente + reinicio automático del gateway)"
read_when:
  - Quieres actualizar un checkout de código fuente de forma segura
  - Necesitas entender el comportamiento del atajo `--update`
title: "update"
---

# `openclaw update`

Actualizar OpenClaw de forma segura y cambiar entre canales stable/beta/dev.

Si instalaste mediante **npm/pnpm** (instalación global, sin metadatos de git), las actualizaciones ocurren mediante el flujo del gestor de paquetes en [Actualizando](/es-ES/install/updating).

## Uso

```bash
openclaw update
openclaw update status
openclaw update wizard
openclaw update --channel beta
openclaw update --channel dev
openclaw update --tag beta
openclaw update --no-restart
openclaw update --json
openclaw --update
```

## Opciones

- `--no-restart`: omitir reinicio del servicio Gateway después de una actualización exitosa.
- `--channel <stable|beta|dev>`: establecer el canal de actualización (git + npm; persistido en configuración).
- `--tag <dist-tag|version>`: anular el dist-tag o versión de npm solo para esta actualización.
- `--json`: imprimir JSON `UpdateRunResult` legible por máquina.
- `--timeout <seconds>`: timeout por paso (predeterminado es 1200s).

Nota: las degradaciones requieren confirmación porque las versiones antiguas pueden romper la configuración.

## `update status`

Mostrar el canal de actualización activo + tag/rama/SHA de git (para checkouts de código fuente), además de disponibilidad de actualización.

```bash
openclaw update status
openclaw update status --json
openclaw update status --timeout 10
```

Opciones:

- `--json`: imprimir JSON de estado legible por máquina.
- `--timeout <seconds>`: timeout para verificaciones (predeterminado es 3s).

## `update wizard`

Flujo interactivo para elegir un canal de actualización y confirmar si reiniciar el Gateway
después de actualizar (predeterminado es reiniciar). Si seleccionas `dev` sin un checkout de git,
ofrece crear uno.

## Qué hace

Cuando cambias canales explícitamente (`--channel ...`), OpenClaw también mantiene el
método de instalación alineado:

- `dev` → asegura un checkout de git (predeterminado: `~/openclaw`, anular con `OPENCLAW_GIT_DIR`),
  lo actualiza, e instala el CLI global desde ese checkout.
- `stable`/`beta` → instala desde npm usando el dist-tag correspondiente.

## Flujo de checkout de git

Canales:

- `stable`: checkout del último tag no-beta, luego build + doctor.
- `beta`: checkout del último tag `-beta`, luego build + doctor.
- `dev`: checkout `main`, luego fetch + rebase.

Alto nivel:

1. Requiere un worktree limpio (sin cambios no confirmados).
2. Cambia al canal seleccionado (tag o rama).
3. Hace fetch upstream (solo dev).
4. Solo dev: preflight lint + build TypeScript en un worktree temporal; si el tip falla, retrocede hasta 10 commits para encontrar el build limpio más reciente.
5. Hace rebase al commit seleccionado (solo dev).
6. Instala dependencias (preferido pnpm; fallback npm).
7. Construye + construye la Interfaz de Control.
8. Ejecuta `openclaw doctor` como verificación final de "actualización segura".
9. Sincroniza plugins al canal activo (dev usa extensiones empaquetadas; stable/beta usa npm) y actualiza plugins instalados vía npm.

## Atajo `--update`

`openclaw --update` se reescribe a `openclaw update` (útil para shells y scripts de lanzamiento).

## Ver también

- `openclaw doctor` (ofrece ejecutar update primero en checkouts de git)
- [Canales de desarrollo](/es-ES/install/development-channels)
- [Actualizando](/es-ES/install/updating)
- [Referencia CLI](/es-ES/cli)
