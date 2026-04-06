---
read_when:
    - 任意のチャネルでリアクションを扱う場合
    - プラットフォーム間で絵文字リアクションがどのように異なるかを理解する場合
summary: サポートされるすべてのチャネルにおけるリアクションツールのセマンティクス
title: リアクション
x-i18n:
    generated_at: "2026-04-02T07:56:21Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 6e8be34e98ddf5029601dd3efe2168462f2d10b72df9e0de32a539208df3bda1
    source_path: tools/reactions.md
    workflow: 15
---

# リアクション

エージェントは `message` ツールの `react` アクションを使用して、メッセージに絵文字リアクションを追加および削除できます。リアクションの動作はチャネルによって異なります。

## 仕組み

```json
{
  "action": "react",
  "messageId": "msg-123",
  "emoji": "thumbsup"
}
```

- リアクションを追加する場合、`emoji` は必須です。
- `emoji` を空文字列（`""`）に設定すると、ボットのリアクションが削除されます。
- `remove: true` を設定すると、特定の絵文字が削除されます（空でない `emoji` が必要）。

## チャネルごとの動作

<AccordionGroup>
  <Accordion title="Discord と Slack">
    - 空の `emoji` はメッセージ上のボットのすべてのリアクションを削除します。
    - `remove: true` は指定した絵文字のみを削除します。
  </Accordion>

  <Accordion title="Google Chat">
    - 空の `emoji` はメッセージ上のアプリのリアクションを削除します。
    - `remove: true` は指定した絵文字のみを削除します。
  </Accordion>

  <Accordion title="Telegram">
    - 空の `emoji` はボットのリアクションを削除します。
    - `remove: true` もリアクションを削除しますが、ツールバリデーションのために空でない `emoji` が必要です。
  </Accordion>

  <Accordion title="WhatsApp">
    - 空の `emoji` はボットのリアクションを削除します。
    - `remove: true` は内部的に空の絵文字にマッピングされます（ツール呼び出しでは `emoji` が必要です）。
  </Accordion>

  <Accordion title="Zalo Personal (zalouser)">
    - 空でない `emoji` が必要です。
    - `remove: true` はその特定の絵文字リアクションを削除します。
  </Accordion>

  <Accordion title="Signal">
    - インバウンドのリアクション通知は `channels.signal.reactionNotifications` で制御されます：`"off"` は通知を無効にし、`"own"`（デフォルト）はユーザーがボットのメッセージにリアクションした際にイベントを発行し、`"all"` はすべてのリアクションに対してイベントを発行します。
  </Accordion>
</AccordionGroup>

## リアクションレベル

チャネルごとの `reactionLevel` 設定は、エージェントがリアクションを使用する範囲を制御します。値は通常 `off`、`ack`、`minimal`、または `extensive` です。

- [Telegram の reactionLevel](/channels/telegram#reaction-notifications) — `channels.telegram.reactionLevel`
- [WhatsApp の reactionLevel](/channels/whatsapp#reactions) — `channels.whatsapp.reactionLevel`

各プラットフォームでエージェントがメッセージにどの程度積極的にリアクションするかを調整するには、個々のチャネルで `reactionLevel` を設定してください。

## 関連情報

- [エージェント送信](/tools/agent-send) — `react` を含む `message` ツール
- [チャネル](/channels) — チャネル固有の設定
