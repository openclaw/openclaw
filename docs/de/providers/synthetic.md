---
summary: "„Verwenden Sie die Anthropic-kompatible API von Synthetic in OpenClaw“"
read_when:
  - Sie möchten Synthetic als Modellanbieter verwenden
  - Sie benötigen einen Synthetic-API-Schlüssel oder eine Base-URL-Einrichtung
title: "Synthetic"
---

# Synthetic

Synthetic stellt Anthropic-kompatible Endpunkte bereit. OpenClaw registriert es als
`synthetic`-Anbieter und verwendet die Anthropic Messages API.

## Schnellstart

1. Setzen Sie `SYNTHETIC_API_KEY` (oder führen Sie den Assistenten unten aus).
2. Führen Sie das Onboarding aus:

```bash
openclaw onboard --auth-choice synthetic-api-key
```

Das Standardmodell ist eingestellt auf:

```
synthetic/hf:MiniMaxAI/MiniMax-M2.1
```

## Konfigurationsbeispiel

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

Hinweis: Der Anthropic-Client von OpenClaw hängt `/v1` an die Base-URL an, verwenden Sie daher
`https://api.synthetic.new/anthropic` (nicht `/anthropic/v1`). Wenn Synthetic
seine Base-URL ändert, überschreiben Sie `models.providers.synthetic.baseUrl`.

## Modellkatalog

Alle unten aufgeführten Modelle verwenden Kosten `0` (Eingabe/Ausgabe/Cache).

| Modell-ID                                              | Kontextfenster | Maximale Tokens | Reasoning | Eingabe     |
| ------------------------------------------------------ | -------------- | --------------- | --------- | ----------- |
| `hf:MiniMaxAI/MiniMax-M2.1`                            | 192000         | 65536           | false     | Text        |
| `hf:moonshotai/Kimi-K2-Thinking`                       | 256000         | 8192            | true      | Text        |
| `hf:zai-org/GLM-4.7`                                   | 198000         | 128000          | false     | Text        |
| `hf:deepseek-ai/DeepSeek-R1-0528`                      | 128000         | 8192            | false     | Text        |
| `hf:deepseek-ai/DeepSeek-V3-0324`                      | 128000         | 8192            | false     | Text        |
| `hf:deepseek-ai/DeepSeek-V3.1`                         | 128000         | 8192            | false     | Text        |
| `hf:deepseek-ai/DeepSeek-V3.1-Terminus`                | 128000         | 8192            | false     | Text        |
| `hf:deepseek-ai/DeepSeek-V3.2`                         | 159000         | 8192            | false     | Text        |
| `hf:meta-llama/Llama-3.3-70B-Instruct`                 | 128000         | 8192            | false     | Text        |
| `hf:meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8` | 524000         | 8192            | false     | Text        |
| `hf:moonshotai/Kimi-K2-Instruct-0905`                  | 256000         | 8192            | false     | Text        |
| `hf:openai/gpt-oss-120b`                               | 128000         | 8192            | false     | Text        |
| `hf:Qwen/Qwen3-235B-A22B-Instruct-2507`                | 256000         | 8192            | false     | Text        |
| `hf:Qwen/Qwen3-Coder-480B-A35B-Instruct`               | 256000         | 8192            | false     | Text        |
| `hf:Qwen/Qwen3-VL-235B-A22B-Instruct`                  | 250000         | 8192            | false     | Text + Bild |
| `hf:zai-org/GLM-4.5`                                   | 128000         | 128000          | false     | Text        |
| `hf:zai-org/GLM-4.6`                                   | 198000         | 128000          | false     | Text        |
| `hf:deepseek-ai/DeepSeek-V3`                           | 128000         | 8192            | false     | Text        |
| `hf:Qwen/Qwen3-235B-A22B-Thinking-2507`                | 256000         | 8192            | true      | Text        |

## Hinweise

- Modellreferenzen verwenden `synthetic/<modelId>`.
- Wenn Sie eine Modell-Allowlist aktivieren (`agents.defaults.models`), fügen Sie jedes Modell hinzu, das Sie
  verwenden möchten.
- Siehe [Model providers](/concepts/model-providers) für Anbieterregeln.
