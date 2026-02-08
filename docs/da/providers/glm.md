---
summary: "Overblik over GLM-modelfamilien + hvordan du bruger den i OpenClaw"
read_when:
  - Du vil bruge GLM-modeller i OpenClaw
  - Du har brug for navngivningskonventionen for modeller og opsætning
title: "GLM-modeller"
x-i18n:
  source_path: providers/glm.md
  source_hash: 2d7b457f033f26f2
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:28Z
---

# GLM-modeller

GLM er en **model-familie** (ikke et firma), som er tilgængelig via Z.AI-platformen. I OpenClaw
tilgås GLM-modeller via `zai`-udbyderen og model-id’er som `zai/glm-4.7`.

## CLI-opsætning

```bash
openclaw onboard --auth-choice zai-api-key
```

## Konfigurationsudsnit

```json5
{
  env: { ZAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "zai/glm-4.7" } } },
}
```

## Noter

- GLM-versioner og tilgængelighed kan ændre sig; tjek Z.AI’s dokumentation for det seneste.
- Eksempler på model-id’er inkluderer `glm-4.7` og `glm-4.6`.
- For udbyderdetaljer, se [/providers/zai](/providers/zai).
