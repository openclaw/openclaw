---
summary: "ワークフロー向けの JSON のみの LLM タスク（オプションのプラグインツール）"
read_when:
  - ワークフロー内に JSON のみの LLM ステップが必要な場合
  - オートメーション向けにスキーマ検証済みの LLM 出力が必要な場合
title: "LLM Task"
---

# LLM Task

`llm-task` は JSON のみの LLM タスクを実行し、構造化された出力を返す**オプションのプラグインツール**です
（オプションで JSON Schema に対する検証も可能）。

これは Lobster のようなワークフローエンジンに最適です。各ワークフロー向けにカスタムの OpenClaw コードを
書かずに、単一の LLM ステップを追加できます。

## プラグインの有効化

1. プラグインを有効化します:

```json
{
  "plugins": {
    "entries": {
      "llm-task": { "enabled": true }
    }
  }
}
```

2. ツールをアローリストに追加します（`optional: true` で登録されています）:

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

## 設定（オプション）

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

`allowedModels` は `provider/model` 文字列のアローリストです。設定された場合、リスト外のリクエストは拒否されます。

## ツールパラメーター

- `prompt`（文字列、必須）
- `input`（任意、オプション）
- `schema`（オブジェクト、オプションの JSON Schema）
- `provider`（文字列、オプション）
- `model`（文字列、オプション）
- `authProfileId`（文字列、オプション）
- `temperature`（数値、オプション）
- `maxTokens`（数値、オプション）
- `timeoutMs`（数値、オプション）

## 出力

解析された JSON を含む `details.json` を返します（`schema` が提供された場合はそれに対して検証されます）。

## 例: Lobster ワークフローステップ

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

## 安全性に関する注意事項

- このツールは **JSON のみ**であり、モデルに JSON のみを出力するよう指示します（コードフェンスやコメントは不可）。
- この実行ではモデルにツールは公開されません。
- `schema` で検証しない限り、出力は信頼されないものとして扱ってください。
- 副作用のあるステップ（send、post、exec）の前に承認を置いてください。
