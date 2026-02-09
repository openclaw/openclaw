---
summary: "チャンネル間で共有されるリアクションのセマンティクス"
read_when:
  - いずれかのチャンネルでリアクションに取り組む場合
title: "Reactions"
---

# tools/reactions.md

チャンネル間で共有されるリアクションのセマンティクス:

- リアクションを追加する際は `emoji` が必須です。
- `emoji=""` は、サポートされている場合にボットのリアクションを削除します。
- `remove: true` は、サポートされている場合に指定した絵文字を削除します（`emoji` が必要です）。

チャンネル別の注記:

- **Discord/Slack**: 空の `emoji` はメッセージ上のボットのすべてのリアクションを削除します。`remove: true` はその絵文字のみを削除します。
- **Google Chat**: 空の `emoji` はメッセージ上のアプリのリアクションを削除します。`remove: true` はその絵文字のみを削除します。
- **Telegram**: 空の `emoji` はボットのリアクションを削除します。`remove: true` もリアクションを削除しますが、ツールの検証のために非空の `emoji` が引き続き必要です。
- **WhatsApp**: 空の `emoji` はボットのリアクションを削除します。`remove: true` は空の絵文字にマップされます（それでも `emoji` が必要です）。
- **Signal**: `channels.signal.reactionNotifications` が有効な場合、受信したリアクション通知はシステムイベントを発行します。
