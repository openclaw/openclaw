---
title: "Flujo de Trabajo de Desarrollo de Pi"
---

# Flujo de Trabajo de Desarrollo de Pi

Esta guía resume un flujo de trabajo sensato para trabajar en la integración de Pi en OpenClaw.

## Verificación de Tipos y Linting

- Verificación de tipos y construcción: `pnpm build`
- Lint: `pnpm lint`
- Verificación de formato: `pnpm format`
- Comprobación completa antes de subir: `pnpm lint && pnpm build && pnpm test`

## Ejecución de Pruebas de Pi

Usa el script dedicado para el conjunto de pruebas de integración de Pi:

```bash
scripts/pi/run-tests.sh
```

Para incluir la prueba en vivo que ejercita el comportamiento real del proveedor:

```bash
scripts/pi/run-tests.sh --live
```

El script ejecuta todas las pruebas unitarias relacionadas con Pi mediante estos patrones:

- `src/agents/pi-*.test.ts`
- `src/agents/pi-embedded-*.test.ts`
- `src/agents/pi-tools*.test.ts`
- `src/agents/pi-settings.test.ts`
- `src/agents/pi-tool-definition-adapter.test.ts`
- `src/agents/pi-extensions/*.test.ts`

## Pruebas Manuales

Flujo recomendado:

- Ejecutar el Gateway en modo desarrollo:
  - `pnpm gateway:dev`
- Activar el agente directamente:
  - `pnpm openclaw agent --message "Hola" --thinking low`
- Usar la TUI para depuración interactiva:
  - `pnpm tui`

Para el comportamiento de llamadas de herramientas, solicita una acción `read` o `exec` para poder ver el streaming de herramientas y el manejo de carga útil.

## Restablecimiento Completo

El estado reside en el directorio de estado de OpenClaw. Por defecto es `~/.openclaw`. Si `OPENCLAW_STATE_DIR` está configurado, usa ese directorio en su lugar.

Para restablecer todo:

- `openclaw.json` para la configuración
- `credentials/` para perfiles de autenticación y tokens
- `agents/<agentId>/sessions/` para el historial de sesiones del agente
- `agents/<agentId>/sessions.json` para el índice de sesiones
- `sessions/` si existen rutas heredadas
- `workspace/` si deseas un espacio de trabajo en blanco

Si solo deseas restablecer las sesiones, elimina `agents/<agentId>/sessions/` y `agents/<agentId>/sessions.json` para ese agente. Mantén `credentials/` si no deseas volver a autenticarte.

## Referencias

- [https://docs.openclaw.ai/es-ES/testing](https://docs.openclaw.ai/es-ES/testing)
- [https://docs.openclaw.ai/es-ES/start/getting-started](https://docs.openclaw.ai/es-ES/start/getting-started)
