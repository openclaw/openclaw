---
summary: "Endurecimento da allowlist do Telegram: prefixo + normalização de espaços em branco"
read_when:
  - Ao revisar mudanças históricas na allowlist do Telegram
title: "Endurecimento da Allowlist do Telegram"
x-i18n:
  source_path: experiments/plans/group-policy-hardening.md
  source_hash: 70569968857d4084
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:30:44Z
---

# Endurecimento da Allowlist do Telegram

**Data**: 2026-01-05  
**Status**: Concluído  
**PR**: #216

## Resumo

As allowlists do Telegram agora aceitam os prefixos `telegram:` e `tg:` sem diferenciar maiúsculas de minúsculas e toleram
espaços em branco acidentais. Isso alinha as verificações de allowlist de entrada com a normalização de envio de saída.

## O que mudou

- Os prefixos `telegram:` e `tg:` são tratados da mesma forma (sem diferenciar maiúsculas de minúsculas).
- As entradas da allowlist são aparadas; entradas vazias são ignoradas.

## Exemplos

Todos estes são aceitos para o mesmo ID:

- `telegram:123456`
- `TG:123456`
- `tg:123456`

## Por que isso importa

Copiar/colar a partir de logs ou IDs de chat geralmente inclui prefixos e espaços em branco. A normalização evita
falsos negativos ao decidir se deve responder em DMs ou grupos.

## Documentos relacionados

- [Group Chats](/channels/groups)
- [Telegram Provider](/channels/telegram)
