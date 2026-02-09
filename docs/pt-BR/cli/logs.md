---
summary: "Referência da CLI para `openclaw logs` (acompanhar logs do Gateway via RPC)"
read_when:
  - Você precisa acompanhar logs do Gateway remotamente (sem SSH)
  - Você quer linhas de log em JSON para ferramentas
title: "logs"
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
