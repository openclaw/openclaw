---
summary: "Cómo ejecutar pruebas localmente (vitest) y cuándo usar los modos force/coverage"
read_when:
  - Ejecutando o arreglando pruebas
title: "Pruebas"
---

# Pruebas

- Kit completo de pruebas (suites, live, Docker): [Pruebas](/es-ES/help/testing)

- `pnpm test:force`: Elimina cualquier proceso de gateway persistente que esté ocupando el puerto de control predeterminado, luego ejecuta la suite completa de Vitest con un puerto de gateway aislado para que las pruebas de servidor no colisionen con una instancia en ejecución. Usa esto cuando una ejecución previa del gateway dejó el puerto 18789 ocupado.
- `pnpm test:coverage`: Ejecuta la suite de unidades con cobertura V8 (a través de `vitest.unit.config.ts`). Los umbrales globales son 70% de líneas/ramas/funciones/sentencias. La cobertura excluye puntos de entrada con mucha integración (cableado CLI, puentes gateway/telegram, servidor estático webchat) para mantener el objetivo enfocado en lógica testeable por unidades.
- `pnpm test` en Node 24+: OpenClaw deshabilita automáticamente `vmForks` de Vitest y usa `forks` para evitar `ERR_VM_MODULE_LINK_FAILURE` / `module is already linked`. Puedes forzar el comportamiento con `OPENCLAW_TEST_VM_FORKS=0|1`.
- `pnpm test:e2e`: Ejecuta pruebas de smoke end-to-end del gateway (multi-instancia WS/HTTP/emparejamiento de nodos). Por defecto usa `vmForks` + workers adaptativos en `vitest.e2e.config.ts`; ajusta con `OPENCLAW_E2E_WORKERS=<n>` y establece `OPENCLAW_E2E_VERBOSE=1` para logs detallados.
- `pnpm test:live`: Ejecuta pruebas live de proveedores (minimax/zai). Requiere claves de API y `LIVE=1` (o `*_LIVE_TEST=1` específico del proveedor) para no saltarlas.

## Benchmark de latencia de modelo (claves locales)

Script: [`scripts/bench-model.ts`](https://github.com/openclaw/openclaw/blob/main/scripts/bench-model.ts)

Uso:

- `source ~/.profile && pnpm tsx scripts/bench-model.ts --runs 10`
- Variables de entorno opcionales: `MINIMAX_API_KEY`, `MINIMAX_BASE_URL`, `MINIMAX_MODEL`, `ANTHROPIC_API_KEY`
- Prompt predeterminado: "Reply with a single word: ok. No punctuation or extra text."

Última ejecución (2025-12-31, 20 ejecuciones):

- minimax mediana 1279ms (mín 1114, máx 2431)
- opus mediana 2454ms (mín 1224, máx 3170)

## E2E de incorporación (Docker)

Docker es opcional; esto solo es necesario para pruebas de smoke de incorporación en contenedor.

Flujo de arranque en frío completo en un contenedor Linux limpio:

```bash
scripts/e2e/onboard-docker.sh
```

Este script conduce el asistente interactivo a través de un pseudo-tty, verifica archivos de config/workspace/sesión, luego inicia el gateway y ejecuta `openclaw health`.

## Smoke de importación QR (Docker)

Asegura que `qrcode-terminal` se cargue bajo Node 22+ en Docker:

```bash
pnpm test:docker:qr
```
