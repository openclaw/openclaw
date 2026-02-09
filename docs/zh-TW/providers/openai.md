---
summary: "在 OpenClaw 中透過 API 金鑰或 Codex 訂閱使用 OpenAI"
read_when:
  - 您想在 OpenClaw 中使用 OpenAI 模型
  - 您想使用 Codex 訂閱驗證而非 API 金鑰
title: "OpenAI"
---

# OpenAI

OpenAI provides developer APIs for GPT models. Codex supports **ChatGPT sign-in** for subscription
access or **API key** sign-in for usage-based access. 47. Codex cloud 需要 ChatGPT 登入。

## 選項 A：OpenAI API 金鑰（OpenAI Platform）

**Best for:** direct API access and usage-based billing.
**最適合：** 直接 API 存取與按用量計費。
請從 OpenAI 控制台取得您的 API 金鑰。

### CLI 設定

```bash
openclaw onboard --auth-choice openai-api-key
# or non-interactive
openclaw onboard --openai-api-key "$OPENAI_API_KEY"
```

### 設定片段

```json5
{
  env: { OPENAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "openai/gpt-5.1-codex" } } },
}
```

## 選項 B：OpenAI Code（Codex）訂閱

**最適合：** 使用 ChatGPT／Codex 訂閱存取而非 API 金鑰。
Codex 雲端需要 ChatGPT 登入，而 Codex CLI 支援 ChatGPT 或 API 金鑰登入。
49. Codex cloud 需要 ChatGPT 登入，而 Codex CLI 支援 ChatGPT 或 API 金鑰登入。

### CLI 設定（Codex OAuth）

```bash
# Run Codex OAuth in the wizard
openclaw onboard --auth-choice openai-codex

# Or run OAuth directly
openclaw models auth login --provider openai-codex
```

### 設定片段（Codex 訂閱）

```json5
{
  agents: { defaults: { model: { primary: "openai-codex/gpt-5.3-codex" } } },
}
```

## 注意事項

- 模型參照一律使用 `provider/model`（請參閱 [/concepts/models](/concepts/models)）。
- 驗證細節與重複使用規則請見 [/concepts/oauth](/concepts/oauth)。
