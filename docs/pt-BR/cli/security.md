---
summary: "Referência da CLI para `openclaw security` (auditar e corrigir armadilhas comuns de segurança)"
read_when:
  - Você quer executar uma auditoria rápida de segurança na configuração/estado
  - Você quer aplicar sugestões seguras de “correção” (chmod, endurecer padrões)
title: "segurança"
x-i18n:
  source_path: cli/security.md
  source_hash: 96542b4784e53933
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:30:24Z
---

# `openclaw security`

Ferramentas de segurança (auditoria + correções opcionais).

Relacionado:

- Guia de segurança: [Segurança](/gateway/security)

## Auditoria

```bash
openclaw security audit
openclaw security audit --deep
openclaw security audit --fix
```

A auditoria avisa quando vários remetentes de DM compartilham a sessão principal e recomenda **modo DM seguro**: `session.dmScope="per-channel-peer"` (ou `per-account-channel-peer` para canais com várias contas) para caixas de entrada compartilhadas.
Ela também avisa quando modelos pequenos (`<=300B`) são usados sem sandboxing e com ferramentas web/navegador habilitadas.
