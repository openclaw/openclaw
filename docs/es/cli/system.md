---
summary: "Referencia de la CLI para `openclaw system` (eventos del sistema, latido, presencia)"
read_when:
  - Quiere encolar un evento del sistema sin crear un trabajo cron
  - Necesita habilitar o deshabilitar latidos
  - Quiere inspeccionar las entradas de presencia del sistema
title: "system"
---

# `openclaw system`

Ayudantes a nivel de sistema para el Gateway: encolar eventos del sistema, controlar latidos
y ver la presencia.

## Comandos comunes

```bash
openclaw system event --text "Check for urgent follow-ups" --mode now
openclaw system heartbeat enable
openclaw system heartbeat last
openclaw system presence
```

## `system event`

Encola un evento del sistema en la sesión **principal**. El siguiente latido lo inyectará
como una línea `System:` en el prompt. Use `--mode now` para activar el latido
inmediatamente; `next-heartbeat` espera al siguiente tick programado.

Flags:

- `--text <text>`: texto del evento del sistema requerido.
- `--mode <mode>`: `now` o `next-heartbeat` (predeterminado).
- `--json`: salida legible por máquina.

## `system heartbeat last|enable|disable`

Controles de latido:

- `last`: mostrar el último evento de latido.
- `enable`: volver a activar los latidos (úselo si estaban deshabilitados).
- `disable`: pausar los latidos.

Flags:

- `--json`: salida legible por máquina.

## `system presence`

Enumera las entradas actuales de presencia del sistema que el Gateway conoce (nodos,
instancias y líneas de estado similares).

Flags:

- `--json`: salida legible por máquina.

## Notas

- Requiere un Gateway en ejecución accesible mediante su configuración actual (local o remota).
- Los eventos del sistema son efímeros y no se conservan entre reinicios.
