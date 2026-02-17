---
summary: "Referencia CLI para `openclaw cron` (programar y ejecutar trabajos en segundo plano)"
read_when:
  - Quieres trabajos programados y activaciones
  - Estás depurando la ejecución y registros de cron
title: "cron"
---

# `openclaw cron`

Gestionar trabajos cron para el programador del Gateway.

Relacionado:

- Tareas programadas: [Tareas programadas](/es-ES/automation/cron-jobs)

Consejo: ejecuta `openclaw cron --help` para la superficie completa de comandos.

Nota: los trabajos `cron add` aislados por defecto usan entrega `--announce`. Usa `--no-deliver` para mantener
la salida interna. `--deliver` permanece como un alias obsoleto para `--announce`.

Nota: los trabajos de una sola vez (`--at`) se eliminan después del éxito por defecto. Usa `--keep-after-run` para mantenerlos.

Nota: los trabajos recurrentes ahora usan reintento exponencial después de errores consecutivos (30s → 1m → 5m → 15m → 60m), luego vuelven al horario normal después de la próxima ejecución exitosa.

## Ediciones comunes

Actualizar configuración de entrega sin cambiar el mensaje:

```bash
openclaw cron edit <job-id> --announce --channel telegram --to "123456789"
```

Desactivar entrega para un trabajo aislado:

```bash
openclaw cron edit <job-id> --no-deliver
```

Anunciar a un canal específico:

```bash
openclaw cron edit <job-id> --announce --channel slack --to "channel:C1234567890"
```
