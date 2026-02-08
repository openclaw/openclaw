---
summary: "Referência da CLI para `openclaw logs` (acompanhar logs do Gateway via RPC)"
read_when:
  - Você precisa acompanhar logs do Gateway remotamente (sem SSH)
  - Você quer linhas de log em JSON para ferramentas
title: "logs"
x-i18n:
  source_path: cli/logs.md
  source_hash: 911a57f0f3b78412
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:30:23Z
---

# `openclaw logs`

Acompanhe logs de arquivos do Gateway via RPC (funciona em modo remoto).

Relacionado:

- Visão geral de logging: [Logging](/logging)

## Exemplos

```bash
openclaw logs
openclaw logs --follow
openclaw logs --json
openclaw logs --limit 500
```
