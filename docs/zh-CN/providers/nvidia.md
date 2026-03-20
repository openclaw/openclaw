---
read_when:
  - 你想在 OpenClaw 中使用 NVIDIA 模型
  - 你需要设置 `NVIDIA_API_KEY`
summary: 在 OpenClaw 中使用 NVIDIA 的 OpenAI 兼容 API
title: NVIDIA
x-i18n:
  generated_at: "2026-03-16T06:26:11Z"
  model: gpt-5.4
  provider: openai
  source_hash: 81e7a1b6cd6821b68db9c71b864d36023b1ccfad1641bf88e2bc2957782edf8b
  source_path: providers/nvidia.md
  workflow: 15
---

# NVIDIA

NVIDIA 在 `https://integrate.api.nvidia.com/v1` 提供一个与 OpenAI 兼容的 API，用于 Nemotron 和 NeMo 模型。请使用来自 [NVIDIA NGC](https://catalog.ngc.nvidia.com/) 的 API key 进行认证。

## CLI 设置

先导出 key，然后运行新手引导并设置一个 NVIDIA 模型：

```bash
export NVIDIA_API_KEY="nvapi-..."
openclaw onboard --auth-choice skip
openclaw models set nvidia/nvidia/llama-3.1-nemotron-70b-instruct
```

如果你仍然使用 `--token`，请记住它会出现在 shell 历史记录和 `ps` 输出中；如果可能，优先使用环境变量。

## 配置片段

```json5
{
  env: { NVIDIA_API_KEY: "nvapi-..." },
  models: {
    providers: {
      nvidia: {
        baseUrl: "https://integrate.api.nvidia.com/v1",
        api: "openai-completions",
      },
    },
  },
  agents: {
    defaults: {
      model: { primary: "nvidia/nvidia/llama-3.1-nemotron-70b-instruct" },
    },
  },
}
```

## 模型 ID

- `nvidia/llama-3.1-nemotron-70b-instruct`（默认）
- `meta/llama-3.3-70b-instruct`
- `nvidia/mistral-nemo-minitron-8b-8k-instruct`

## 说明

- 使用与 OpenAI 兼容的 `/v1` 端点；请使用来自 NVIDIA NGC 的 API key。
- 当设置了 `NVIDIA_API_KEY` 时，提供商会自动启用；使用静态默认值（131,072-token 上下文窗口，4,096 最大 tokens）。
