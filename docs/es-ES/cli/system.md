---
summary: "Referencia CLI para `openclaw system` (eventos del sistema, heartbeat, presencia)"
read_when:
  - Quieres encolar un evento del sistema sin crear una tarea programada
  - Necesitas habilitar o deshabilitar heartbeats
  - Quieres inspeccionar entradas de presencia del sistema
title: "system"
---

# `openclaw system`

Ayudantes a nivel de sistema para el Gateway: encolar eventos del sistema, controlar heartbeats,
y ver presencia.

## Comandos comunes

```bash
openclaw system event --text "Verificar seguimientos urgentes" --mode now
openclaw system heartbeat enable
openclaw system heartbeat last
openclaw system presence
```

## `system event`

Encolar un evento del sistema en la sesión **principal**. El siguiente heartbeat lo inyectará
como una línea `System:` en el prompt. Usa `--mode now` para activar el heartbeat
inmediatamente; `next-heartbeat` espera el siguiente tick programado.

Flags:

- `--text <text>`: texto del evento del sistema requerido.
- `--mode <mode>`: `now` o `next-heartbeat` (predeterminado).
- `--json`: salida legible por máquina.

## `system heartbeat last|enable|disable`

Controles de heartbeat:

- `last`: mostrar el último evento de heartbeat.
- `enable`: reactivar heartbeats (usa esto si fueron deshabilitados).
- `disable`: pausar heartbeats.

Flags:

- `--json`: salida legible por máquina.

## `system presence`

Listar las entradas de presencia del sistema actuales que el Gateway conoce (nodos,
instancias y líneas de estado similares).

Flags:

- `--json`: salida legible por máquina.

## Notas

- Requiere un Gateway en ejecución accesible por tu configuración actual (local o remoto).
- Los eventos del sistema son efímeros y no se persisten entre reinicios.
