---
title: "Flujo de trabajo de desarrollo de Pi"
---

# Flujo de trabajo de desarrollo de Pi

Esta guía resume un flujo de trabajo sensato para trabajar en la integración de Pi en OpenClaw.

## Verificación de tipos y linting

- Verificar tipos y compilar: `pnpm build`
- Lint: `pnpm lint`
- Verificación de formato: `pnpm format`
- Puerta completa antes de hacer push: `pnpm lint && pnpm build && pnpm test`

## Ejecución de pruebas de Pi

Use el script dedicado para el conjunto de pruebas de integración de Pi:

```bash
scripts/pi/run-tests.sh
```

Para incluir la prueba en vivo que ejercita el comportamiento real del proveedor:

```bash
scripts/pi/run-tests.sh --live
```

El script ejecuta todas las pruebas unitarias relacionadas con Pi mediante estos globs:

- `src/agents/pi-*.test.ts`
- `src/agents/pi-embedded-*.test.ts`
- `src/agents/pi-tools*.test.ts`
- `src/agents/pi-settings.test.ts`
- `src/agents/pi-tool-definition-adapter.test.ts`
- `src/agents/pi-extensions/*.test.ts`

## Pruebas manuales

Flujo recomendado:

- Ejecutar el Gateway en modo de desarrollo:
  - `pnpm gateway:dev`
- Disparar el agente directamente:
  - `pnpm openclaw agent --message "Hello" --thinking low`
- Usar la TUI para depuración interactiva:
  - `pnpm tui`

Para el comportamiento de llamadas a herramientas, solicite una acción de `read` o `exec` para poder ver el streaming de herramientas y el manejo de payloads.

## Restablecimiento a estado limpio

El estado vive bajo el directorio de estado de OpenClaw. El valor predeterminado es `~/.openclaw`. Si `OPENCLAW_STATE_DIR` está configurado, use ese directorio en su lugar.

Para restablecer todo:

- `openclaw.json` para la configuración
- `credentials/` para perfiles de autenticación y tokens
- `agents/<agentId>/sessions/` para el historial de sesiones del agente
- `agents/<agentId>/sessions.json` para el índice de sesiones
- `sessions/` si existen rutas heredadas
- `workspace/` si desea un espacio de trabajo en blanco

Si solo desea restablecer las sesiones, elimine `agents/<agentId>/sessions/` y `agents/<agentId>/sessions.json` para ese agente. Mantenga `credentials/` si no desea volver a autenticarse.

## Referencias

- [https://docs.openclaw.ai/testing](https://docs.openclaw.ai/testing)
- [https://docs.openclaw.ai/start/getting-started](https://docs.openclaw.ai/start/getting-started)
