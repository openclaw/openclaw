---
read_when:
  - 你想使用 OpenCode Go 目录
  - 你需要了解 Go 托管模型的运行时模型引用
summary: 使用共享的 OpenCode 设置来使用 OpenCode Go 目录
title: OpenCode Go
x-i18n:
  generated_at: "2026-03-16T06:26:48Z"
  model: gpt-5.4
  provider: openai
  source_hash: 8650af7c64220c14bab8c22472fff8bebd7abde253e972b6a11784ad833d321c
  source_path: providers/opencode-go.md
  workflow: 15
---

# OpenCode Go

OpenCode Go 是 [OpenCode](/providers/opencode) 中的 Go 目录。
它使用与 Zen 目录相同的 `OPENCODE_API_KEY`，但保留运行时
提供商 id `opencode-go`，以便上游按模型路由保持正确。

## 支持的模型

- `opencode-go/kimi-k2.5`
- `opencode-go/glm-5`
- `opencode-go/minimax-m2.5`

## CLI 设置

```bash
openclaw onboard --auth-choice opencode-go
# 或非交互式
openclaw onboard --opencode-go-api-key "$OPENCODE_API_KEY"
```

## 配置片段

```json5
{
  env: { OPENCODE_API_KEY: "YOUR_API_KEY_HERE" }, // pragma: allowlist secret
  agents: { defaults: { model: { primary: "opencode-go/kimi-k2.5" } } },
}
```

## 路由行为

当模型引用使用 `opencode-go/...` 时，OpenClaw 会自动处理按模型路由。

## 说明

- 共享的新手引导和目录概览请使用 [OpenCode](/providers/opencode)。
- 运行时引用保持显式：Zen 使用 `opencode/...`，Go 使用 `opencode-go/...`。
