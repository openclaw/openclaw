---
summary: "Referencia de la CLI para `openclaw logs` (seguir los registros del Gateway vía RPC)"
read_when:
  - Necesita seguir los registros del Gateway de forma remota (sin SSH)
  - Quiere líneas de registro en JSON para herramientas
title: "registros"
---

# `openclaw logs`

Siga en tiempo real los registros de archivos del Gateway mediante RPC (funciona en modo remoto).

Relacionado:

- Descripción general de registros: [Logging](/logging)

## Ejemplos

```bash
openclaw logs
openclaw logs --follow
openclaw logs --json
openclaw logs --limit 500
```
