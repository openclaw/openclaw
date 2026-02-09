---
summary: "Gebruik de Anthropic-compatibele API van Synthetic in OpenClaw"
read_when:
  - Je wilt Synthetic gebruiken als modelprovider
  - Je hebt een Synthetic API-sleutel of basis-URL nodig
title: "Synthetic"
---

# Synthetic

Synthetic stelt Anthropic-compatibele endpoints beschikbaar. OpenClaw registreert het als de
`synthetic`-provider en gebruikt de Anthropic Messages API.

## Snelle installatie

1. Stel `SYNTHETIC_API_KEY` in (of voer de wizard hieronder uit).
2. Voer onboarding uit:

```bash
openclaw onboard --auth-choice synthetic-api-key
```

Het standaardmodel is ingesteld op:

```
synthetic/hf:MiniMaxAI/MiniMax-M2.1
```

## Config-voorbeeld

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

Let op: de Anthropic-client van OpenClaw voegt `/v1` toe aan de basis-URL, dus gebruik
`https://api.synthetic.new/anthropic` (niet `/anthropic/v1`). Als Synthetic
de basis-URL wijzigt, overschrijf dan `models.providers.synthetic.baseUrl`.

## Modelcatalogus

Alle onderstaande modellen gebruiken kosten `0` (invoer/uitvoer/cache).

| Model-ID                                               | Contextvenster | Max. tokens | Redeneren | Invoer       |
| ------------------------------------------------------ | -------------- | --------------------------- | --------- | ------------ |
| `hf:MiniMaxAI/MiniMax-M2.1`                            | 192000         | 65536                       | false     | text         |
| `hf:moonshotai/Kimi-K2-Thinking`                       | 256000         | 8192                        | true      | text         |
| `hf:zai-org/GLM-4.7`                                   | 198000         | 128000                      | false     | text         |
| `hf:deepseek-ai/DeepSeek-R1-0528`                      | 128000         | 8192                        | false     | text         |
| `hf:deepseek-ai/DeepSeek-V3-0324`                      | 128000         | 8192                        | false     | text         |
| `hf:deepseek-ai/DeepSeek-V3.1`                         | 128000         | 8192                        | false     | text         |
| `hf:deepseek-ai/DeepSeek-V3.1-Terminus`                | 128000         | 8192                        | false     | text         |
| `hf:deepseek-ai/DeepSeek-V3.2`                         | 159000         | 8192                        | false     | text         |
| `hf:meta-llama/Llama-3.3-70B-Instruct`                 | 128000         | 8192                        | false     | text         |
| `hf:meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8` | 524000         | 8192                        | false     | text         |
| `hf:moonshotai/Kimi-K2-Instruct-0905`                  | 256000         | 8192                        | false     | text         |
| `hf:openai/gpt-oss-120b`                               | 128000         | 8192                        | false     | text         |
| `hf:Qwen/Qwen3-235B-A22B-Instruct-2507`                | 256000         | 8192                        | false     | text         |
| `hf:Qwen/Qwen3-Coder-480B-A35B-Instruct`               | 256000         | 8192                        | false     | text         |
| `hf:Qwen/Qwen3-VL-235B-A22B-Instruct`                  | 250000         | 8192                        | false     | text + image |
| `hf:zai-org/GLM-4.5`                                   | 128000         | 128000                      | false     | text         |
| `hf:zai-org/GLM-4.6`                                   | 198000         | 128000                      | false     | text         |
| `hf:deepseek-ai/DeepSeek-V3`                           | 128000         | 8192                        | false     | text         |
| `hf:Qwen/Qwen3-235B-A22B-Thinking-2507`                | 256000         | 8192                        | true      | text         |

## Notities

- Modelverwijzingen gebruiken `synthetic/<modelId>`.
- Als je een model-allowlist inschakelt (`agents.defaults.models`), voeg dan elk model toe dat je
  van plan bent te gebruiken.
- Zie [Model providers](/concepts/model-providers) voor providerregels.
