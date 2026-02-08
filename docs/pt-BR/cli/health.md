---
summary: "Referência da CLI para `openclaw health` (endpoint de saúde do Gateway via RPC)"
read_when:
  - Você quer verificar rapidamente a saúde do Gateway em execução
title: "saúde"
x-i18n:
  source_path: cli/health.md
  source_hash: 82a78a5a97123f7a
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:30:18Z
---

# `openclaw health`

Busca a saúde do Gateway em execução.

```bash
openclaw health
openclaw health --json
openclaw health --verbose
```

Notas:

- `--verbose` executa sondagens em tempo real e imprime tempos por conta quando várias contas estão configuradas.
- A saída inclui armazenamentos de sessão por agente quando vários agentes estão configurados.
