---
summary: "Przegląd rodziny modeli GLM + sposób użycia w OpenClaw"
read_when:
  - Chcesz korzystać z modeli GLM w OpenClaw
  - Potrzebujesz konwencji nazewnictwa modeli i konfiguracji
title: "Modele GLM"
x-i18n:
  source_path: providers/glm.md
  source_hash: 2d7b457f033f26f2
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:51:27Z
---

# Modele GLM

GLM to **rodzina modeli** (a nie firma) dostępna za pośrednictwem platformy Z.AI. W OpenClaw modele
GLM są dostępne przez dostawcę `zai` oraz identyfikatory modeli, takie jak `zai/glm-4.7`.

## Konfiguracja CLI

```bash
openclaw onboard --auth-choice zai-api-key
```

## Fragment konfiguracji

```json5
{
  env: { ZAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "zai/glm-4.7" } } },
}
```

## Uwagi

- Wersje GLM oraz ich dostępność mogą się zmieniać; sprawdź dokumentację Z.AI, aby uzyskać najnowsze informacje.
- Przykładowe identyfikatory modeli obejmują `glm-4.7` oraz `glm-4.6`.
- Szczegóły dotyczące dostawcy znajdziesz w [/providers/zai](/providers/zai).
