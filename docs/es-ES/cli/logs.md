---
summary: "Referencia CLI para `openclaw logs` (seguir registros del gateway vía RPC)"
read_when:
  - Necesitas seguir los registros del Gateway remotamente (sin SSH)
  - Quieres líneas de registro JSON para herramientas
title: "logs"
---

# `openclaw logs`

Seguir registros de archivos del Gateway a través de RPC (funciona en modo remoto).

Relacionado:

- Resumen de registro: [Registro de eventos](/es-ES/logging)

## Ejemplos

```bash
openclaw logs
openclaw logs --follow
openclaw logs --json
openclaw logs --limit 500
openclaw logs --local-time
openclaw logs --follow --local-time
```

Usa `--local-time` para renderizar marcas de tiempo en tu zona horaria local.
