---
summary: "Overzicht van de GLM-modelfamilie + hoe je deze gebruikt in OpenClaw"
read_when:
  - Je wilt GLM-modellen in OpenClaw gebruiken
  - Je hebt de modelnaamgevingsconventie en installatie nodig
title: "GLM-modellen"
x-i18n:
  source_path: providers/glm.md
  source_hash: 2d7b457f033f26f2
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:46:37Z
---

# GLM-modellen

GLM is een **modelfamilie** (geen bedrijf) die beschikbaar is via het Z.AI-platform. In OpenClaw worden GLM
-modellen benaderd via de `zai`-provider en model-ID's zoals `zai/glm-4.7`.

## CLI-installatie

```bash
openclaw onboard --auth-choice zai-api-key
```

## Config-fragment

```json5
{
  env: { ZAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "zai/glm-4.7" } } },
}
```

## Notities

- GLM-versies en beschikbaarheid kunnen veranderen; raadpleeg de documentatie van Z.AI voor de nieuwste informatie.
- Voorbeeld-model-ID's zijn onder andere `glm-4.7` en `glm-4.6`.
- Voor provider-details, zie [/providers/zai](/providers/zai).
