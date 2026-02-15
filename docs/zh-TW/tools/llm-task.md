---
summary: "用於工作流程的純 JSON LLM 任務（可選插件工具）"
read_when:
  - 您希望在工作流程中擁有純 JSON 的 LLM 步驟
  - 您需要經過結構描述驗證的 LLM 輸出以實現自動化
title: "LLM 任務"
---

# LLM 任務

`llm-task` 是一個**可選插件工具**，它執行一個純 JSON 的 LLM 任務並返回結構化輸出（可選地根據 JSON Schema 進行驗證）。

這對於 Lobster 這類工作流程引擎非常理想：您可以新增單一 LLM 步驟，而無需為每個工作流程編寫客製化的 OpenClaw 程式碼。

## 啟用插件

1.  啟用插件：

```json
{
  "plugins": {
    "entries": {
      "llm-task": { "enabled": true }
    }
  }
}
```

2.  將工具加入允許清單（它以 `optional: true` 註冊）：

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

## 設定 (可選)

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

`allowedModels` 是一個 `provider/model` 字串的允許清單。如果已設定，則清單之外的任何請求都將被拒絕。

## 工具參數

-   `prompt` (字串，必填)
-   `input` (任意類型，可選)
-   `schema` (物件，可選 JSON Schema)
-   `provider` (字串，可選)
-   `model` (字串，可選)
-   `authProfileId` (字串，可選)
-   `temperature` (數字，可選)
-   `maxTokens` (數字，可選)
-   `timeoutMs` (數字，可選)

## 輸出

返回包含已解析 JSON 的 `details.json` (並在提供 `schema` 時進行驗證)。

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

## 安全注意事項

-   該工具是**純 JSON**，並指示模型僅輸出 JSON (無程式碼區塊，無註解)。
-   在此執行中，沒有任何工具暴露給模型。
-   在您使用 `schema` 進行驗證之前，請將輸出視為不可信。
-   在任何具有副作用的步驟（傳送、發布、執行）之前加上批准。
