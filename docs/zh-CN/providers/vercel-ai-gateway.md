---
read_when:
  - 你想将 Vercel AI Gateway 与 OpenClaw 一起使用
  - 你需要 API key 环境变量或 CLI 认证选项
summary: Vercel AI Gateway 设置（认证 + 模型选择）
title: Vercel AI Gateway
x-i18n:
  generated_at: "2026-03-16T06:27:18Z"
  model: gpt-5.4
  provider: openai
  source_hash: f30768dc3db49708b25042d317906f7ad9a2c72b0fa03263bc04f5eefbf7a507
  source_path: providers/vercel-ai-gateway.md
  workflow: 15
---

# Vercel AI Gateway

[Vercel AI Gateway](https://vercel.com/ai-gateway) 提供统一 API，可通过单个端点访问数百个模型。

- 提供商：`vercel-ai-gateway`
- 认证：`AI_GATEWAY_API_KEY`
- API：兼容 Anthropic Messages
- OpenClaw 会自动发现 Gateway 的 `/v1/models` 目录，因此 `/models vercel-ai-gateway`
  会包含当前模型引用，例如 `vercel-ai-gateway/openai/gpt-5.4`。

## 快速开始

1. 设置 API key（推荐：为 Gateway 网关持久保存它）：

```bash
openclaw onboard --auth-choice ai-gateway-api-key
```

2. 设置默认模型：

```json5
{
  agents: {
    defaults: {
      model: { primary: "vercel-ai-gateway/anthropic/claude-opus-4.6" },
    },
  },
}
```

## 非交互式示例

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice ai-gateway-api-key \
  --ai-gateway-api-key "$AI_GATEWAY_API_KEY"
```

## 环境说明

如果 Gateway 作为守护进程运行（launchd/systemd），请确保 `AI_GATEWAY_API_KEY`
对此进程可用（例如放在 `~/.openclaw/.env` 中，或通过
`env.shellEnv` 提供）。

## 模型 ID 简写

OpenClaw 接受 Vercel Claude 简写模型引用，并会在运行时将其规范化：

- `vercel-ai-gateway/claude-opus-4.6` -> `vercel-ai-gateway/anthropic/claude-opus-4.6`
- `vercel-ai-gateway/opus-4.6` -> `vercel-ai-gateway/anthropic/claude-opus-4-6`
