---
summary: JSON-only LLM tasks for workflows (optional plugin tool)
read_when:
  - You want a JSON-only LLM step inside workflows
  - You need schema-validated LLM output for automation
title: LLM Task
---

# LLM 任務

`llm-task` 是一個**可選的外掛工具**，用於執行僅限 JSON 的大型語言模型任務，並回傳結構化輸出（可選擇依據 JSON Schema 進行驗證）。

這非常適合像 Lobster 這樣的工作流程引擎：你可以新增單一的 LLM 步驟，而無需為每個工作流程撰寫自訂的 OpenClaw 程式碼。

## 啟用外掛程式

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

2. 將該工具加入允許清單（它已在 `optional: true` 註冊）：

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

## 設定（可選）

```json
{
  "plugins": {
    "entries": {
      "llm-task": {
        "enabled": true,
        "config": {
          "defaultProvider": "openai-codex",
          "defaultModel": "gpt-5.4",
          "defaultAuthProfileId": "main",
          "allowedModels": ["openai-codex/gpt-5.4"],
          "maxTokens": 800,
          "timeoutMs": 30000
        }
      }
    }
  }
}
```

`allowedModels` 是一個允許清單，包含 `provider/model` 字串。如果設定，任何不在清單內的請求都會被拒絕。

## 工具參數

- `prompt` (字串，必填)
- `input` (任意類型，選填)
- `schema` (物件，選填 JSON Schema)
- `provider` (字串，選填)
- `model` (字串，選填)
- `thinking` (字串，選填)
- `authProfileId` (字串，選填)
- `temperature` (數字，選填)
- `maxTokens` (數字，選填)
- `timeoutMs` (數字，選填)

`thinking` 支援標準的 OpenClaw 推理預設值，例如 `low` 或 `medium`。

## 輸出

回傳 `details.json`，其中包含解析後的 JSON（並在提供 `schema` 時進行驗證）。

## 範例：Lobster 工作流程步驟

```lobster
openclaw.invoke --tool llm-task --action json --args-json '{
  "prompt": "Given the input email, return intent and draft.",
  "thinking": "low",
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

- 此工具僅支援 **JSON**，並指示模型僅輸出 JSON（不包含程式碼區塊、無評論）。
- 本次執行未向模型開放任何工具。
- 除非使用 `schema` 驗證，否則請將輸出視為不可信。
- 在任何會產生副作用的步驟（send、post、exec）之前，必須先取得批准。
