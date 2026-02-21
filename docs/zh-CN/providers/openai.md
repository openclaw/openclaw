---
read_when:
  - 你想在 OpenClaw 中使用 OpenAI 模型
  - 你想使用 Codex 订阅认证而非 API 密钥
summary: 在 OpenClaw 中通过 API 密钥或 Codex 订阅使用 OpenAI
title: OpenAI
x-i18n:
  generated_at: "2026-02-01T21:35:10Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: f15365d5d616258f6035b986d80fe6acd1be5836a07e5bb68236688ef2952ef7
  source_path: providers/openai.md
  workflow: 15
---

# OpenAI

OpenAI 提供 GPT 模型的开发者 API。Codex 支持**ChatGPT 登录**进行订阅访问，或**API 密钥**登录进行按量计费访问。Codex 云端需要 ChatGPT 登录。

## 方式 A：OpenAI API 密钥（OpenAI Platform）

**适用于：**直接 API 访问和按量计费。
从 OpenAI 控制台获取你的 API 密钥。

### CLI 设置

```bash
openclaw onboard --auth-choice openai-api-key
# 或非交互式
openclaw onboard --openai-api-key "$OPENAI_API_KEY"
```

### 配置片段

```json5
{
  env: { OPENAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "openai/gpt-5.2" } } },
}
```

## 方式 B：OpenAI Code（Codex）订阅

**适用于：**使用 ChatGPT/Codex 订阅访问而非 API 密钥。
Codex 云端需要 ChatGPT 登录，而 Codex CLI 支持 ChatGPT 或 API 密钥登录。

### CLI 设置

```bash
# 在向导中运行 Codex OAuth
openclaw onboard --auth-choice openai-codex

# 或直接运行 OAuth
openclaw models auth login --provider openai-codex
```

### 配置片段

```json5
{
  agents: { defaults: { model: { primary: "openai-codex/gpt-5.2" } } },
}
```

## 注意事项

- 模型引用始终使用 `provider/model` 格式（参见 [/concepts/models](/concepts/models)）。
- 认证详情和复用规则请参阅 [/concepts/oauth](/concepts/oauth)。
