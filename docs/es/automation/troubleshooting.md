---
summary: "Solucione problemas de programación y entrega de cron y heartbeat"
read_when:
  - Cron no se ejecutó
  - Cron se ejecutó pero no se entregó ningún mensaje
  - Heartbeat parece silencioso u omitido
title: "Solución de problemas de automatización"
---

# Solución de problemas de automatización

Use esta página para problemas del programador y de entrega (`cron` + `heartbeat`).

## Escalera de comandos

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Luego ejecute las comprobaciones de automatización:

```bash
openclaw cron status
openclaw cron list
openclaw system heartbeat last
```

## Cron no se activa

```bash
openclaw cron status
openclaw cron list
openclaw cron runs --id <jobId> --limit 20
openclaw logs --follow
```

Una salida correcta se ve así:

- `cron status` informa habilitado y un `nextWakeAtMs` futuro.
- El trabajo está habilitado y tiene una programación/zona horaria válidas.
- `cron runs` muestra `ok` o una razón explícita de omisión.

Firmas comunes:

- `cron: scheduler disabled; jobs will not run automatically` → cron deshabilitado en la configuración/variables de entorno.
- `cron: timer tick failed` → el tick del programador falló; inspeccione el contexto de pila/registros circundante.
- `reason: not-due` en la salida de ejecución → la ejecución manual se llamó sin `--force` y el trabajo aún no vence.

## Cron se activó pero no hubo entrega

```bash
openclaw cron runs --id <jobId> --limit 20
openclaw cron list
openclaw channels status --probe
openclaw logs --follow
```

Una salida correcta se ve así:

- El estado de la ejecución es `ok`.
- El modo/objetivo de entrega están configurados para trabajos aislados.
- La sonda del canal informa que el canal objetivo está conectado.

Firmas comunes:

- La ejecución tuvo éxito pero el modo de entrega es `none` → no se espera ningún mensaje externo.
- Objetivo de entrega faltante/inválido (`channel`/`to`) → la ejecución puede tener éxito internamente pero omitir el envío.
- Errores de autenticación del canal (`unauthorized`, `missing_scope`, `Forbidden`) → la entrega está bloqueada por credenciales/permisos del canal.

## Heartbeat suprimido u omitido

```bash
openclaw system heartbeat last
openclaw logs --follow
openclaw config get agents.defaults.heartbeat
openclaw channels status --probe
```

Una salida correcta se ve así:

- Heartbeat habilitado con intervalo distinto de cero.
- El último resultado de heartbeat es `ran` (o se comprende la razón de omisión).

Firmas comunes:

- `heartbeat skipped` con `reason=quiet-hours` → fuera de `activeHours`.
- `requests-in-flight` → el carril principal está ocupado; heartbeat diferido.
- `empty-heartbeat-file` → existe `HEARTBEAT.md` pero no tiene contenido accionable.
- `alerts-disabled` → la configuración de visibilidad suprime los mensajes salientes de heartbeat.

## Trampas de zona horaria y activeHours

```bash
openclaw config get agents.defaults.heartbeat.activeHours
openclaw config get agents.defaults.heartbeat.activeHours.timezone
openclaw config get agents.defaults.userTimezone || echo "agents.defaults.userTimezone not set"
openclaw cron list
openclaw logs --follow
```

Reglas rápidas:

- `Config path not found: agents.defaults.userTimezone` significa que la clave no está configurada; heartbeat recurre a la zona horaria del host (o `activeHours.timezone` si está configurada).
- Cron sin `--tz` usa la zona horaria del host del Gateway.
- Heartbeat `activeHours` usa la resolución de zona horaria configurada (`user`, `local` o una tz IANA explícita).
- Las marcas de tiempo ISO sin zona horaria se tratan como UTC para las programaciones de cron `at`.

Firmas comunes:

- Los trabajos se ejecutan a una hora de reloj incorrecta después de cambios en la zona horaria del host.
- Heartbeat siempre se omite durante su horario diurno porque `activeHours.timezone` es incorrecto.

Relacionado:

- [/automation/cron-jobs](/automation/cron-jobs)
- [/gateway/heartbeat](/gateway/heartbeat)
- [/automation/cron-vs-heartbeat](/automation/cron-vs-heartbeat)
- [/concepts/timezone](/concepts/timezone)
