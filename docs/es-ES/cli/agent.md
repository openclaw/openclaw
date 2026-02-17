---
summary: "Referencia CLI para `openclaw agent` (enviar un turno de agente a través del Gateway)"
read_when:
  - Quieres ejecutar un turno de agente desde scripts (opcionalmente entregar respuesta)
title: "agent"
---

# `openclaw agent`

Ejecutar un turno de agente a través del Gateway (usa `--local` para embebido).
Usa `--agent <id>` para apuntar a un agente configurado directamente.

Relacionado:

- Herramienta de envío de agente: [Envío de agente](/es-ES/tools/agent-send)

## Ejemplos

```bash
openclaw agent --to +15555550123 --message "actualización de estado" --deliver
openclaw agent --agent ops --message "Resumir registros"
openclaw agent --session-id 1234 --message "Resumir bandeja de entrada" --thinking medium
openclaw agent --agent ops --message "Generar informe" --deliver --reply-channel slack --reply-to "#reports"
```
