---
summary: "Referência da CLI para `openclaw skills` (list/info/check) e elegibilidade de Skills"
read_when:
  - Você quer ver quais Skills estão disponíveis e prontas para executar
  - Você quer depurar binários/variáveis de ambiente/configuração ausentes para Skills
title: "skills"
x-i18n:
  source_path: cli/skills.md
  source_hash: 7878442c88a27ec8
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:30:22Z
---

# `openclaw skills`

Inspecione Skills (empacotadas + workspace + substituições gerenciadas) e veja o que está elegível vs. requisitos ausentes.

Relacionados:

- Sistema de Skills: [Skills](/tools/skills)
- Configuração de Skills: [Skills config](/tools/skills-config)
- Instalações do ClawHub: [ClawHub](/tools/clawhub)

## Comandos

```bash
openclaw skills list
openclaw skills list --eligible
openclaw skills info <name>
openclaw skills check
```
