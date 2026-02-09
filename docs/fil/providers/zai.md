---
summary: "Gamitin ang Z.AI (mga modelong GLM) sa OpenClaw"
read_when:
  - Gusto mo ng Z.AI / mga modelong GLM sa OpenClaw
  - Kailangan mo ng simpleng setup ng ZAI_API_KEY
title: "Z.AI"
---

# Z.AI

17. Ang Z.AI ay ang API platform para sa mga **GLM** model. 18. Nagbibigay ito ng mga REST API para sa GLM at gumagamit ng mga API key para sa authentication. 19. Gumawa ng iyong API key sa Z.AI console. 20. Ginagamit ng OpenClaw ang `zai` provider kasama ang isang Z.AI API key.

## Setup ng CLI

```bash
openclaw onboard --auth-choice zai-api-key
# or non-interactive
openclaw onboard --zai-api-key "$ZAI_API_KEY"
```

## Snippet ng config

```json5
{
  env: { ZAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "zai/glm-4.7" } } },
}
```

## Mga tala

- Available ang mga modelong GLM bilang `zai/<model>` (halimbawa: `zai/glm-4.7`).
- Tingnan ang [/providers/glm](/providers/glm) para sa pangkalahatang-ideya ng pamilya ng model.
- Gumagamit ang Z.AI ng Bearer auth gamit ang iyong API key.
