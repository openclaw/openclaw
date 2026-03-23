---
read_when:
  - 你想在 OpenClaw 中使用 HPC-AI
  - 你需要 API 密钥环境变量或 CLI 身份验证选项
summary: HPC-AI 设置（身份验证 + 模型选择）
title: HPC-AI
x-i18n:
  generated_at: "2026-03-23T12:00:00Z"
  model: manual
  provider: manual
  source_hash: 43feb3ad9da1339c4d9fb3f137eefabcd549e48f1c55e64acac31c8af1d20798
  source_path: providers/hpc-ai.md
  workflow: 0
---

# HPC-AI

[HPC-AI](https://www.hpc-ai.com/doc/docs/quickstart/) 提供兼容 OpenAI 的推理 API，用于托管模型。

- 提供商：`hpc-ai`
- 身份验证：`HPC_AI_API_KEY`
- API：兼容 OpenAI（`openai-completions`）

模型 id 可以包含 `/`（例如 `minimax/minimax-m2.5`）。OpenClaw 的模型引用**只用第一个 `/`** 分割提供商与模型，因此完整引用为 `hpc-ai/minimax/minimax-m2.5`（不是内置的 `minimax` 插件）。

## 快速开始

1. 设置 API 密钥（推荐：为 Gateway 网关存储它）：

```bash
openclaw onboard --auth-choice hpc-ai-api-key
```

2. 引导后的默认模型：

```json5
{
  agents: {
    defaults: {
      model: { primary: "hpc-ai/minimax/minimax-m2.5" },
    },
  },
}
```

## 切换到 Kimi K2.5（视觉）

`moonshotai/kimi-k2.5` 在上游端点接受 OpenAI 风格多模态消息时支持**文本与图像**。

```json5
{
  agents: {
    defaults: {
      model: { primary: "hpc-ai/moonshotai/kimi-k2.5" },
    },
  },
}
```

## 非交互式示例

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice hpc-ai-api-key \
  --hpc-ai-api-key "$HPC_AI_API_KEY"
```

这会将 `hpc-ai/minimax/minimax-m2.5` 设置为默认模型。

## 环境说明

如果 Gateway 网关作为守护进程运行（launchd/systemd），请确保 `HPC_AI_API_KEY`
对该进程可用（例如在 `~/.openclaw/.env` 中，或通过 `env.shellEnv`）。

## 模型

| 模型引用                      | 上下文 | 最大 token | 说明        |
| ----------------------------- | ------ | ---------- | ----------- |
| `hpc-ai/minimax/minimax-m2.5` | 196000 | 65536      | 默认；文本  |
| `hpc-ai/moonshotai/kimi-k2.5` | 256000 | 64000      | 文本 + 图像 |

目录中的 `cost` 值为**每百万 token 的美元**，仅用于 **OpenClaw 侧的用量估算**；不会改变 HPC-AI 的账单。
