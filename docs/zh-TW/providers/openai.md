---
summary: "透過 API 金鑰或 Codex 訂閱在 OpenClaw 中使用 OpenAI"
read_when:
  - 您想在 OpenClaw 中使用 OpenAI 模型
  - 您想要以 Codex 訂閱憑證而非 API 金鑰進行驗證
title: "OpenAI"
---

# OpenAI

OpenAI 為 GPT 模型提供開發者 API。Codex 支援以 **ChatGPT 登入** 來進行訂閱存取，或以 **API 金鑰** 登入來進行按使用量計費的存取。Codex 雲端需要以 ChatGPT 登入。

## 選項 A：OpenAI API 金鑰 (OpenAI 平台)

**最適合：** 直接 API 存取和按使用量計費。
從 OpenAI 控制面板取得您的 API 金鑰。

### CLI 設定

```bash
openclaw onboard --auth-choice openai-api-key
# or non-interactive
openclaw onboard --openai-api-key "$OPENAI_API_KEY"
```

### 設定程式碼片段

```json5
{
  env: { OPENAI_API_KEY: "sk-..." },
  agents: { defaults: { model: { primary: "openai/gpt-5.1-codex" } } },
}
```

## 選項 B：OpenAI Code (Codex) 訂閱

**最適合：** 使用 ChatGPT/Codex 訂閱存取而非 API 金鑰。Codex 雲端需要以 ChatGPT 登入，而 Codex CLI 支援以 ChatGPT 或 API 金鑰登入。

### CLI 設定 (Codex OAuth)

```bash
# Run Codex OAuth in the wizard
openclaw onboard --auth-choice openai-codex

# Or run OAuth directly
openclaw models auth login --provider openai-codex
```

### 設定程式碼片段 (Codex 訂閱)

```json5
{
  agents: { defaults: { model: { primary: "openai-codex/gpt-5.3-codex" } } },
}
```

## 注意事項

- 模型參考始終使用 `供應商/模型` (請參閱 [/concepts/models](/concepts/models))。
- 憑證詳細資訊 + 重複使用規則位於 [/concepts/oauth](/concepts/oauth)。
