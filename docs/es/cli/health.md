---
summary: "Referencia de la CLI para `openclaw health` (endpoint de salud del Gateway vía RPC)"
read_when:
  - Quiere verificar rápidamente la salud del Gateway en ejecución
title: "salud"
x-i18n:
  source_path: cli/health.md
  source_hash: 82a78a5a97123f7a
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:32:54Z
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
