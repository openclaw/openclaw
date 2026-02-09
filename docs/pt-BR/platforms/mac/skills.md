---
summary: "UI de configurações de Skills no macOS e status baseado no gateway"
read_when:
  - Atualizar a UI de configurações de Skills no macOS
  - Alterar o controle de acesso ou o comportamento de instalação das Skills
title: "Skills"
---

# Skills (macOS)

O app do macOS apresenta as Skills do OpenClaw via o gateway; ele não analisa Skills localmente.

## Fonte de dados

- `skills.status` (gateway) retorna todas as Skills, além de elegibilidade e requisitos ausentes
  (incluindo bloqueios de lista de permissões para Skills empacotadas).
- Os requisitos são derivados de `metadata.openclaw.requires` em cada `SKILL.md`.

## Ações de instalação

- `metadata.openclaw.install` define opções de instalação (brew/node/go/uv).
- O app chama `skills.install` para executar instaladores no host do Gateway.
- O gateway expõe apenas um instalador preferido quando vários são fornecidos
  (brew quando disponível; caso contrário, o gerenciador de node de `skills.install`, padrão npm).

## Chaves de ambiente/API

- O app armazena as chaves em `~/.openclaw/openclaw.json` sob `skills.entries.<skillKey>`.
- `skills.update` aplica patches em `enabled`, `apiKey` e `env`.

## Modo remoto

- Instalação e atualizações de configuração acontecem no host do Gateway (não no Mac local).
