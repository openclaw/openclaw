---
summary: "Używaj Z.AI (modele GLM) z OpenClaw"
read_when:
  - Chcesz korzystać z modeli Z.AI / GLM w OpenClaw
  - Potrzebujesz prostej konfiguracji ZAI_API_KEY
title: "Z.AI"
---

# Z.AI

Z.AI to platforma API dla modeli **GLM**. Udostępnia interfejsy REST API dla GLM i używa kluczy API
do uwierzytelniania. Utwórz klucz API w konsoli Z.AI. OpenClaw używa dostawcy `zai` z kluczem API Z.AI.

## konfiguracja CLI

```bash
openclaw onboard --auth-choice zai-api-key
# or non-interactive
openclaw onboard --zai-api-key "$ZAI_API_KEY"
```

## Fragment konfiguracji

```json5
{
  env: { ZAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "zai/glm-4.7" } } },
}
```

## Uwagi

- Modele GLM są dostępne jako `zai/<model>` (przykład: `zai/glm-4.7`).
- Zobacz [/providers/glm](/providers/glm), aby uzyskać przegląd rodziny modeli.
- Z.AI używa uwierzytelniania Bearer z Twoim kluczem API.
