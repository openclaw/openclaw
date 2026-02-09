---
summary: "Referencia de la CLI para `openclaw health` (endpoint de salud del Gateway vía RPC)"
read_when:
  - Quiere verificar rápidamente la salud del Gateway en ejecución
title: "salud"
---

# `openclaw health`

Obtener el estado de salud del Gateway en ejecución.

```bash
openclaw health
openclaw health --json
openclaw health --verbose
```

Notas:

- `--verbose` ejecuta sondeos en vivo e imprime tiempos por cuenta cuando hay varias cuentas configuradas.
- La salida incluye almacenes de sesión por agente cuando hay varios agentes configurados.
