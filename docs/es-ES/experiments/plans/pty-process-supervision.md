---
summary: "Plan de producción para supervisión confiable de procesos interactivos (PTY + no-PTY) con propiedad explícita, ciclo de vida unificado y limpieza determinista"
owner: "openclaw"
status: "in-progress"
last_updated: "2026-02-15"
title: "Plan de Supervisión de PTY y Procesos"
---

# Plan de Supervisión de PTY y Procesos

## 1. Problema y objetivo

Necesitamos un ciclo de vida confiable para la ejecución de comandos de larga duración en:

- ejecuciones en primer plano de `exec`
- ejecuciones en segundo plano de `exec`
- acciones de seguimiento de `process` (`poll`, `log`, `send-keys`, `paste`, `submit`, `kill`, `remove`)
- subprocesos del runner del agente CLI

El objetivo no es solo soportar PTY. El objetivo es propiedad predecible, cancelación, tiempo de espera y limpieza sin heurísticas de coincidencia de procesos inseguras.

## 2. Alcance y límites

- Mantener la implementación interna en `src/process/supervisor`.
- No crear un nuevo paquete para esto.
- Mantener la compatibilidad del comportamiento actual donde sea práctico.
- No ampliar el alcance a la reproducción de terminal o la persistencia de sesión estilo tmux.

## 3. Implementado en esta rama

### Línea base del supervisor ya presente

- El módulo supervisor está en su lugar bajo `src/process/supervisor/*`.
- El runtime de Exec y el runner de CLI ya están enrutados a través del spawn y wait del supervisor.
- La finalización del registro es idempotente.

### Este paso completado

1. Contrato explícito de comando PTY

- `SpawnInput` ahora es una unión discriminada en `src/process/supervisor/types.ts`.
- Las ejecuciones PTY requieren `ptyCommand` en lugar de reutilizar `argv` genérico.
- El supervisor ya no reconstruye strings de comando PTY desde uniones de argv en `src/process/supervisor/supervisor.ts`.
- El runtime de Exec ahora pasa `ptyCommand` directamente en `src/agents/bash-tools.exec-runtime.ts`.

2. Desacoplamiento de tipos de capa de proceso

- Los tipos del supervisor ya no importan `SessionStdin` de agentes.
- El contrato de stdin local del proceso vive en `src/process/supervisor/types.ts` (`ManagedRunStdin`).
- Los adaptadores ahora dependen solo de tipos de nivel de proceso:
  - `src/process/supervisor/adapters/child.ts`
  - `src/process/supervisor/adapters/pty.ts`

3. Mejora de propiedad del ciclo de vida de herramienta de proceso

- `src/agents/bash-tools.process.ts` ahora solicita cancelación a través del supervisor primero.
- `process kill/remove` ahora usa terminación de fallback de árbol de procesos cuando la búsqueda del supervisor falla.
- `remove` mantiene comportamiento de eliminación determinista al eliminar entradas de sesión en ejecución inmediatamente después de que se solicita la terminación.

4. Valores predeterminados únicos de watchdog

- Agregados valores predeterminados compartidos en `src/agents/cli-watchdog-defaults.ts`.
- `src/agents/cli-backends.ts` consume los valores predeterminados compartidos.
- `src/agents/cli-runner/reliability.ts` consume los mismos valores predeterminados compartidos.

5. Limpieza de ayudante muerto

- Eliminada ruta de ayudante `killSession` no utilizado de `src/agents/bash-tools.shared.ts`.

6. Pruebas de ruta directa del supervisor agregadas

- Agregado `src/agents/bash-tools.process.supervisor.test.ts` para cubrir kill y remove enrutando a través de la cancelación del supervisor.

7. Correcciones de brechas de confiabilidad completadas

- `src/agents/bash-tools.process.ts` ahora vuelve a la terminación real de procesos a nivel de SO cuando la búsqueda del supervisor falla.
- `src/process/supervisor/adapters/child.ts` ahora usa semántica de terminación de árbol de procesos para rutas de kill predeterminadas de cancel/timeout.
- Agregada utilidad compartida de árbol de procesos en `src/process/kill-tree.ts`.

8. Cobertura de casos extremos de contrato PTY agregada

- Agregado `src/process/supervisor/supervisor.pty-command.test.ts` para reenvío literal de comando PTY y rechazo de comando vacío.
- Agregado `src/process/supervisor/adapters/child.test.ts` para comportamiento de kill de árbol de procesos en cancelación del adaptador child.

## 4. Brechas restantes y decisiones

### Estado de confiabilidad

Las dos brechas de confiabilidad requeridas para este paso ahora están cerradas:

- `process kill/remove` ahora tiene un fallback real de terminación de SO cuando la búsqueda del supervisor falla.
- cancel/timeout de child ahora usa semántica de kill de árbol de procesos para la ruta de kill predeterminada.
- Se agregaron pruebas de regresión para ambos comportamientos.

### Durabilidad y reconciliación de inicio

El comportamiento de reinicio ahora está explícitamente definido como ciclo de vida solo en memoria.

- `reconcileOrphans()` permanece como no-op en `src/process/supervisor/supervisor.ts` por diseño.
- Las ejecuciones activas no se recuperan después del reinicio del proceso.
- Este límite es intencional para este paso de implementación para evitar riesgos de persistencia parcial.

### Seguimientos de mantenibilidad

1. `runExecProcess` en `src/agents/bash-tools.exec-runtime.ts` todavía maneja múltiples responsabilidades y puede dividirse en ayudantes enfocados en un seguimiento.

## 5. Plan de implementación

El paso de implementación para elementos de confiabilidad y contrato requeridos está completo.

Completado:

- fallback de terminación real de `process kill/remove`
- cancelación de árbol de procesos para ruta de kill predeterminada del adaptador child
- pruebas de regresión para kill de fallback y ruta de kill del adaptador child
- pruebas de casos extremos de comando PTY bajo `ptyCommand` explícito
- límite explícito de reinicio en memoria con `reconcileOrphans()` no-op por diseño

Seguimiento opcional:

- dividir `runExecProcess` en ayudantes enfocados sin desviación de comportamiento

## 6. Mapa de archivos

### Supervisor de procesos

- `src/process/supervisor/types.ts` actualizado con entrada de spawn discriminada y contrato de stdin local de proceso.
- `src/process/supervisor/supervisor.ts` actualizado para usar `ptyCommand` explícito.
- `src/process/supervisor/adapters/child.ts` y `src/process/supervisor/adapters/pty.ts` desacoplados de tipos de agente.
- `src/process/supervisor/registry.ts` finalizar idempotente sin cambios y retenido.

### Integración de exec y proceso

- `src/agents/bash-tools.exec-runtime.ts` actualizado para pasar comando PTY explícitamente y mantener ruta de fallback.
- `src/agents/bash-tools.process.ts` actualizado para cancelar a través del supervisor con terminación de fallback real de árbol de procesos.
- `src/agents/bash-tools.shared.ts` eliminó ruta de ayudante de kill directo.

### Confiabilidad de CLI

- `src/agents/cli-watchdog-defaults.ts` agregado como línea base compartida.
- `src/agents/cli-backends.ts` y `src/agents/cli-runner/reliability.ts` ahora consumen los mismos valores predeterminados.

## 7. Ejecución de validación en este paso

Pruebas unitarias:

- `pnpm vitest src/process/supervisor/registry.test.ts`
- `pnpm vitest src/process/supervisor/supervisor.test.ts`
- `pnpm vitest src/process/supervisor/supervisor.pty-command.test.ts`
- `pnpm vitest src/process/supervisor/adapters/child.test.ts`
- `pnpm vitest src/agents/cli-backends.test.ts`
- `pnpm vitest src/agents/bash-tools.exec.pty-cleanup.test.ts`
- `pnpm vitest src/agents/bash-tools.process.poll-timeout.test.ts`
- `pnpm vitest src/agents/bash-tools.process.supervisor.test.ts`
- `pnpm vitest src/process/exec.test.ts`

Objetivos E2E:

- `pnpm test:e2e src/agents/cli-runner.e2e.test.ts`
- `pnpm test:e2e src/agents/bash-tools.exec.pty-fallback.e2e.test.ts src/agents/bash-tools.exec.background-abort.e2e.test.ts src/agents/bash-tools.process.send-keys.e2e.test.ts`

Nota de verificación de tipos:

- `pnpm tsgo` actualmente falla en este repositorio debido a un problema de dependencia de tipado de UI preexistente (resolución de `@vitest/browser-playwright`), no relacionado con este trabajo de supervisión de procesos.

## 8. Garantías operacionales preservadas

- El comportamiento de endurecimiento de env de Exec no cambia.
- El flujo de aprobación y lista de permitidos no cambia.
- La sanitización de salida y los límites de salida no cambian.
- El adaptador PTY todavía garantiza liquidación de wait en kill forzado y disposición de listener.

## 9. Definición de hecho

1. El supervisor es el propietario del ciclo de vida para ejecuciones administradas.
2. El spawn PTY usa contrato de comando explícito sin reconstrucción de argv.
3. La capa de proceso no tiene dependencia de tipo en la capa de agente para contratos de stdin del supervisor.
4. Los valores predeterminados de watchdog son de fuente única.
5. Las pruebas unitarias y e2e específicas permanecen verdes.
6. El límite de durabilidad de reinicio está explícitamente documentado o completamente implementado.

## 10. Resumen

La rama ahora tiene una forma de supervisión coherente y más segura:

- contrato PTY explícito
- capas de proceso más limpias
- ruta de cancelación dirigida por supervisor para operaciones de proceso
- terminación de fallback real cuando la búsqueda del supervisor falla
- cancelación de árbol de procesos para rutas de kill predeterminadas de ejecución child
- valores predeterminados de watchdog unificados
- límite explícito de reinicio en memoria (sin reconciliación de huérfanos a través de reinicio en este paso)
