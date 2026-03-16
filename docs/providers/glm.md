---
summary: "GLM model family overview + how to use it in OpenClaw"
read_when:
  - You want GLM models in OpenClaw
  - You need the model naming convention and setup
title: "GLM Models"
---

# GLM models

GLM is a **model family** (not a company) available through the Z.AI platform. In OpenClaw, GLM
models are accessed via the `zai` provider and model IDs like `zai/glm-5`.

## CLI setup

```bash
# Coding Plan Global, recommended for Coding Plan users
openclaw setup --wizard --auth-choice zai-coding-global

# Coding Plan CN (China region), recommended for Coding Plan users
openclaw setup --wizard --auth-choice zai-coding-cn

# General API
openclaw setup --wizard --auth-choice zai-global

# General API CN (China region)
openclaw setup --wizard --auth-choice zai-cn
```

## Config snippet

```json5
{
  env: { ZAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "zai/glm-5" } } },
}
```

## Notes

- GLM versions and availability can change; check Z.AI's docs for the latest.
- Example model IDs include `glm-5`, `glm-4.7`, and `glm-4.6`.
- For provider details, see [/providers/zai](/providers/zai).
