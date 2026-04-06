---
read_when:
    - ワークフロー内で JSON 専用の LLM ステップを使用したい場合
    - 自動化のためにスキーマ検証済みの LLM 出力が必要な場合
summary: ワークフロー向けの JSON 専用 LLM タスク（オプションのプラグインツール）
title: LLM Task
x-i18n:
    generated_at: "2026-04-02T07:55:56Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: cbe9b286a8e958494de06a59b6e7b750a82d492158df344c7afe30fce24f0584
    source_path: tools/llm-task.md
    workflow: 15
---

# LLM Task

`llm-task` は、JSON 専用の LLM タスクを実行し、構造化された出力を返す**オプションのプラグインツール**です（オプションで JSON Schema に対する検証も可能）。

これは Lobster のようなワークフローエンジンに最適です。ワークフローごとにカスタム OpenClaw コードを書くことなく、単一の LLM ステップを追加できます。

## プラグインの有効化

1. プラグインを有効にします：

```json
{
  "plugins": {
    "entries": {
      "llm-task": { "enabled": true }
    }
  }
}
```

2. ツールを許可リストに追加します（`optional: true` で登録されています）：

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

`allowedModels` は `provider/model` 文字列の許可リストです。設定されている場合、リスト外のリクエストは拒否されます。

## ツールパラメータ

- `prompt`（文字列、必須）
- `input`（任意の型、オプション）
- `schema`（オブジェクト、オプションの JSON Schema）
- `provider`（文字列、オプション）
- `model`（文字列、オプション）
- `thinking`（文字列、オプション）
- `authProfileId`（文字列、オプション）
- `temperature`（数値、オプション）
- `maxTokens`（数値、オプション）
- `timeoutMs`（数値、オプション）

`thinking` は `low` や `medium` などの標準的な OpenClaw 推論プリセットを受け付けます。

## 出力

パースされた JSON を含む `details.json` を返します（`schema` が指定されている場合はそれに対して検証を行います）。

## 例：Lobster ワークフローステップ

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

## 安全に関する注意事項

- このツールは **JSON 専用**であり、モデルに JSON のみを出力するよう指示します（コードフェンスやコメントは含まれません）。
- この実行ではモデルにツールは公開されません。
- `schema` で検証しない限り、出力は信頼できないものとして扱ってください。
- 副作用を伴うステップ（送信、投稿、実行）の前には承認を設けてください。
