---
title: "Pruning de Sessão"
summary: "Session pruning: trimming de tool-result para reduzir context bloat"
read_when:
  - Você quer reduzir crescimento de contexto LLM de saídas de ferramenta
  - Você está ajustando agents.defaults.contextPruning
---

# Pruning de Sessão

Pruning de sessão aparas **resultados de ferramenta antiga** do contexto na memória logo antes de cada chamada de LLM. Ele **não** reescreve o histórico de sessão em disco (`*.jsonl`).

## Quando executa

- Quando `mode: "cache-ttl"` está habilitado e a última chamada Anthropic para a sessão é mais antiga que `ttl`.
- Apenas afeta mensagens enviadas ao modelo para aquela requisição.
- Apenas ativo para chamadas da API Anthropic (e modelos Anthropic da OpenRouter).
- Para melhores resultados, combine `ttl` com seu modelo `cacheControlTtl`.
- Após um prune, a janela de TTL reseta para que requisições subsequentes mantenham cache até `ttl` expirar novamente.

## Padrões inteligentes (Anthropic)

- **Perfis OAuth ou setup-token**: habilite pruning `cache-ttl` e defina heartbeat para `1h`.
- **Perfis de chave de API**: habilite pruning `cache-ttl`, defina heartbeat para `30m` e `cacheControlTtl` padrão para `1h` em modelos Anthropic.
- Se você definir qualquer desses valores explicitamente, OpenClaw **não** os sobrescreve.

## O que melhora (custo + comportamento de cache)

- **Por que prune**: Caching de prompt Anthropic apenas se aplica dentro do TTL. Se uma sessão fica ociosa passada a TTL, a próxima requisição re-cachea o prompt completo a menos que você o corte primeiro.
- **O que fica mais barato**: pruning reduz o tamanho **cacheWrite** para aquela primeira requisição após a TTL expirar.
- **Por que o reset de TTL importa**: uma vez que pruning executa, a janela de cache reseta, então requisições de follow-up podem reutilizar o prompt recém-cacheado em vez de re-cachear o histórico completo novamente.
- **O que não faz**: pruning não adiciona tokens ou "duplica" custos; apenas muda o que é cacheado naquela primeira requisição pós-TTL.

## O que pode ser podado

- Apenas mensagens `toolResult`.
- Mensagens de usuário + assistente são **nunca** modificadas.
- As últimas `keepLastAssistants` mensagens de assistente são protegidas; resultados de ferramenta após aquele cutoff não são podados.
- Se não há assistentes suficientes para estabelecer o cutoff, pruning é ignorado.
- Resultados de ferramenta contendo **image blocks** são ignorados (nunca trimados/limpos).

## Estimação de janela de contexto

Pruning usa uma janela de contexto estimada (chars ≈ tokens × 4). A janela base é resolvida nesta ordem:

1. Override `models.providers.*.models[].contextWindow`.
2. Definição de modelo `contextWindow` (do registry de modelo).
3. Padrão `200000` tokens.

Se `agents.defaults.contextTokens` estiver definido, é tratado como um cap (min) na janela resolvida.

## Modo

### cache-ttl

- Pruning apenas executa se a última chamada Anthropic é mais antiga que `ttl` (padrão `5m`).
- Quando executa: mesmo comportamento soft-trim + hard-clear como antes.

## Soft vs hard pruning

- **Soft-trim**: apenas para resultados de ferramenta oversized.
  - Mantém head + tail, insere `...` e anexa uma nota com o tamanho original.
  - Ignora resultados com image blocks.
- **Hard-clear**: substitui o resultado de ferramenta inteiro com `hardClear.placeholder`.

## Seleção de ferramenta

- `tools.allow` / `tools.deny` suportam wildcards `*`.
- Deny vence.
- Matching é case-insensitive.
- Lista de allow vazia => todas as ferramentas permitidas.

## Interação com outros limites

- Ferramentas integradas já truncam sua própria saída; session pruning é uma camada extra que previne chats de longa execução de acumular muita saída de ferramenta no contexto do modelo.
- Compactação é separada: compactação resume e persiste, pruning é transitório por requisição. Veja [/pt-BR/concepts/compaction](/pt-BR/concepts/compaction).

## Padrões (quando habilitado)

- `ttl`: `"5m"`
