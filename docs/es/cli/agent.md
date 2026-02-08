---
summary: "Referencia de la CLI para `openclaw agent` (enviar un turno de agente a través del Gateway)"
read_when:
  - Desea ejecutar un turno de agente desde scripts (opcionalmente entregar la respuesta)
title: "agent"
x-i18n:
  source_path: cli/agent.md
  source_hash: dcf12fb94e207c68
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:32:50Z
---

# `openclaw agent`

Ejecute un turno de agente a través del Gateway (use `--local` para incrustado).
Use `--agent <id>` para apuntar directamente a un agente configurado.

Relacionado:

- Herramienta de envío de Agente: [Agent send](/tools/agent-send)

## Ejemplos

```bash
openclaw agent --to +15555550123 --message "status update" --deliver
openclaw agent --agent ops --message "Summarize logs"
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
```
