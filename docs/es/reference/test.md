---
summary: "Cómo ejecutar pruebas localmente (vitest) y cuándo usar los modos forzar/cobertura"
read_when:
  - Al ejecutar o corregir pruebas
title: "Pruebas"
---

# Pruebas

- Kit completo de pruebas (suites, en vivo, Docker): [Testing](/help/testing)

- `pnpm test:force`: Finaliza cualquier proceso persistente del Gateway que esté ocupando el puerto de control predeterminado y luego ejecuta la suite completa de Vitest con un puerto de Gateway aislado para que las pruebas del servidor no colisionen con una instancia en ejecución. Use esto cuando una ejecución previa del Gateway dejó ocupado el puerto 18789.

- `pnpm test:coverage`: Ejecuta Vitest con cobertura V8. Los umbrales globales son 70% para líneas/ramas/funciones/estadísticas. La cobertura excluye puntos de entrada con mucha integración (cableado de la CLI, puentes gateway/telegram, servidor estático de webchat) para mantener el objetivo enfocado en lógica testeable con pruebas unitarias.

- `pnpm test:e2e`: Ejecuta pruebas de humo end-to-end del Gateway (emparejamiento WS/HTTP/nodo de múltiples instancias).

- `pnpm test:live`: Ejecuta pruebas en vivo de proveedores (minimax/zai). Requiere claves de API y `LIVE=1` (o `*_LIVE_TEST=1` específico del proveedor) para desomitirlas.

## Benchmark de latencia del modelo (claves locales)

Script: [`scripts/bench-model.ts`](https://github.com/openclaw/openclaw/blob/main/scripts/bench-model.ts)

Uso:

- `source ~/.profile && pnpm tsx scripts/bench-model.ts --runs 10`
- Variables de entorno opcionales: `MINIMAX_API_KEY`, `MINIMAX_BASE_URL`, `MINIMAX_MODEL`, `ANTHROPIC_API_KEY`
- Prompt predeterminado: “Responda con una sola palabra: ok. Sin puntuación ni texto adicional.”

Última ejecución (2025-12-31, 20 ejecuciones):

- minimax mediana 1279 ms (mín 1114, máx 2431)
- opus mediana 2454 ms (mín 1224, máx 3170)

## Onboarding E2E (Docker)

Docker es opcional; esto solo es necesario para pruebas de humo de onboarding en contenedores.

Flujo completo de arranque en frío en un contenedor Linux limpio:

```bash
scripts/e2e/onboard-docker.sh
```

Este script controla el asistente interactivo mediante una pseudo-TTY, verifica los archivos de configuración/espacio de trabajo/sesión, luego inicia el Gateway y ejecuta `openclaw health`.

## Prueba de humo de importación por QR (Docker)

Garantiza que `qrcode-terminal` cargue en Node 22+ dentro de Docker:

```bash
pnpm test:docker:qr
```
