---
read_when:
  - 你想在 OpenClaw 中使用 Mistral 模型
  - 你需要 Mistral API 密钥新手引导和模型引用
summary: 在 OpenClaw 中使用 Mistral 模型和 Voxtral 转录
title: Mistral
x-i18n:
  generated_at: "2026-03-16T06:25:57Z"
  model: gpt-5.4
  provider: openai
  source_hash: 4f3efe060cbaeb14e20439ade040e57d27e7d98fb9dd06e657f6a69ae808f24f
  source_path: providers/mistral.md
  workflow: 15
---

# Mistral

OpenClaw 支持 Mistral，用于文本/图像模型路由（`mistral/...`）以及
通过媒体理解中的 Voxtral 进行音频转录。
Mistral 还可用于记忆嵌入（`memorySearch.provider = "mistral"`）。

## CLI 设置

```bash
openclaw onboard --auth-choice mistral-api-key
# or non-interactive
openclaw onboard --mistral-api-key "$MISTRAL_API_KEY"
```

## 配置片段（LLM 提供商）

```json5
{
  env: { MISTRAL_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "mistral/mistral-large-latest" } } },
}
```

## 配置片段（使用 Voxtral 进行音频转录）

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        models: [{ provider: "mistral", model: "voxtral-mini-latest" }],
      },
    },
  },
}
```

## 说明

- Mistral 身份验证使用 `MISTRAL_API_KEY`。
- 提供商基础 URL 默认为 `https://api.mistral.ai/v1`。
- 新手引导默认模型为 `mistral/mistral-large-latest`。
- Mistral 的媒体理解默认音频模型为 `voxtral-mini-latest`。
- 媒体转录路径使用 `/v1/audio/transcriptions`。
- 记忆嵌入路径使用 `/v1/embeddings`（默认模型：`mistral-embed`）。
