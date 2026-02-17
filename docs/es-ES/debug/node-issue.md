---
summary: Notas y soluciones del fallo "\_\_name is not a function" con Node + tsx
read_when:
  - Depurando scripts de desarrollo exclusivos de Node o fallos en modo watch
  - Investigando fallos del cargador tsx/esbuild en OpenClaw
title: "Fallo de Node + tsx"
---

# Fallo de Node + tsx "\_\_name is not a function"

## Resumen

Ejecutar OpenClaw mediante Node con `tsx` falla al iniciar con:

```
[openclaw] Failed to start CLI: TypeError: __name is not a function
    at createSubsystemLogger (.../src/logging/subsystem.ts:203:25)
    at .../src/agents/auth-profiles/constants.ts:25:20
```

Esto comenzó después de cambiar los scripts de desarrollo de Bun a `tsx` (commit `2871657e`, 2026-01-06). La misma ruta de ejecución funcionaba con Bun.

## Entorno

- Node: v25.x (observado en v25.3.0)
- tsx: 4.21.0
- SO: macOS (reproducción probablemente también en otras plataformas que ejecutan Node 25)

## Reproducción (solo Node)

```bash
# en la raíz del repositorio
node --version
pnpm install
node --import tsx src/entry.ts status
```

## Reproducción mínima en el repositorio

```bash
node --import tsx scripts/repro/tsx-name-repro.ts
```

## Verificación de versión de Node

- Node 25.3.0: falla
- Node 22.22.0 (Homebrew `node@22`): falla
- Node 24: aún no instalado aquí; necesita verificación

## Notas / hipótesis

- `tsx` usa esbuild para transformar TS/ESM. El `keepNames` de esbuild emite un helper `__name` y envuelve definiciones de funciones con `__name(...)`.
- El fallo indica que `__name` existe pero no es una función en tiempo de ejecución, lo que implica que el helper falta o fue sobrescrito para este módulo en la ruta del cargador de Node 25.
- Problemas similares con el helper `__name` han sido reportados en otros consumidores de esbuild cuando el helper falta o es reescrito.

## Historial de regresión

- `2871657e` (2026-01-06): scripts cambiados de Bun a tsx para hacer Bun opcional.
- Antes de eso (ruta Bun), `openclaw status` y `gateway:watch` funcionaban.

## Soluciones alternativas

- Usar Bun para scripts de desarrollo (reversión temporal actual).
- Usar Node + tsc watch, luego ejecutar la salida compilada:

  ```bash
  pnpm exec tsc --watch --preserveWatchOutput
  node --watch openclaw.mjs status
  ```

- Confirmado localmente: `pnpm exec tsc -p tsconfig.json` + `node openclaw.mjs status` funciona en Node 25.
- Deshabilitar keepNames de esbuild en el cargador TS si es posible (previene la inserción del helper `__name`); tsx actualmente no expone esto.
- Probar Node LTS (22/24) con `tsx` para ver si el problema es específico de Node 25.

## Referencias

- [https://opennext.js.org/cloudflare/howtos/keep_names](https://opennext.js.org/cloudflare/howtos/keep_names)
- [https://esbuild.github.io/api/#keep-names](https://esbuild.github.io/api/#keep-names)
- [https://github.com/evanw/esbuild/issues/1031](https://github.com/evanw/esbuild/issues/1031)

## Próximos pasos

- Reproducir en Node 22/24 para confirmar regresión de Node 25.
- Probar `tsx` nightly o fijar versión anterior si existe una regresión conocida.
- Si se reproduce en Node LTS, presentar una reproducción mínima upstream con el stack trace de `__name`.
