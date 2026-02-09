---
summary: "Superfícies de rastreamento de uso e requisitos de credenciais"
read_when:
  - Você está conectando superfícies de uso/cota de provedores
  - Você precisa explicar o comportamento do rastreamento de uso ou os requisitos de autenticação
title: "Rastreamento de uso"
---

# Rastreamento de uso

## O que é

- Obtém uso/cota do provedor diretamente dos endpoints de uso deles.
- Sem custos estimados; apenas as janelas reportadas pelo provedor.

## Onde aparece

- `/status` em chats: cartão de status rico em emojis com tokens da sessão + custo estimado (somente chave de API). O uso do provedor aparece para o **provedor de modelo atual** quando disponível.
- `/usage off|tokens|full` em chats: rodapé de uso por resposta (OAuth mostra apenas tokens).
- `/usage cost` em chats: resumo de custos local agregado a partir dos logs de sessão do OpenClaw.
- CLI: `openclaw status --usage` imprime um detalhamento completo por provedor.
- CLI: `openclaw channels list` imprime o mesmo snapshot de uso junto com a configuração do provedor (use `--no-usage` para pular).
- Barra de menus do macOS: seção “Uso” em Context (somente se disponível).

## Provedores + credenciais

- **Anthropic (Claude)**: tokens OAuth em perfis de autenticação.
- **GitHub Copilot**: tokens OAuth em perfis de autenticação.
- **Gemini CLI**: tokens OAuth em perfis de autenticação.
- **Antigravity**: tokens OAuth em perfis de autenticação.
- **OpenAI Codex**: tokens OAuth em perfis de autenticação (accountId usado quando presente).
- **MiniMax**: chave de API (chave do plano de codificação; `MINIMAX_CODE_PLAN_KEY` ou `MINIMAX_API_KEY`); usa a janela de 5 horas do plano de codificação.
- **z.ai**: chave de API via variáveis de ambiente/configuração/armazenamento de autenticação.

O uso fica oculto se não existirem credenciais OAuth/API correspondentes.
