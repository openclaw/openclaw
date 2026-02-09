---
summary: "Utiliser l’API compatible Anthropic de Synthetic dans OpenClaw"
read_when:
  - Vous souhaitez utiliser Synthetic comme fournisseur de modele
  - Vous avez besoin d’une cle API Synthetic ou d’une configuration d’URL de base
title: "Synthetic"
---

# Synthetic

Synthetic expose des points de terminaison compatibles avec Anthropic. OpenClaw l’enregistre comme fournisseur
`synthetic` et utilise l’API Anthropic Messages.

## Demarrage rapide

1. Definissez `SYNTHETIC_API_KEY` (ou lancez l’assistant ci-dessous).
2. Exécuter l'intégration :

```bash
openclaw onboard --auth-choice synthetic-api-key
```

Le modele par defaut est defini sur :

```
synthetic/hf:MiniMaxAI/MiniMax-M2.1
```

## Exemple de configuration

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

Remarque : le client Anthropic d’OpenClaw ajoute `/v1` a l’URL de base ; utilisez donc
`https://api.synthetic.new/anthropic` (et non `/anthropic/v1`). Si Synthetic modifie
son URL de base, remplacez `models.providers.synthetic.baseUrl`.

## Catalogue de modeles

Tous les modeles ci-dessous utilisent le cout `0` (entree/sortie/cache).

| Model ID                                               | Fenetre de contexte | Tokens max | Raisonnement | Entree       |
| ------------------------------------------------------ | ------------------- | ---------- | ------------ | ------------ |
| `hf:MiniMaxAI/MiniMax-M2.1`                            | 192000              | 65536      | false        | text         |
| `hf:moonshotai/Kimi-K2-Thinking`                       | 256000              | 8192       | true         | text         |
| `hf:zai-org/GLM-4.7`                                   | 198000              | 128000     | false        | text         |
| `hf:deepseek-ai/DeepSeek-R1-0528`                      | 128000              | 8192       | false        | text         |
| `hf:deepseek-ai/DeepSeek-V3-0324`                      | 128000              | 8192       | false        | text         |
| `hf:deepseek-ai/DeepSeek-V3.1`                         | 128000              | 8192       | false        | text         |
| `hf:deepseek-ai/DeepSeek-V3.1-Terminus`                | 128000              | 8192       | false        | text         |
| `hf:deepseek-ai/DeepSeek-V3.2`                         | 159000              | 8192       | false        | text         |
| `hf:meta-llama/Llama-3.3-70B-Instruct`                 | 128000              | 8192       | false        | text         |
| `hf:meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8` | 524000              | 8192       | false        | text         |
| `hf:moonshotai/Kimi-K2-Instruct-0905`                  | 256000              | 8192       | false        | text         |
| `hf:openai/gpt-oss-120b`                               | 128000              | 8192       | false        | text         |
| `hf:Qwen/Qwen3-235B-A22B-Instruct-2507`                | 256000              | 8192       | false        | text         |
| `hf:Qwen/Qwen3-Coder-480B-A35B-Instruct`               | 256000              | 8192       | false        | text         |
| `hf:Qwen/Qwen3-VL-235B-A22B-Instruct`                  | 250000              | 8192       | false        | text + image |
| `hf:zai-org/GLM-4.5`                                   | 128000              | 128000     | false        | text         |
| `hf:zai-org/GLM-4.6`                                   | 198000              | 128000     | false        | text         |
| `hf:deepseek-ai/DeepSeek-V3`                           | 128000              | 8192       | false        | text         |
| `hf:Qwen/Qwen3-235B-A22B-Thinking-2507`                | 256000              | 8192       | true         | text         |

## Notes

- Les references de modele utilisent `synthetic/<modelId>`.
- Si vous activez une liste d’autorisation de modeles (`agents.defaults.models`), ajoutez chaque modele que
  vous prevoyez d’utiliser.
- Voir [Model providers](/concepts/model-providers) pour les regles des fournisseurs.
