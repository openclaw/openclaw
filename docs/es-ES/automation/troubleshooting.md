---
summary: "Solucionar problemas de programación y entrega de cron y heartbeat"
read_when:
  - Cron no se ejecutó
  - Cron se ejecutó pero no se entregó ningún mensaje
  - Heartbeat parece silencioso o omitido
title: "Solución de Problemas de Automatización"
---

# Solución de problemas de automatización

Usa esta página para problemas de programador y entrega (`cron` + `heartbeat`).

## Escalera de comandos

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Luego ejecuta verificaciones de automatización:

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

La salida correcta se ve como:

- `cron status` reporta habilitado y un `nextWakeAtMs` futuro.
- El trabajo está habilitado y tiene una programación/zona horaria válida.
- `cron runs` muestra `ok` o razón de omisión explícita.

Firmas comunes:

- `cron: scheduler disabled; jobs will not run automatically` → cron deshabilitado en config/env.
- `cron: timer tick failed` → tick del programador se bloqueó; inspecciona el contexto de pila/registro circundante.
- `reason: not-due` en salida de ejecución → ejecución manual llamada sin `--force` y trabajo aún no es debido.

## Cron se activó pero no hay entrega

```bash
openclaw cron runs --id <jobId> --limit 20
openclaw cron list
openclaw channels status --probe
openclaw logs --follow
```

La salida correcta se ve como:

- El estado de ejecución es `ok`.
- El modo/objetivo de entrega están establecidos para trabajos aislados.
- La sonda de canal reporta canal objetivo conectado.

Firmas comunes:

- La ejecución tuvo éxito pero el modo de entrega es `none` → no se espera mensaje externo.
- Objetivo de entrega faltante/inválido (`channel`/`to`) → la ejecución puede tener éxito internamente pero omitir salida.
- Errores de autenticación de canal (`unauthorized`, `missing_scope`, `Forbidden`) → entrega bloqueada por credenciales/permisos de canal.

## Heartbeat suprimido u omitido

```bash
openclaw system heartbeat last
openclaw logs --follow
openclaw config get agents.defaults.heartbeat
openclaw channels status --probe
```

La salida correcta se ve como:

- Heartbeat habilitado con intervalo no cero.
- El resultado del último heartbeat es `ran` (o la razón de omisión se entiende).

Firmas comunes:

- `heartbeat skipped` con `reason=quiet-hours` → fuera de `activeHours`.
- `requests-in-flight` → carril principal ocupado; heartbeat diferido.
- `empty-heartbeat-file` → `HEARTBEAT.md` existe pero no tiene contenido accionable.
- `alerts-disabled` → configuraciones de visibilidad suprimen mensajes de heartbeat salientes.

## Problemas de zona horaria y activeHours

```bash
openclaw config get agents.defaults.heartbeat.activeHours
openclaw config get agents.defaults.heartbeat.activeHours.timezone
openclaw config get agents.defaults.userTimezone || echo "agents.defaults.userTimezone not set"
openclaw cron list
openclaw logs --follow
```

Reglas rápidas:

- `Config path not found: agents.defaults.userTimezone` significa que la clave no está establecida; heartbeat vuelve a la zona horaria del host (o `activeHours.timezone` si está establecida).
- Cron sin `--tz` usa la zona horaria del host gateway.
- `activeHours` de heartbeat usa resolución de zona horaria configurada (`user`, `local`, o tz IANA explícita).
- Las marcas de tiempo ISO sin zona horaria se tratan como UTC para programaciones `at` de cron.

Firmas comunes:

- Los trabajos se ejecutan en el momento de reloj de pared incorrecto después de cambios de zona horaria del host.
- Heartbeat siempre omitido durante tu día porque `activeHours.timezone` está mal.

Relacionado:

- [/automation/cron-jobs](/es-ES/automation/cron-jobs)
- [/gateway/heartbeat](/es-ES/gateway/heartbeat)
- [/automation/cron-vs-heartbeat](/es-ES/automation/cron-vs-heartbeat)
- [/concepts/timezone](/es-ES/concepts/timezone)
