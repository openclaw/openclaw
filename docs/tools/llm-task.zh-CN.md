---
summary: "用于工作流的纯 JSON LLM 任务（可选插件工具）"
read_when:
  - 你想在工作流中使用纯 JSON LLM 步骤
  - 你需要用于自动化的模式验证 LLM 输出
title: "LLM 任务"
---

# LLM 任务

`llm-task` 是一个**可选插件工具**，它运行纯 JSON LLM 任务并返回结构化输出（可选根据 JSON Schema 验证）。

这对于像 Lobster 这样的工作流引擎来说非常理想：你可以添加单个 LLM 步骤，而无需为每个工作流编写自定义 OpenClaw 代码。

## 启用插件

1. 启用插件：

```json
{
  "plugins": {
    "entries": {
      "llm-task": { "enabled": true }
    }
  }
}
```

2. 将工具添加到允许列表（它以 `optional: true` 注册）：

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

## 配置（可选）

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

`allowedModels` 是 `provider/model` 字符串的允许列表。如果设置，任何不在列表中的请求都会被拒绝。

## 工具参数

- `prompt`（字符串，必需）
- `input`（任意，可选）
- `schema`（对象，可选 JSON Schema）
- `provider`（字符串，可选）
- `model`（字符串，可选）
- `thinking`（字符串，可选）
- `authProfileId`（字符串，可选）
- `temperature`（数字，可选）
- `maxTokens`（数字，可选）
- `timeoutMs`（数字，可选）

`thinking` 接受标准的 OpenClaw 推理预设，例如 `low` 或 `medium`。

## 输出

返回包含解析后的 JSON 的 `details.json`（并在提供 `schema` 时根据其进行验证）。

## 示例：Lobster 工作流步骤

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

## 安全注意事项

- 该工具**仅支持 JSON**，并指示模型只输出 JSON（没有代码围栏，没有评论）。
- 在此运行中，模型不会暴露任何工具。
- 除非使用 `schema` 进行验证，否则请将输出视为不可信。
- 在任何有副作用的步骤（发送、发布、执行）之前添加审批。