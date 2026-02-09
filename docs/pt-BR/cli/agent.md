---
summary: "Referência da CLI para `openclaw agent` (enviar um turno de agente via o Gateway)"
read_when:
  - Você quer executar um turno de agente a partir de scripts (opcionalmente entregar a resposta)
title: "agent"
---

# `openclaw agent`

Execute um turno de agente via o Gateway (use `--local` para incorporado).
Use `--agent <id>` para direcionar diretamente um agente configurado.

Relacionado:

- Ferramenta de envio de agente: [Envio de agente](/tools/agent-send)

## Exemplos

```bash
openclaw agent --to +15555550123 --message "status update" --deliver
openclaw agent --agent ops --message "Summarize logs"
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
```
