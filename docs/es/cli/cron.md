---
summary: "Referencia de la CLI para `openclaw cron` (programar y ejecutar trabajos en segundo plano)"
read_when:
  - Quiere trabajos programados y activaciones
  - Está depurando la ejecución de cron y los registros
title: "cron"
---

# `openclaw cron`

Gestione trabajos cron para el programador del Gateway.

Relacionado:

- Trabajos cron: [Trabajos cron](/automation/cron-jobs)

Consejo: ejecute `openclaw cron --help` para ver la superficie completa de comandos.

Nota: los trabajos `cron add` aislados se envían por defecto mediante `--announce`. Use `--no-deliver` para mantener
la salida interna. `--deliver` permanece como un alias obsoleto de `--announce`.

Nota: los trabajos de una sola ejecución (`--at`) se eliminan tras completarse con éxito de forma predeterminada. Use `--keep-after-run` para conservarlos.

Nota: los trabajos recurrentes ahora usan un retroceso exponencial de reintentos tras errores consecutivos (30 s → 1 m → 5 m → 15 m → 60 m), y luego vuelven al programa normal después de la siguiente ejecución exitosa.

## Ediciones comunes

Actualice la configuración de entrega sin cambiar el mensaje:

```bash
openclaw cron edit <job-id> --announce --channel telegram --to "123456789"
```

Desactive la entrega para un trabajo aislado:

```bash
openclaw cron edit <job-id> --no-deliver
```

Anuncie en un canal específico:

```bash
openclaw cron edit <job-id> --announce --channel slack --to "channel:C1234567890"
```
