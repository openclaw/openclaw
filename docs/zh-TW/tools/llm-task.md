---
summary: "用於工作流程的僅 JSON LLM 任務（可選外掛工具）"
read_when:
  - 你想在工作流程中加入僅 JSON 的 LLM 步驟
  - 你需要可進行結構描述驗證的 LLM 輸出以利自動化
title: "LLM 任務"
---

# LLM 任務

`llm-task` 是一個 **可選的外掛工具**，可執行僅 JSON 的 LLM 任務，並回傳結構化輸出（可選擇依 JSON Schema 驗證）。

這非常適合像 Lobster 這類的工作流程引擎：你可以加入單一的 LLM 步驟，而不必為每個工作流程撰寫自訂的 OpenClaw 程式碼。

## Enable the plugin

1. Enable the plugin:

```json
{
  "plugins": {
    "entries": {
      "llm-task": { "enabled": true }
    }
  }
}
```

2. 將工具加入允許清單（它已註冊為 `optional: true`）：

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

`allowedModels` is an allowlist of `provider/model` strings. If set, any request
outside the list is rejected.

## 工具參數

- `prompt`（string，必填）
- `input`（any，選填）
- `schema`（object，選填的 JSON Schema）
- `provider`（string，選填）
- `model`（string，選填）
- `authProfileId`（string，選填）
- `temperature`（number，選填）
- `maxTokens`（number，選填）
- `timeoutMs`（number，選填）

## Output

回傳 `details.json`，其中包含已解析的 JSON（若提供 `schema`，則會進行驗證）。

## 範例：Lobster 工作流程步驟

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

## 安全性注意事項

- 此工具為 **僅 JSON**，並指示模型只輸出 JSON（不含程式碼圍欄、不含說明文字）。
- 本次執行不會向模型暴露任何工具。
- 除非你使用 `schema` 進行驗證，否則請將輸出視為不可信。
- Put approvals before any side-effecting step (send, post, exec).
