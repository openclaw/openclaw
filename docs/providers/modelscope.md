---
summary: "Use ModelScope with OpenClaw"
read_when:
  - You want ModelScope models in OpenClaw
  - You need MODELSCOPE_API_KEY setup
title: "ModelScope"
---

# ModelScope Hub

ModelScope provides OpenAI-compatible APIs for hosted models. OpenClaw uses the
`modelscope` provider with an API key. Create your API key in the ModelScope console.

## Model overview

- Default model: `Qwen/Qwen3.5-27B`
- Base URL: `https://api-inference.modelscope.cn/v1`
- Authorization: `Bearer $MODELSCOPE_API_KEY`

## CLI setup

```bash
openclaw onboard --auth-choice modelscope-api-key
```

## Config snippet

```json5
{
  env: { MODELSCOPE_API_KEY: "$MODELSCOPE_API_KEY" },
  agents: {
    defaults: {
      model: { primary: "modelscope/Qwen/Qwen3.5-27B" },
    },
  },
}
```

## Notes

- Model refs are `modelscope/<provider>/<model>`.
- example: `modelscope/Qwen/Qwen3-32B`.
- The provider is injected automatically when `MODELSCOPE_API_KEY` is set (or an auth profile exists).
- See [/concepts/model-providers](/concepts/model-providers) for provider rules.
- See [ModelScope API-Inference](https://modelscope.cn/docs/model-service/API-Inference/intro) to learn more about how to get an API key.
- Note that you need to [bind your Alibaba Cloud account](https://modelscope.cn/docs/accounts/aliyun-binding-and-authorization) before use.
