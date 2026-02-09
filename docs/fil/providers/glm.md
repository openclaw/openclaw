---
summary: "Pangkalahatang-ideya ng pamilya ng modelong GLM + kung paano ito gamitin sa OpenClaw"
read_when:
  - Gusto mo ng mga modelong GLM sa OpenClaw
  - Kailangan mo ang kombensyon ng pangalan ng modelo at setup
title: "Mga Modelong GLM"
---

# Mga modelong GLM

GLM is a **model family** (not a company) available through the Z.AI platform. In OpenClaw, GLM
models are accessed via the `zai` provider and model IDs like `zai/glm-4.7`.

## CLI setup

```bash
openclaw onboard --auth-choice zai-api-key
```

## Snippet ng config

```json5
{
  env: { ZAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "zai/glm-4.7" } } },
}
```

## Mga tala

- Maaaring magbago ang mga bersyon at availability ng GLM; tingnan ang docs ng Z.AI para sa pinakabago.
- Kasama sa mga halimbawang model ID ang `glm-4.7` at `glm-4.6`.
- Para sa mga detalye ng provider, tingnan ang [/providers/zai](/providers/zai).
