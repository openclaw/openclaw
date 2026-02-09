---
summary: "Overblik over GLM-modelfamilien + hvordan du bruger den i OpenClaw"
read_when:
  - Du vil bruge GLM-modeller i OpenClaw
  - Du har brug for navngivningskonventionen for modeller og opsætning
title: "GLM-modeller"
---

# GLM-modeller

GLM er en **modelfamilie** (ikke en virksomhed) tilgængelig via Z.AI platformen. I OpenClaw, GLM
modeller er tilgængelige via `zai` udbyder og model ID'er som `zai/glm-4.7`.

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
