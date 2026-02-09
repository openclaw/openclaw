---
summary: "Poda de sessão: corte de resultados de ferramentas para reduzir o inchaço de contexto"
read_when:
  - Você quer reduzir o crescimento de contexto do LLM a partir de saídas de ferramentas
  - Você está ajustando agents.defaults.contextPruning
---

# Poda de sessão

A poda de sessão remove **resultados antigos de ferramentas** do contexto em memória imediatamente antes de cada chamada ao LLM. Ela **não** reescreve o histórico de sessão no disco (`*.jsonl`).

## Quando ela é executada

- Quando `mode: "cache-ttl"` está habilitado e a última chamada Anthropic da sessão é mais antiga que `ttl`.
- Afeta apenas as mensagens enviadas ao modelo para aquela solicitação.
- Ativa apenas para chamadas à API Anthropic (e modelos Anthropic do OpenRouter).
- Para melhores resultados, combine `ttl` com o `cacheControlTtl` do seu modelo.
- Após uma poda, a janela de TTL é redefinida, de modo que solicitações subsequentes mantêm o cache até `ttl` expirar novamente.

## Padrões inteligentes (Anthropic)

- Perfis **OAuth ou setup-token**: habilite a poda `cache-ttl` e defina o heartbeat como `1h`.
- Perfis de **chave de API**: habilite a poda `cache-ttl`, defina o heartbeat como `30m` e defina o `cacheControlTtl` padrão como `1h` em modelos Anthropic.
- Se você definir qualquer um desses valores explicitamente, o OpenClaw **não** os substitui.

## O que isso melhora (custo + comportamento de cache)

- **Por que podar:** o cache de prompts da Anthropic só se aplica dentro do TTL. Se uma sessão fica ociosa além do TTL, a próxima solicitação recacheia o prompt completo, a menos que você o corte antes.
- **O que fica mais barato:** a poda reduz o tamanho de **cacheWrite** para essa primeira solicitação após o TTL expirar.
- **Por que a redefinição do TTL importa:** quando a poda é executada, a janela de cache é redefinida, então solicitações seguintes podem reutilizar o prompt recém-cacheado em vez de recachear todo o histórico novamente.
- **O que não faz:** a poda não adiciona tokens nem “duplica” custos; ela apenas altera o que é cacheado nessa primeira solicitação pós‑TTL.

## O que pode ser podado

- Apenas mensagens `toolResult`.
- Mensagens de usuário + assistente **nunca** são modificadas.
- As últimas `keepLastAssistants` mensagens do assistente são protegidas; resultados de ferramentas após esse corte não são podados.
- Se não houver mensagens do assistente suficientes para estabelecer o corte, a poda é ignorada.
- Resultados de ferramentas que contêm **blocos de imagem** são ignorados (nunca cortados/limpos).

## Estimativa da janela de contexto

A poda usa uma estimativa da janela de contexto (caracteres ≈ tokens × 4). A janela base é resolvida nesta ordem:

1. Substituição `models.providers.*.models[].contextWindow`.
2. Definição do modelo `contextWindow` (do registro de modelos).
3. Padrão de `200000` tokens.

Se `agents.defaults.contextTokens` estiver definido, ele é tratado como um limite (mín.) na janela resolvida.

## Modo

### cache-ttl

- A poda só é executada se a última chamada Anthropic for mais antiga que `ttl` (padrão `5m`).
- Quando é executada: mesmo comportamento de soft-trim + hard-clear de antes.

## Poda suave vs. poda rígida

- **Soft-trim**: apenas para resultados de ferramentas superdimensionados.
  - Mantém início + fim, insere `...` e anexa uma nota com o tamanho original.
  - Ignora resultados com blocos de imagem.
- **Hard-clear**: substitui todo o resultado da ferramenta por `hardClear.placeholder`.

## Seleção de ferramentas

- `tools.allow` / `tools.deny` suportam curingas `*`.
- Negar vitórias.
- Correspondência é insensível a maiúsculas e minúsculas.
- Lista de permissão vazia => todas as ferramentas permitidas.

## Interação com outros limites

- Ferramentas integradas já truncam sua própria saída; a poda de sessão é uma camada extra que impede chats de longa duração de acumularem saída excessiva de ferramentas no contexto do modelo.
- A compactação é separada: a compactação resume e persiste, a poda é transitória por solicitação. Veja [/concepts/compaction](/concepts/compaction).

## Padrões (quando habilitado)

- `ttl`: `"5m"`
- `keepLastAssistants`: `3`
- `softTrimRatio`: `0.3`
- `hardClearRatio`: `0.5`
- `minPrunableToolChars`: `50000`
- `softTrim`: `{ maxChars: 4000, headChars: 1500, tailChars: 1500 }`
- `hardClear`: `{ enabled: true, placeholder: "[Old tool result content cleared]" }`

## Exemplos

Padrão (desativado):

```json5
{
  agent: {
    contextPruning: { mode: "off" },
  },
}
```

Habilitar poda consciente de TTL:

```json5
{
  agent: {
    contextPruning: { mode: "cache-ttl", ttl: "5m" },
  },
}
```

Restringir a poda a ferramentas específicas:

```json5
{
  agent: {
    contextPruning: {
      mode: "cache-ttl",
      tools: { allow: ["exec", "read"], deny: ["*image*"] },
    },
  },
}
```

Veja a referência de configuração: [Gateway Configuration](/gateway/configuration)
