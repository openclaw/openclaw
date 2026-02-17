---
summary: "Ejecución de background exec y gestión de procesos"
read_when:
  - Agregando o modificando comportamiento de background exec
  - Debugging de tareas exec de larga duración
title: "Background Exec y Herramienta de Proceso"
---

# Background Exec + Herramienta de Proceso

OpenClaw ejecuta comandos shell a través de la herramienta `exec` y mantiene tareas de larga duración en memoria. La herramienta `process` gestiona esas sesiones en background.

## Herramienta exec

Parámetros clave:

- `command` (requerido)
- `yieldMs` (predeterminado 10000): auto-background después de este retraso
- `background` (bool): background inmediatamente
- `timeout` (segundos, predeterminado 1800): mata el proceso después de este timeout
- `elevated` (bool): ejecuta en host si el modo elevado está habilitado/permitido
- ¿Necesitas un TTY real? Establece `pty: true`.
- `workdir`, `env`

Comportamiento:

- Las ejecuciones en foreground devuelven la salida directamente.
- Cuando se pone en background (explícito o timeout), la herramienta devuelve `status: "running"` + `sessionId` y una cola corta.
- La salida se mantiene en memoria hasta que la sesión es encuestada o limpiada.
- Si la herramienta `process` no está permitida, `exec` se ejecuta sincrónicamente e ignora `yieldMs`/`background`.

## Puente de procesos hijo

Al generar procesos hijo de larga duración fuera de las herramientas exec/process (por ejemplo, respawns de CLI o helpers del gateway), adjunta el helper de puente de proceso hijo para que las señales de terminación se reenvíen y los listeners se desacoplen en salida/error. Esto evita procesos huérfanos en systemd y mantiene el comportamiento de shutdown consistente entre plataformas.

Overrides de entorno:

- `PI_BASH_YIELD_MS`: yield predeterminado (ms)
- `PI_BASH_MAX_OUTPUT_CHARS`: límite de salida en memoria (chars)
- `OPENCLAW_BASH_PENDING_MAX_OUTPUT_CHARS`: límite de stdout/stderr pendiente por stream (chars)
- `PI_BASH_JOB_TTL_MS`: TTL para sesiones finalizadas (ms, limitado a 1m–3h)

Config (preferido):

- `tools.exec.backgroundMs` (predeterminado 10000)
- `tools.exec.timeoutSec` (predeterminado 1800)
- `tools.exec.cleanupMs` (predeterminado 1800000)
- `tools.exec.notifyOnExit` (predeterminado true): encola un evento del sistema + solicita heartbeat cuando un exec en background sale.
- `tools.exec.notifyOnExitEmptySuccess` (predeterminado false): cuando es true, también encola eventos de completado para ejecuciones en background exitosas que no produjeron salida.

## Herramienta process

Acciones:

- `list`: sesiones en ejecución + finalizadas
- `poll`: drena nueva salida para una sesión (también reporta estado de salida)
- `log`: lee la salida agregada (soporta `offset` + `limit`)
- `write`: envía stdin (`data`, `eof` opcional)
- `kill`: termina una sesión en background
- `clear`: elimina una sesión finalizada de la memoria
- `remove`: mata si está en ejecución, de lo contrario limpia si está finalizada

Notas:

- Solo las sesiones en background se listan/persisten en memoria.
- Las sesiones se pierden en reinicio de proceso (sin persistencia en disco).
- Los logs de sesión solo se guardan en el historial de chat si ejecutas `process poll/log` y el resultado de la herramienta se registra.
- `process` está con alcance por agente; solo ve sesiones iniciadas por ese agente.
- `process list` incluye un `name` derivado (verbo del comando + objetivo) para escaneos rápidos.
- `process log` usa `offset`/`limit` basados en líneas.
- Cuando tanto `offset` como `limit` se omiten, devuelve las últimas 200 líneas e incluye una sugerencia de paginación.
- Cuando se proporciona `offset` y se omite `limit`, devuelve desde `offset` hasta el final (sin límite de 200).

## Ejemplos

Ejecuta una tarea larga y encuesta después:

```json
{ "tool": "exec", "command": "sleep 5 && echo done", "yieldMs": 1000 }
```

```json
{ "tool": "process", "action": "poll", "sessionId": "<id>" }
```

Inicia inmediatamente en background:

```json
{ "tool": "exec", "command": "npm run build", "background": true }
```

Envía stdin:

```json
{ "tool": "process", "action": "write", "sessionId": "<id>", "data": "y\n" }
```
