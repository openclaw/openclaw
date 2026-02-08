---
summary: "Brug Z.AI (GLM-modeller) med OpenClaw"
read_when:
  - Du vil have Z.AI / GLM-modeller i OpenClaw
  - Du har brug for en enkel ZAI_API_KEY-opsætning
title: "Z.AI"
x-i18n:
  source_path: providers/zai.md
  source_hash: 2c24bbad86cf86c3
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:35Z
---

# Z.AI

Z.AI er API-platformen for **GLM**-modeller. Den leverer REST-API’er til GLM og bruger API-nøgler
til autentificering. Opret din API-nøgle i Z.AI-konsollen. OpenClaw bruger udbyderen `zai`
med en Z.AI API-nøgle.

## CLI-opsætning

```bash
openclaw onboard --auth-choice zai-api-key
# or non-interactive
openclaw onboard --zai-api-key "$ZAI_API_KEY"
```

## Konfigurationsudsnit

```json5
{
  env: { ZAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "zai/glm-4.7" } } },
}
```

## Noter

- GLM-modeller er tilgængelige som `zai/<model>` (eksempel: `zai/glm-4.7`).
- Se [/providers/glm](/providers/glm) for overblik over modelfamilien.
- Z.AI bruger Bearer-autentificering med din API-nøgle.
