---
summary: Use Kilo Gateway's unified API to access many models in OpenClaw
read_when:
  - You want a single API key for many LLMs
  - You want to run models via Kilo Gateway in OpenClaw
---

# Kilo Gateway

Kilo Gateway 提供一個 **統一的 API**，能將請求路由到多個模型，並透過單一端點和 API 金鑰存取。它與 OpenAI 相容，因此大多數 OpenAI SDK 只需切換基底 URL 即可使用。

## 取得 API 金鑰

1. 前往 [app.kilo.ai](https://app.kilo.ai)
2. 登入或註冊帳號
3. 進入 API 金鑰頁面並產生新的金鑰

## CLI 設定

```bash
openclaw onboard --kilocode-api-key <key>
```

或設定環境變數：

```bash
export KILOCODE_API_KEY="<your-kilocode-api-key>" # pragma: allowlist secret
```

## 設定範例

```json5
{
  env: { KILOCODE_API_KEY: "<your-kilocode-api-key>" }, // pragma: allowlist secret
  agents: {
    defaults: {
      model: { primary: "kilocode/kilo/auto" },
    },
  },
}
```

## 預設模型

預設模型為 `kilocode/kilo/auto`，這是一個智慧路由模型，會根據任務自動選擇最佳的底層模型：

- 規劃、除錯與協調任務會路由到 Claude Opus
- 程式碼撰寫與探索任務會路由到 Claude Sonnet

## 可用模型

OpenClaw 會在啟動時動態發現 Kilo Gateway 上可用的模型。使用 `/models kilocode` 可查看您帳號可用的完整模型清單。

任何在閘道器上可用的模型都可以使用 `kilocode/` 前綴：

```
kilocode/kilo/auto              (default - smart routing)
kilocode/anthropic/claude-sonnet-4
kilocode/openai/gpt-5.2
kilocode/google/gemini-3-pro-preview
...and many more
```

## 注意事項

- 模型參考為 `kilocode/<model-id>`（例如，`kilocode/anthropic/claude-sonnet-4`）。
- 預設模型：`kilocode/kilo/auto`
- 基本 URL：`https://api.kilo.ai/api/gateway/`
- 更多模型/提供者選項，請參考 [/concepts/model-providers](/concepts/model-providers)。
- Kilo Gateway 在底層使用帶有您的 API 金鑰的 Bearer token。
