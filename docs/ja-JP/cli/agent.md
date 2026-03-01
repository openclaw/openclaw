---
summary: "`openclaw agent` のCLIリファレンス（Gateway経由でエージェントターンを1回実行）"
read_when:
  - スクリプトからエージェントターンを1回実行したい場合（オプションで返信を配信）
title: "agent"
---

# `openclaw agent`

Gateway経由でエージェントターンを実行します（埋め込みの場合は `--local` を使用）。
`--agent <id>` を使用して、設定済みのエージェントを直接指定できます。

関連：

- エージェント送信ツール：[Agent send](/tools/agent-send)

## 使用例

```bash
openclaw agent --to +15555550123 --message "status update" --deliver
openclaw agent --agent ops --message "Summarize logs"
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
```
