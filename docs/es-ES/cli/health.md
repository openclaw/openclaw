---
summary: "Referencia CLI para `openclaw health` (endpoint de salud del gateway vía RPC)"
read_when:
  - Quieres verificar rápidamente la salud del Gateway en ejecución
title: "health"
---

# `openclaw health`

Obtener el estado de salud del Gateway en ejecución.

```bash
openclaw health
openclaw health --json
openclaw health --verbose
```

Notas:

- `--verbose` ejecuta pruebas en vivo e imprime tiempos por cuenta cuando hay múltiples cuentas configuradas.
- La salida incluye almacenes de sesión por agente cuando hay múltiples agentes configurados.
