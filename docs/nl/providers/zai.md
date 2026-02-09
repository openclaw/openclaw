---
summary: "Gebruik Z.AI (GLM-modellen) met OpenClaw"
read_when:
  - Je wilt Z.AI / GLM-modellen in OpenClaw
  - Je hebt een eenvoudige ZAI_API_KEY-installatie nodig
title: "Z.AI"
---

# Z.AI

Z.AI is het API-platform voor **GLM**-modellen. Het biedt REST-API’s voor GLM en gebruikt API-sleutels
voor authenticatie. Maak je API-sleutel aan in de Z.AI-console. OpenClaw gebruikt de `zai`-provider
met een Z.AI API-sleutel.

## CLI-installatie

```bash
openclaw onboard --auth-choice zai-api-key
# or non-interactive
openclaw onboard --zai-api-key "$ZAI_API_KEY"
```

## Config-fragment

```json5
{
  env: { ZAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "zai/glm-4.7" } } },
}
```

## Notities

- GLM-modellen zijn beschikbaar als `zai/<model>` (voorbeeld: `zai/glm-4.7`).
- Zie [/providers/glm](/providers/glm) voor het overzicht van de modelfamilie.
- Z.AI gebruikt Bearer-authenticatie met je API-sleutel.
