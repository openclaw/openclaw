---
read_when:
  - 你想要将 Vercel AI Gateway 与 OpenClaw 配合使用
  - 你需要 API 密钥环境变量或 CLI 认证选项
summary: Vercel AI Gateway 设置（认证 + 模型选择）
title: Vercel AI Gateway
x-i18n:
  generated_at: "2026-02-01T21:36:13Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: c6482f047a31b09c7a691d40babbd1f9fb3aa2042b61cc42956ad9b791da8285
  source_path: providers/vercel-ai-gateway.md
  workflow: 15
---

# Vercel AI Gateway

[Vercel AI Gateway](https://vercel.com/ai-gateway) 提供统一的 API，通过单一端点访问数百个模型。

- 提供商：`vercel-ai-gateway`
- 认证：`AI_GATEWAY_API_KEY`
- API：兼容 Anthropic Messages

## 快速开始

1. 设置 API 密钥（推荐：为 Gateway网关存储密钥）：

```bash
openclaw onboard --auth-choice ai-gateway-api-key
```

2. 设置默认模型：

```json5
{
  agents: {
    defaults: {
      model: { primary: "vercel-ai-gateway/anthropic/claude-opus-4.5" },
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

如果 Gateway网关以守护进程（launchd/systemd）方式运行，请确保 `AI_GATEWAY_API_KEY`
对该进程可用（例如，在 `~/.openclaw/.env` 中或通过
`env.shellEnv` 设置）。
