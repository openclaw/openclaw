---
summary: "在 OpenClaw 中透過 API 金鑰或 Codex 訂閱使用 OpenAI"
read_when:
  - 您想在 OpenClaw 中使用 OpenAI 模型
  - 您想使用 Codex 訂閱驗證而非 API 金鑰
title: "OpenAI"
---

# OpenAI

OpenAI 為 GPT 模型提供開發者 API。Codex 支援以 **ChatGPT 登入**進行訂閱存取，或以 **API 金鑰**登入進行按量計費存取。Codex 雲端版需要 ChatGPT 登入。

## 選項 A：OpenAI API 金鑰 (OpenAI Platform)

**最適用於：** 直接 API 存取與按量計費。
從 OpenAI 儀表板獲取您的 API 金鑰。

### CLI 設定

```bash
openclaw onboard --auth-choice openai-api-key
# 或非互動式
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

**最適用於：** 使用 ChatGPT/Codex 訂閱存取而非 API 金鑰。
Codex 雲端版需要 ChatGPT 登入，而 Codex CLI 支援 ChatGPT 或 API 金鑰登入。

### CLI 設定 (Codex OAuth)

```bash
# 在精靈中執行 Codex OAuth
openclaw onboard --auth-choice openai-codex

# 或直接執行 OAuth
openclaw models auth login --provider openai-codex
```

### 設定程式碼片段 (Codex 訂閱)

```json5
{
  agents: { defaults: { model: { primary: "openai-codex/gpt-5.3-codex" } } },
}
```

## 注意事項

- 模型引用始終使用 `provider/model`（參見 [/concepts/models](/concepts/models)）。
- 驗證詳情與重複使用規則請參閱 [/concepts/oauth](/concepts/oauth)。
