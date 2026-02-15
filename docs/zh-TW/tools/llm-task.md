---
summary: "適用於工作流的純 JSON LLM 任務（選用外掛工具）"
read_when:
  - 您希望在工作流中加入純 JSON 的 LLM 步驟
  - 您需要針對自動化進行 Schema 驗證的 LLM 輸出
title: "LLM Task"
---

# LLM Task

`llm-task` 是一個 **選用外掛工具**，用於執行純 JSON 的 LLM 任務並傳回結構化輸出（可選擇性地針對 JSON Schema 進行驗證）。

這非常適合像 Lobster 這樣的工作流引擎：您可以加入單個 LLM 步驟，而無需為每個工作流撰寫自定義的 OpenClaw 程式碼。

## 啟用外掛

1. 啟用外掛：

```json
{
  "plugins": {
    "entries": {
      "llm-task": { "enabled": true }
    }
  }
}
```

2. 將工具加入白名單（它被註冊為 `optional: true`）：

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "tools": { "allow": ["llm-task"] }
      }
    ]
  }
}
```

## 設定（選用）

```json
{
  "plugins": {
    "entries": {
      "llm-task": {
        "enabled": true,
        "config": {
          "defaultProvider": "openai-codex",
          "defaultModel": "gpt-5.2",
          "defaultAuthProfileId": "main",
          "allowedModels": ["openai-codex/gpt-5.3-codex"],
          "maxTokens": 800,
          "timeoutMs": 30000
        }
      }
    }
  }
}
```

`allowedModels` 是 `provider/model` 字串的白名單。如果設定了此項，任何不在清單中的請求都將被拒絕。

## 工具參數

- `prompt` (字串，必填)
- `input` (任何類型，選填)
- `schema` (物件，選填 JSON Schema)
- `provider` (字串，選填)
- `model` (字串，選填)
- `authProfileId` (字串，選填)
- `temperature` (數字，選填)
- `maxTokens` (數字，選填)
- `timeoutMs` (數字，選填)

## 輸出

傳回包含已解析 JSON 的 `details.json`（並在提供 `schema` 時進行驗證）。

## 範例：Lobster 工作流步驟

```lobster
openclaw.invoke --tool llm-task --action json --args-json '{
  "prompt": "Given the input email, return intent and draft.",
  "input": {
    "subject": "Hello",
    "body": "Can you help?"
  },
  "schema": {
    "type": "object",
    "properties": {
      "intent": { "type": "string" },
      "draft": { "type": "string" }
    },
    "required": ["intent", "draft"],
    "additionalProperties": false
  }
}'
```

## 安全注意事項

- 此工具是 **純 JSON** 的，並指示模型僅輸出 JSON（無程式碼區塊符號，無註解）。
- 在此次執行中，不會向模型公開任何工具。
- 除非您使用 `schema` 進行驗證，否則請將輸出視為不可信。
- 在任何會產生副作用的步驟（send、post、exec）之前加入審核機制。
