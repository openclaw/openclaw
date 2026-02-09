---
summary: "Execute o OpenClaw em LLMs locais (LM Studio, vLLM, LiteLLM, endpoints OpenAI personalizados)"
read_when:
  - Você quer servir modelos a partir do seu próprio box de GPU
  - Você está conectando o LM Studio ou um proxy compatível com OpenAI
  - Você precisa da orientação mais segura para modelos locais
title: "Modelos locais"
---

# Modelos locais

Rodar localmente é possível, mas o OpenClaw espera **contexto grande + defesas fortes contra injeção de prompt**. Placas pequenas truncam o contexto e vazam segurança. Mire alto: **≥2 Mac Studios no máximo ou um rig de GPU equivalente (~US$ 30k+)**. Uma única GPU de **24 GB** funciona apenas para prompts mais leves, com latência maior. Use a **maior variante / tamanho completo do modelo que você conseguir rodar**; checkpoints agressivamente quantizados ou “small” aumentam o risco de injeção de prompt (veja [Security](/gateway/security)).

## Recomendado: LM Studio + MiniMax M2.1 (Responses API, tamanho completo)

Melhor stack local atual. Carregue o MiniMax M2.1 no LM Studio, habilite o servidor local (padrão `http://127.0.0.1:1234`), e use a Responses API para manter o raciocínio separado do texto final.

```json5
{
  agents: {
    defaults: {
      model: { primary: "lmstudio/minimax-m2.1-gs32" },
      models: {
        "anthropic/claude-opus-4-6": { alias: "Opus" },
        "lmstudio/minimax-m2.1-gs32": { alias: "Minimax" },
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      lmstudio: {
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: "lmstudio",
        api: "openai-responses",
        models: [
          {
            id: "minimax-m2.1-gs32",
            name: "MiniMax M2.1 GS32",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 196608,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

**Checklist de configuração**

- Instale o LM Studio: [https://lmstudio.ai](https://lmstudio.ai)
- No LM Studio, baixe a **maior build do MiniMax M2.1 disponível** (evite variantes “small”/fortemente quantizadas), inicie o servidor e confirme que `http://127.0.0.1:1234/v1/models` o lista.
- Mantenha o modelo carregado; cold-load adiciona latência de inicialização.
- Ajuste `contextWindow`/`maxTokens` se a sua build do LM Studio diferir.
- Para WhatsApp, fique na Responses API para que apenas o texto final seja enviado.

Mantenha modelos hospedados configurados mesmo ao rodar localmente; use `models.mode: "merge"` para que os fallbacks permaneçam disponíveis.

### Configuração híbrida: hospedado como primário, local como fallback

```json5
{
  agents: {
    defaults: {
      model: {
        primary: "anthropic/claude-sonnet-4-5",
        fallbacks: ["lmstudio/minimax-m2.1-gs32", "anthropic/claude-opus-4-6"],
      },
      models: {
        "anthropic/claude-sonnet-4-5": { alias: "Sonnet" },
        "lmstudio/minimax-m2.1-gs32": { alias: "MiniMax Local" },
        "anthropic/claude-opus-4-6": { alias: "Opus" },
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      lmstudio: {
        baseUrl: "http://127.0.0.1:1234/v1",
        apiKey: "lmstudio",
        api: "openai-responses",
        models: [
          {
            id: "minimax-m2.1-gs32",
            name: "MiniMax M2.1 GS32",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 196608,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

### Local primeiro com rede de segurança hospedada

Troque a ordem de primário e fallback; mantenha o mesmo bloco de providers e `models.mode: "merge"` para poder cair para Sonnet ou Opus quando o box local estiver fora do ar.

### Hospedagem regional / roteamento de dados

- Variantes hospedadas do MiniMax/Kimi/GLM também existem no OpenRouter com endpoints fixados por região (por exemplo, hospedados nos EUA). Escolha a variante regional lá para manter o tráfego na jurisdição escolhida, enquanto ainda usa `models.mode: "merge"` para fallbacks Anthropic/OpenAI.
- Local-only continua sendo o caminho de maior privacidade; o roteamento regional hospedado é o meio-termo quando você precisa de recursos do provedor, mas quer controle sobre o fluxo de dados.

## Outros proxies locais compatíveis com OpenAI

vLLM, LiteLLM, OAI-proxy ou gateways personalizados funcionam se expuserem um endpoint `/v1` no estilo OpenAI. Substitua o bloco de provider acima pelo seu endpoint e ID de modelo:

```json5
{
  models: {
    mode: "merge",
    providers: {
      local: {
        baseUrl: "http://127.0.0.1:8000/v1",
        apiKey: "sk-local",
        api: "openai-responses",
        models: [
          {
            id: "my-local-model",
            name: "Local Model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 120000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

Mantenha `models.mode: "merge"` para que modelos hospedados permaneçam disponíveis como fallbacks.

## Solução de problemas

- O Gateway consegue alcançar o proxy? `curl http://127.0.0.1:1234/v1/models`.
- Modelo do LM Studio descarregado? Recarregue; cold start é uma causa comum de “travamento”.
- Erros de contexto? Reduza `contextWindow` ou aumente o limite do seu servidor.
- Segurança: modelos locais pulam filtros do lado do provedor; mantenha agentes estreitos e a compactação ativada para limitar o raio de impacto de injeção de prompt.
