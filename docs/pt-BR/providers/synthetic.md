---
summary: "Use a API compatível com Anthropic da Synthetic no OpenClaw"
read_when:
  - Você quer usar a Synthetic como um provedor de modelo
  - Você precisa de uma chave de API da Synthetic ou de uma configuração de URL base
title: "Synthetic"
---

# Synthetic

A Synthetic expõe endpoints compatíveis com Anthropic. O OpenClaw a registra como o provedor
`synthetic` e usa a API Anthropic Messages.

## Início rápido

1. Defina `SYNTHETIC_API_KEY` (ou execute o assistente abaixo).
2. Executar integração:

```bash
openclaw onboard --auth-choice synthetic-api-key
```

O modelo padrão é definido como:

```
synthetic/hf:MiniMaxAI/MiniMax-M2.1
```

## Exemplo de configuração

```json5
{
  env: { SYNTHETIC_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "synthetic/hf:MiniMaxAI/MiniMax-M2.1" },
      models: { "synthetic/hf:MiniMaxAI/MiniMax-M2.1": { alias: "MiniMax M2.1" } },
    },
  },
  models: {
    mode: "merge",
    providers: {
      synthetic: {
        baseUrl: "https://api.synthetic.new/anthropic",
        apiKey: "${SYNTHETIC_API_KEY}",
        api: "anthropic-messages",
        models: [
          {
            id: "hf:MiniMaxAI/MiniMax-M2.1",
            name: "MiniMax M2.1",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 192000,
            maxTokens: 65536,
          },
        ],
      },
    },
  },
}
```

Nota: o cliente Anthropic do OpenClaw acrescenta `/v1` à URL base, então use
`https://api.synthetic.new/anthropic` (não `/anthropic/v1`). Se a Synthetic alterar
sua URL base, substitua `models.providers.synthetic.baseUrl`.

## Catálogo de modelos

Todos os modelos abaixo usam custo `0` (entrada/saída/cache).

| ID do modelo                                           | Janela de contexto | Máx. tokens | Raciocínio | Entrada      |
| ------------------------------------------------------ | ------------------ | --------------------------- | ---------- | ------------ |
| `hf:MiniMaxAI/MiniMax-M2.1`                            | 192000             | 65536                       | false      | text         |
| `hf:moonshotai/Kimi-K2-Thinking`                       | 256000             | 8192                        | true       | text         |
| `hf:zai-org/GLM-4.7`                                   | 198000             | 128000                      | false      | text         |
| `hf:deepseek-ai/DeepSeek-R1-0528`                      | 128000             | 8192                        | false      | text         |
| `hf:deepseek-ai/DeepSeek-V3-0324`                      | 128000             | 8192                        | false      | text         |
| `hf:deepseek-ai/DeepSeek-V3.1`                         | 128000             | 8192                        | false      | text         |
| `hf:deepseek-ai/DeepSeek-V3.1-Terminus`                | 128000             | 8192                        | false      | text         |
| `hf:deepseek-ai/DeepSeek-V3.2`                         | 159000             | 8192                        | false      | text         |
| `hf:meta-llama/Llama-3.3-70B-Instruct`                 | 128000             | 8192                        | false      | text         |
| `hf:meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8` | 524000             | 8192                        | false      | text         |
| `hf:moonshotai/Kimi-K2-Instruct-0905`                  | 256000             | 8192                        | false      | text         |
| `hf:openai/gpt-oss-120b`                               | 128000             | 8192                        | false      | text         |
| `hf:Qwen/Qwen3-235B-A22B-Instruct-2507`                | 256000             | 8192                        | false      | text         |
| `hf:Qwen/Qwen3-Coder-480B-A35B-Instruct`               | 256000             | 8192                        | false      | text         |
| `hf:Qwen/Qwen3-VL-235B-A22B-Instruct`                  | 250000             | 8192                        | false      | text + image |
| `hf:zai-org/GLM-4.5`                                   | 128000             | 128000                      | false      | text         |
| `hf:zai-org/GLM-4.6`                                   | 198000             | 128000                      | false      | text         |
| `hf:deepseek-ai/DeepSeek-V3`                           | 128000             | 8192                        | false      | text         |
| `hf:Qwen/Qwen3-235B-A22B-Thinking-2507`                | 256000             | 8192                        | true       | text         |

## Notas

- As referências de modelo usam `synthetic/<modelId>`.
- Se você ativar uma lista de permissões de modelos (`agents.defaults.models`), adicione todos os modelos que
  você pretende usar.
- Veja [Model providers](/concepts/model-providers) para regras de provedores.
