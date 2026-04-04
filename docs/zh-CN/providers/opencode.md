---
read_when:
  - 你想使用 OpenCode 托管的模型访问
  - 你想在 Zen 和 Go 目录之间进行选择
summary: 在 OpenClaw 中使用 OpenCode Zen 和 Go 目录
title: OpenCode
x-i18n:
  generated_at: "2026-03-16T06:26:52Z"
  model: gpt-5.4
  provider: openai
  source_hash: 9ffe65d152d1835163f9f5ae4cc966e29bd01a9dbb88187c24d149c960c8225d
  source_path: providers/opencode.md
  workflow: 15
---

# OpenCode

OpenCode 在 OpenClaw 中提供两个托管目录：

- `opencode/...` 用于 **Zen** 目录
- `opencode-go/...` 用于 **Go** 目录

两个目录都使用相同的 OpenCode API 密钥。OpenClaw 会将运行时提供商 ID
保持拆分，以便上游按模型路由保持正确，但新手引导和文档将它们视为
同一个 OpenCode 设置。

## CLI 设置

### Zen 目录

```bash
openclaw onboard --auth-choice opencode-zen
openclaw onboard --opencode-zen-api-key "$OPENCODE_API_KEY"
```

### Go 目录

```bash
openclaw onboard --auth-choice opencode-go
openclaw onboard --opencode-go-api-key "$OPENCODE_API_KEY"
```

## 配置片段

```json5
{
  env: { OPENCODE_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "opencode/claude-opus-4-6" } } },
}
```

## 目录

### Zen

- 运行时提供商：`opencode`
- 示例模型：`opencode/claude-opus-4-6`、`opencode/gpt-5.2`、`opencode/gemini-3-pro`
- 适合你想使用精选的 OpenCode 多模型代理时

### Go

- 运行时提供商：`opencode-go`
- 示例模型：`opencode-go/kimi-k2.5`、`opencode-go/glm-5`、`opencode-go/minimax-m2.5`
- 适合你想使用 OpenCode 托管的 Kimi/GLM/MiniMax 产品线时

## 说明

- 也支持 `OPENCODE_ZEN_API_KEY`。
- 在设置期间输入一个 OpenCode 密钥，会为两个运行时提供商都存储凭证。
- 你需要登录 OpenCode、添加计费信息，然后复制你的 API 密钥。
- 计费和目录可用性由 OpenCode 仪表板管理。
