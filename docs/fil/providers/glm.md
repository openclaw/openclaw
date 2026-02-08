---
summary: "Pangkalahatang-ideya ng pamilya ng modelong GLM + kung paano ito gamitin sa OpenClaw"
read_when:
  - Gusto mo ng mga modelong GLM sa OpenClaw
  - Kailangan mo ang kombensyon ng pangalan ng modelo at setup
title: "Mga Modelong GLM"
x-i18n:
  source_path: providers/glm.md
  source_hash: 2d7b457f033f26f2
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:41Z
---

# Mga modelong GLM

Ang GLM ay isang **pamilya ng modelo** (hindi isang kumpanya) na available sa pamamagitan ng platform ng Z.AI. Sa OpenClaw, ina-access ang mga modelong GLM sa pamamagitan ng provider na `zai` at mga model ID gaya ng `zai/glm-4.7`.

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
