---
summary: "Översikt över GLM-modellfamiljen + hur du använder den i OpenClaw"
read_when:
  - Du vill använda GLM-modeller i OpenClaw
  - Du behöver namngivningskonventionen och konfigureringen av modeller
title: "GLM-modeller"
x-i18n:
  source_path: providers/glm.md
  source_hash: 2d7b457f033f26f2
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T08:18:05Z
---

# GLM-modeller

GLM är en **modellfamilj** (inte ett företag) som är tillgänglig via Z.AI-plattformen. I OpenClaw nås GLM‑modeller via leverantören `zai` och modell-ID:n som `zai/glm-4.7`.

## CLI-konfigurering

```bash
openclaw onboard --auth-choice zai-api-key
```

## Konfigutdrag

```json5
{
  env: { ZAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "zai/glm-4.7" } } },
}
```

## Noteringar

- GLM-versioner och tillgänglighet kan ändras; kontrollera Z.AI:s dokumentation för det senaste.
- Exempel på modell-ID:n inkluderar `glm-4.7` och `glm-4.6`.
- För leverantörsdetaljer, se [/providers/zai](/providers/zai).
