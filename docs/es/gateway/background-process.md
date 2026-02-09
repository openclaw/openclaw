---
summary: "Ejecución en segundo plano de exec y gestión de procesos"
read_when:
  - Al agregar o modificar el comportamiento de exec en segundo plano
  - Al depurar tareas exec de larga duración
title: "Exec en Segundo Plano y Herramienta de Procesos"
---

# Exec en Segundo Plano + Herramienta de Procesos

OpenClaw ejecuta comandos de shell mediante la herramienta `exec` y mantiene las tareas de larga duración en memoria. La herramienta `process` gestiona esas sesiones en segundo plano.

## herramienta exec

Parámetros clave:

- `command` (requerido)
- `yieldMs` (predeterminado 10000): pasa automáticamente a segundo plano después de este retraso
- `background` (bool): pasar inmediatamente a segundo plano
- `timeout` (segundos, predeterminado 1800): finaliza el proceso después de este tiempo de espera
- `elevated` (bool): ejecutar en el host si el modo elevado está habilitado/permitido
- ¿Necesita un TTY real? Configure `pty: true`.
- `workdir`, `env`

Comportamiento:

- Las ejecuciones en primer plano devuelven la salida directamente.
- Cuando se ejecuta en segundo plano (explícito o por tiempo de espera), la herramienta devuelve `status: "running"` + `sessionId` y una cola corta.
- La salida se mantiene en memoria hasta que la sesión se consulte o se borre.
- Si la herramienta `process` no está permitida, `exec` se ejecuta de forma sincrónica e ignora `yieldMs`/`background`.

## Paréntesis de proceso hijo

Al generar procesos secundarios de larga duración fuera de las herramientas exec/proceso (por ejemplo, reinicios de la CLI o ayudantes del Gateway), adjunte el helper de puente de procesos secundarios para que las señales de terminación se reenvíen y los listeners se desacoplen al salir/error. Esto evita procesos huérfanos en systemd y mantiene un comportamiento de apagado consistente entre plataformas.

Anulaciones de entorno:

- `PI_BASH_YIELD_MS`: rendimiento predeterminado (ms)
- `PI_BASH_MAX_OUTPUT_CHARS`: límite de salida en memoria (caracteres)
- `OPENCLAW_BASH_PENDING_MAX_OUTPUT_CHARS`: límite de stdout/stderr pendiente por flujo (caracteres)
- `PI_BASH_JOB_TTL_MS`: TTL para sesiones finalizadas (ms, acotado a 1 m–3 h)

Configuración (preferida):

- `tools.exec.backgroundMs` (predeterminado 10000)
- `tools.exec.timeoutSec` (predeterminado 1800)
- `tools.exec.cleanupMs` (predeterminado 1800000)
- `tools.exec.notifyOnExit` (predeterminado true): encola un evento del sistema + solicita heartbeat cuando un exec en segundo plano finaliza.

## herramienta process

Acciones:

- `list`: sesiones en ejecución + finalizadas
- `poll`: drenar nueva salida de una sesión (también informa el estado de salida)
- `log`: leer la salida agregada (admite `offset` + `limit`)
- `write`: enviar stdin (`data`, `eof` opcional)
- `kill`: terminar una sesión en segundo plano
- `clear`: eliminar una sesión finalizada de la memoria
- `remove`: matar si está en ejecución; de lo contrario, borrar si está finalizada

Notas:

- Solo las sesiones en segundo plano se listan/persisten en memoria.
- Las sesiones se pierden al reiniciar el proceso (sin persistencia en disco).
- Los registros de la sesión solo se guardan en el historial del chat si ejecuta `process poll/log` y el resultado de la herramienta queda registrado.
- `process` tiene alcance por agente; solo ve las sesiones iniciadas por ese agente.
- `process list` incluye un `name` derivado (verbo del comando + destino) para revisiones rápidas.
- `process log` usa `offset`/`limit` basados en líneas (omita `offset` para obtener las últimas N líneas).

## Ejemplos

Ejecute una tarea larga y consulte más tarde:

```json
{ "tool": "exec", "command": "sleep 5 && echo done", "yieldMs": 1000 }
```

```json
{ "tool": "process", "action": "poll", "sessionId": "<id>" }
```

Inicie inmediatamente en segundo plano:

```json
{ "tool": "exec", "command": "npm run build", "background": true }
```

Enviar stdin:

```json
{ "tool": "process", "action": "write", "sessionId": "<id>", "data": "y\n" }
```
