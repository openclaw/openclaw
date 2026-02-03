---
read_when:
  - 你需要在工作流中添加纯 JSON 的 LLM 步骤
  - 你需要经过 Schema 验证的 LLM 输出用于自动化
summary: 用于工作流的纯 JSON LLM 任务（可选插件工具）
title: LLM 任务
x-i18n:
  generated_at: "2026-02-01T21:42:34Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: d81b74fcfd5491a9edb4bfadb47d404067020990b1f6d6d8fed652fbc860f646
  source_path: tools/llm-task.md
  workflow: 15
---

# LLM 任务

`llm-task` 是一个**可选插件工具**，用于运行纯 JSON 的 LLM 任务并返回结构化输出（可选择根据 JSON Schema 进行验证）。

这非常适合像 Lobster 这样的工作流引擎：你可以添加单个 LLM 步骤，而无需为每个工作流编写自定义 OpenClaw 代码。

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

2. 将工具加入允许列表（它以 `optional: true` 注册）：

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
          "defaultModel": "gpt-5.2",
          "defaultAuthProfileId": "main",
          "allowedModels": ["openai-codex/gpt-5.2"],
          "maxTokens": 800,
          "timeoutMs": 30000
        }
      }
    }
  }
}
```

`allowedModels` 是 `provider/model` 字符串的允许列表。如果设置了该项，任何不在列表中的请求都会被拒绝。

## 工具参数

- `prompt`（字符串，必填）
- `input`（任意类型，可选）
- `schema`（对象，可选 JSON Schema）
- `provider`（字符串，可选）
- `model`（字符串，可选）
- `authProfileId`（字符串，可选）
- `temperature`（数字，可选）
- `maxTokens`（数字，可选）
- `timeoutMs`（数字，可选）

## 输出

返回 `details.json`，包含解析后的 JSON（如果提供了 `schema`，则会进行验证）。

## 示例：Lobster 工作流步骤

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

## 安全注意事项

- 该工具为**纯 JSON 模式**，指示模型仅输出 JSON（无代码围栏、无注释说明）。
- 此次运行不会向模型暴露任何工具。
- 除非使用 `schema` 进行验证，否则应将输出视为不可信。
- 在任何有副作用的步骤（发送、发布、执行）之前设置审批流程。
