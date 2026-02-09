---
summary: "Brug Synthetics Anthropic-kompatible API i OpenClaw"
read_when:
  - Du vil bruge Synthetic som modeludbyder
  - Du har brug for en Synthetic API-nøgle eller opsætning af basis-URL
title: "Synthetic"
---

# Synthetic

Syntetisk udsætter Antropisk-kompatible endepunkter. OpenClaw registrerer det som
'syntetisk' udbyder og bruger antropiske beskeder API.

## Hurtig opsætning

1. Sæt `SYNTHETIC_API_KEY` (eller kør opsætningsguiden nedenfor).
2. Kør introduktion:

```bash
openclaw onboard --auth-choice synthetic-api-key
```

Standardmodellen er sat til:

```
synthetic/hf:MiniMaxAI/MiniMax-M2.1
```

## Konfigurationseksempel

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

Bemærk: OpenClaw's Antropiske klient tilføjer `/v1` til basis-URL, så brug
`https://api.synthetic.new/anthropic` (ikke `/anthropic/v1`). Hvis Syntetiske ændringer
dens base URL, tilsidesætte `models.providers.synthetic.baseUrl`.

## Modelkatalog

Alle modeller nedenfor bruger omkostning `0` (input/output/cache).

| Model-ID                                               | Kontekstvindue | Maks. tokens | Ræsonnering | Input        |
| ------------------------------------------------------ | -------------- | ---------------------------- | ----------- | ------------ |
| `hf:MiniMaxAI/MiniMax-M2.1`                            | 192000         | 65536                        | false       | text         |
| `hf:moonshotai/Kimi-K2-Thinking`                       | 256000         | 8192                         | true        | text         |
| `hf:zai-org/GLM-4.7`                                   | 198000         | 128000                       | false       | text         |
| `hf:deepseek-ai/DeepSeek-R1-0528`                      | 128000         | 8192                         | false       | text         |
| `hf:deepseek-ai/DeepSeek-V3-0324`                      | 128000         | 8192                         | false       | text         |
| `hf:deepseek-ai/DeepSeek-V3.1`                         | 128000         | 8192                         | false       | text         |
| `hf:deepseek-ai/DeepSeek-V3.1-Terminus`                | 128000         | 8192                         | false       | text         |
| `hf:deepseek-ai/DeepSeek-V3.2`                         | 159000         | 8192                         | false       | text         |
| `hf:meta-llama/Llama-3.3-70B-Instruct`                 | 128000         | 8192                         | false       | text         |
| `hf:meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8` | 524000         | 8192                         | false       | text         |
| `hf:moonshotai/Kimi-K2-Instruct-0905`                  | 256000         | 8192                         | false       | text         |
| `hf:openai/gpt-oss-120b`                               | 128000         | 8192                         | false       | text         |
| `hf:Qwen/Qwen3-235B-A22B-Instruct-2507`                | 256000         | 8192                         | false       | text         |
| `hf:Qwen/Qwen3-Coder-480B-A35B-Instruct`               | 256000         | 8192                         | false       | text         |
| `hf:Qwen/Qwen3-VL-235B-A22B-Instruct`                  | 250000         | 8192                         | false       | text + image |
| `hf:zai-org/GLM-4.5`                                   | 128000         | 128000                       | false       | text         |
| `hf:zai-org/GLM-4.6`                                   | 198000         | 128000                       | false       | text         |
| `hf:deepseek-ai/DeepSeek-V3`                           | 128000         | 8192                         | false       | text         |
| `hf:Qwen/Qwen3-235B-A22B-Thinking-2507`                | 256000         | 8192                         | true        | text         |

## Noter

- Modelreferencer bruger `synthetic/<modelId>`.
- Hvis du aktiverer en model-tilladelsesliste (`agents.defaults.models`), skal du tilføje alle de modeller, du
  planlægger at bruge.
- Se [Model providers](/concepts/model-providers) for udbyderregler.
