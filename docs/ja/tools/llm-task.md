---
summary: "ワークフロー向けの JSON のみの LLM タスク（オプションのプラグインツール）"
read_when:
  - ワークフロー内に JSON のみの LLM ステップが必要な場合
  - 自動化のためにスキーマ検証された LLM 出力が必要な場合
title: "LLM タスク"
---

# LLM タスク

`llm-task` は、JSON のみの LLM タスクを実行し、
構造化された出力（オプションで JSON Schema による検証）を返す **オプションのプラグインツール** です。

Lobster のようなワークフローエンジンに最適で、各ワークフローごとにカスタムの OpenClaw コードを書かずに、単一の LLM ステップを追加できます。

## プラグインを有効化する

1. プラグインを有効化します。

```json
{
  "plugins": {
    "entries": {
      "llm-task": { "enabled": true }
    }
  }
}
```

2. ツールを許可リストに追加します（`optional: true` で登録されています）。

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

## 設定（任意）

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

`allowedModels` は、`provider/model` 文字列の許可リストです。設定されている場合、リスト外のリクエストは拒否されます。 設定されている場合、リスト外のリクエスト
は拒否されます。

## ツールのパラメータ

- `prompt`（string、必須）
- `input`（any、任意）
- `schema`（object、任意の JSON Schema）
- `provider`（string、任意）
- `model`（string、任意）
- `authProfileId`（string、任意）
- `temperature`（number、任意）
- `maxTokens`（number、任意）
- `timeoutMs`（number、任意）

## 出力

解析された JSON を含む `details.json` を返します（指定されている場合は `schema` に対して検証されます）。

## 例：Lobster のワークフローステップ

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

## 安全性に関する注意

- 本ツールは **JSON のみ** であり、モデルに対して JSON のみを出力するよう指示します（コードフェンスや解説は出力しません）。
- この実行では、モデルに対してツールは公開されません。
- `schema` による検証を行わない限り、出力は信頼できないものとして扱ってください。
- 副作用のあるステップ（送信、投稿、実行）の前には承認を配置してください。
