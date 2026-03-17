---
summary: "将ModelScope魔搭社区和OpenClaw一起使用"
read_when:
  - 你想在 OpenClaw 中使用 ModelScope 模型
  - 你需要设置 MODELSCOPE_API_KEY
title: "ModelScope魔搭社区"
---

# 魔搭社区

ModelScope 为托管模型提供与 OpenAI 兼容的 API。OpenClaw 使用 `modelscope` 提供程序，并需要一个 API 密钥。请在 ModelScope 控制台中创建您的 API 密钥。

## 模型概览

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

- 模型引用格式为 `modelscope/<provider>/<model>`.
- 例如: `modelscope/Qwen/Qwen3-32B`.
- 当设置了 `MODELSCOPE_API_KEY`（或存在身份验证配置文件）时，会自动注入提供程序。
- 关于更多模型/提供商选项，请参阅 [/concepts/model-providers](/concepts/model-providers)。
- 有关如何获取 API 密钥的更多信息，请参阅[ModelScope API-Inference](https://modelscope.cn/docs/model-service/API-Inference/intro)。
- 请注意，使用前需要[绑定您的阿里云账号](https://modelscope.cn/docs/accounts/aliyun-binding-and-authorization)。
