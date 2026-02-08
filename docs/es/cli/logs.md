---
summary: "Referencia de la CLI para `openclaw logs` (seguir los registros del Gateway vía RPC)"
read_when:
  - Necesita seguir los registros del Gateway de forma remota (sin SSH)
  - Quiere líneas de registro en JSON para herramientas
title: "registros"
x-i18n:
  source_path: cli/logs.md
  source_hash: 911a57f0f3b78412
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:32:54Z
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
