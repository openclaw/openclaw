---
summary: "Janela de contexto + compactação: como OpenClaw mantém sessões dentro de limites de modelo"
read_when:
  - Você quer entender auto-compactação e /compact
  - Você está debugando sessões longas atingindo limites de contexto
title: "Compactação"
---

# Janela de Contexto & Compactação

Cada modelo tem uma **janela de contexto** (máximo de tokens que pode ver). Chats de longa duração acumulam mensagens e resultados de ferramentas; uma vez que a janela fica apertada, OpenClaw **compacta** histórico mais antigo para ficar dentro dos limites.

## O que é compactação

Compactação **resume conversa mais antiga** em uma entrada de resumo compacta e mantém mensagens recentes intactas. O resumo é armazenado no histórico de sessão, então requisições futuras usam:

- O resumo de compactação
- Mensagens recentes após o ponto de compactação

Compactação **persiste** no histórico JSONL da sessão.

## Configuração

Use a configuração `agents.defaults.compaction` em seu `openclaw.json` para configurar comportamento de compactação (modo, tokens alvo, etc.).

## Auto-compactação (padrão ativado)

Quando uma sessão se aproxima ou excede a janela de contexto do modelo, OpenClaw ativa auto-compactação e pode repetir a requisição original usando o contexto compactado.

Você verá:

- `🧹 Auto-compaction complete` em modo verbose
- `/status` mostrando `🧹 Compactions: <count>`

Antes de compactação, OpenClaw pode executar uma volta de **flush de memória silencioso** para armazenar notas duráveis em disco. Veja [Memória](/pt-BR/concepts/memory) para detalhes e config.

## Compactação manual

Use `/compact` (opcionalmente com instruções) para forçar uma passagem de compactação:

```
/compact Focus on decisions and open questions
```

## Fonte de janela de contexto

Janela de contexto é específica do modelo. OpenClaw usa a definição de modelo do catálogo de provedor configurado para determinar limites.

## Compactação vs pruning

- **Compactação**: resume e **persiste** em JSONL.
- **Session pruning**: aparas resultados de ferramenta **antigos** apenas, **na memória**, por requisição.

Veja [/pt-BR/concepts/session-pruning](/pt-BR/concepts/session-pruning) para detalhes de pruning.

## Dicas

- Use `/compact` quando sessões parecem obsoletas ou contexto está inchado.
- Saídas de ferramenta grandes já são truncadas; pruning pode reduzir ainda mais o buildup de tool-result.
- Se você precisar de um slate fresco, `/new` ou `/reset` inicia um novo id de sessão.
