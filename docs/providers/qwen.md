---
summary: "Use Qwen models via Alibaba Cloud Model Studio"
read_when:
  - You want to use Qwen with OpenClaw
  - You previously used Qwen OAuth
title: "Qwen"
---

# Qwen

<Warning>

**Qwen OAuth has been removed.** The free-tier OAuth integration
(`qwen-portal`) that used `portal.qwen.ai` endpoints is no longer available.
See [Issue #49557](https://github.com/openclaw/openclaw/issues/49557) for
background.

</Warning>

## Recommended: Model Studio (Alibaba Cloud Coding Plan)

Use [Model Studio](/providers/qwen_modelstudio) for officially supported access to
Qwen models (Qwen 3.5 Plus, GLM-4.7, Kimi K2.5, and more).

```bash
# Global endpoint
openclaw onboard --auth-choice modelstudio-api-key

# China endpoint
openclaw onboard --auth-choice modelstudio-api-key-cn
```

See [Model Studio](/providers/qwen_modelstudio) for full setup details.
