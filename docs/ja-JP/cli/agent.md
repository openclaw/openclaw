---
read_when:
    - スクリプトから1回のエージェントターンを実行したい場合（オプションで返信を配信）
summary: '`openclaw agent`のCLIリファレンス（Gateway ゲートウェイ経由で1回のエージェントターンを実行）'
title: agent
x-i18n:
    generated_at: "2026-04-02T07:32:06Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 2ca8b0a29c0eff64a189160ce25dc496a65827eef32670f838b86058bc3695a9
    source_path: cli/agent.md
    workflow: 15
---

# `openclaw agent`

Gateway ゲートウェイ経由でエージェントターンを実行します（組み込みモードの場合は`--local`を使用）。
`--agent <id>`を使用して、設定済みのエージェントを直接指定できます。

関連：

- エージェント送信ツール：[エージェント送信](/tools/agent-send)

## 使用例

```bash
openclaw agent --to +15555550123 --message "status update" --deliver
openclaw agent --agent ops --message "Summarize logs"
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
```

## 注意事項

- このコマンドが`models.json`の再生成をトリガーした場合、SecretRef管理のプロバイダー認証情報は、解決済みのシークレット平文ではなく、非シークレットマーカー（例：環境変数名、`secretref-env:ENV_VAR_NAME`、または`secretref-managed`）として永続化されます。
- マーカーの書き込みはソース権威です：OpenClawは解決済みのランタイムシークレット値からではなく、アクティブなソース設定スナップショットからマーカーを永続化します。
