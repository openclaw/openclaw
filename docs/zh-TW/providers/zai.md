---
summary: "使用 OpenClaw 搭配 Z.AI（GLM 模型）"
read_when:
  - 您想在 OpenClaw 中使用 Z.AI / GLM 模型
  - 您需要簡單的 ZAI_API_KEY 設定
title: "Z.AI"
---

# Z.AI

Z.AI 是 **GLM** 模型的 API 平台。它為 GLM 提供 REST API，並使用 API 金鑰進行身分驗證。請在 Z.AI 主控台中建立您的 API 金鑰。OpenClaw 使用 `zai` 提供者搭配 Z.AI API 金鑰。 It provides REST APIs for GLM and uses API keys
for authentication. Create your API key in the Z.AI console. OpenClaw uses the `zai` provider
with a Z.AI API key.

## CLI setup

```bash
openclaw onboard --auth-choice zai-api-key
# or non-interactive
openclaw onboard --zai-api-key "$ZAI_API_KEY"
```

## Config snippet

```json5
{
  env: { ZAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "zai/glm-4.7" } } },
}
```

## Notes

- GLM 模型可作為 `zai/<model>` 使用（範例：`zai/glm-4.7`）。
- 請參閱 [/providers/glm](/providers/glm) 以取得模型家族的概覽。
- Z.AI 使用 Bearer 驗證並搭配您的 API 金鑰。
