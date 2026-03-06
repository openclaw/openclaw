---
summary: "Gateway経由でエージェントターンを1回実行する `openclaw agent` のCLIリファレンス"
read_when:
  - スクリプトからエージェントターンを1回実行したい場合（返信の配信もオプション）
title: "agent"
---

# `openclaw agent`

Gateway経由でエージェントターンを実行します（`--local` で組み込みモード）。
`--agent <id>` で設定済みのエージェントを直接指定できます。

関連:

- エージェント送信ツール: [Agent send](/tools/agent-send)

## 使用例

```bash
openclaw agent --to +15555550123 --message "status update" --deliver
openclaw agent --agent ops --message "Summarize logs"
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium
openclaw agent --agent ops --message "Generate report" --deliver --reply-channel slack --reply-to "#reports"
```
