---
title: "設定リファレンス"
summary: "ゲートウェイ設定のリファレンス"
---

# 設定リファレンス

## Agent Defaults

### `agents.defaults.systemPromptSuffix`

毎回の会話ターンでシステムプロンプトに追加されるテキストです。会話履歴ではなく設定から注入されるため、**コンパクション後も保持されます** — 長いセッション中に決して失われてはならない永続的な動作ルール、制約、またはアイデンティティに最適です。

サフィックスは既存の `extraSystemPrompt`（チャンネル設定やサブエージェントコンテキストなど）の*後に*追加されるため、他のシステムプロンプトソースを置き換えることはありません。

> **Note:** For CLI providers, the suffix behavior depends on the backend: `claude-cli` receives the suffix on the first turn only (session state is maintained internally). `codex-cli` does not support system prompt injection and will not receive the suffix. Embedded providers (the default, used by ~99% of configurations) receive the suffix on every turn.

```json5
{
  agents: {
    defaults: {
      systemPromptSuffix: "常に日本語で回答してください。明示的な承認なしに公開リポジトリにコミットしないでください。",
    },
  },
}
```
