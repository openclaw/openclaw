---
summary: "Superfícies de rastreamento de uso e requisitos de credenciais"
read_when:
  - Você está conectando superfícies de uso/cota do provedor
  - Você precisa explicar comportamento de rastreamento de uso ou requisitos de auth
title: "Rastreamento de Uso"
---

# Rastreamento de uso

## O que é

- Puxa uso/cota do provedor diretamente de seus endpoints de uso.
- Sem custos estimados; apenas as janelas relatadas pelo provedor.

## Onde isso aparece

- `/status` em chats: card de status rico em emoji com tokens de sessão + custo estimado (apenas chave de API). O uso do provedor mostra para o **provedor de modelo atual** quando disponível.
- `/usage off|tokens|full` em chats: rodapé de uso por resposta (OAuth mostra apenas tokens).
- `/usage cost` em chats: resumo de custo local agregado dos logs de sessão OpenClaw.
- CLI: `openclaw status --usage` imprime um resumo completo por provedor.
- CLI: `openclaw channels list` imprime o mesmo snapshot de uso ao lado da config do provedor (use `--no-usage` para pular).
- Menu de barra macOS: seção "Usage" sob Context (apenas se disponível).

## Provedores + credenciais

- **Anthropic (Claude)**: Tokens OAuth em perfis de auth.
- **GitHub Copilot**: Tokens OAuth em perfis de auth.
- **Gemini CLI**: Tokens OAuth em perfis de auth.
- **Antigravity**: Tokens OAuth em perfis de auth.
- **OpenAI Codex**: Tokens OAuth em perfis de auth (accountId usado quando presente).
- **MiniMax**: Chave de API (chave do plano de codificação; `MINIMAX_CODE_PLAN_KEY` ou `MINIMAX_API_KEY`); usa a janela do plano de codificação de 5 horas.
- **z.ai**: Chave de API via env/config/auth store.

O uso fica oculto se não existirem credenciais OAuth/API correspondentes.
