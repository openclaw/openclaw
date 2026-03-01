---
summary: "WhatsAppグループメッセージの動作と設定（mentionPatternsは全サーフェスで共有）"
read_when:
  - グループメッセージルールやメンションを変更するとき
title: "グループメッセージ"
---

# グループメッセージ（WhatsApp webチャンネル）

目的: ClawdをWhatsAppグループに参加させ、ピンされた場合のみ起動し、そのスレッドを個人DMセッションとは分離します。

注意: `agents.list[].groupChat.mentionPatterns`はTelegram/Discord/Slack/iMessageでも使用されるようになりました。このドキュメントはWhatsApp固有の動作に焦点を当てています。マルチエージェント構成では、エージェントごとに`agents.list[].groupChat.mentionPatterns`を設定してください（またはグローバルフォールバックとして`messages.groupChat.mentionPatterns`を使用します）。

## 実装済みの機能（2025-12-03）

- アクティベーションモード: `mention`（デフォルト）または`always`。`mention`はピン（WhatsAppの`mentionedJids`による実際の@メンション、正規表現パターン、またはボットのE.164がテキスト内のどこかにある場合）を必要とします。`always`はすべてのメッセージでエージェントを起動しますが、有意義な価値を追加できる場合にのみ返信し、それ以外の場合はサイレントトークン`NO_REPLY`を返します。デフォルトは設定（`channels.whatsapp.groups`）で設定でき、グループごとに`/activation`でオーバーライドできます。`channels.whatsapp.groups`が設定されている場合、グループ許可リストとしても機能します（すべて許可するには`"*"`を含めてください）。
- グループポリシー: `channels.whatsapp.groupPolicy`はグループメッセージの受信を制御します（`open|disabled|allowlist`）。`allowlist`は`channels.whatsapp.groupAllowFrom`を使用します（フォールバック: 明示的な`channels.whatsapp.allowFrom`）。デフォルトは`allowlist`です（送信者を追加するまでブロックされます）。
- グループごとのセッション: セッションキーは`agent:<agentId>:whatsapp:group:<jid>`の形式で、`/verbose on`や`/think high`（スタンドアロンメッセージとして送信）などのコマンドはそのグループにスコープされます。個人DMの状態は影響を受けません。グループスレッドではハートビートはスキップされます。
- コンテキスト注入: 実行をトリガーし**なかった**グループメッセージ（デフォルト50件）は`[Chat messages since your last reply - for context]`の下にプレフィックスされ、トリガーとなった行は`[Current message - respond to this]`の下に配置されます。既にセッション内にあるメッセージは再注入されません。
- 送信者の表示: すべてのグループバッチの末尾に`[from: Sender Name (+E164)]`が付加され、Piが誰が話しているかを認識できます。
- エフェメラル/一度だけ表示: テキスト/メンションを抽出する前にこれらをアンラップするため、内部のピンも引き続きトリガーされます。
- グループシステムプロンプト: グループセッションの最初のターン（および`/activation`がモードを変更するたび）に、短い説明文がシステムプロンプトに注入されます。例: `You are replying inside the WhatsApp group "<subject>". Group members: Alice (+44...), Bob (+43...), … Activation: trigger-only … Address the specific sender noted in the message context.` メタデータが利用できない場合でも、エージェントにグループチャットであることを通知します。

## 設定例（WhatsApp）

`~/.openclaw/openclaw.json`に`groupChat`ブロックを追加して、WhatsAppがテキスト本文で視覚的な`@`を除去した場合でも表示名ピンが機能するようにします:

```json5
{
  channels: {
    whatsapp: {
      groups: {
        "*": { requireMention: true },
      },
    },
  },
  agents: {
    list: [
      {
        id: "main",
        groupChat: {
          historyLimit: 50,
          mentionPatterns: ["@?openclaw", "\\+?15555550123"],
        },
      },
    ],
  },
}
```

注意:

- 正規表現は大文字小文字を区別しません。`@openclaw`のような表示名ピンと、`+`/スペースの有無にかかわらず生の番号をカバーします。
- WhatsAppは連絡先をタップした場合、`mentionedJids`経由で正式なメンションを送信するため、番号フォールバックはほとんど必要ありませんが、安全策として有用です。

### アクティベーションコマンド（オーナーのみ）

グループチャットコマンドを使用します:

- `/activation mention`
- `/activation always`

オーナー番号（`channels.whatsapp.allowFrom`から、または未設定の場合はボット自身のE.164）のみがこれを変更できます。グループ内でスタンドアロンメッセージとして`/status`を送信すると、現在のアクティベーションモードを確認できます。

## 使用方法

1. WhatsAppアカウント（OpenClawを実行しているもの）をグループに追加します。
2. `@openclaw …`と言う（または番号を含める）。`groupPolicy: "open"`を設定しない限り、許可リストの送信者のみがトリガーできます。
3. エージェントプロンプトには最近のグループコンテキストと末尾の`[from: …]`マーカーが含まれるため、適切な相手に対応できます。
4. セッションレベルのディレクティブ（`/verbose on`、`/think high`、`/new`または`/reset`、`/compact`）はそのグループのセッションにのみ適用されます。スタンドアロンメッセージとして送信して登録してください。個人DMセッションは独立したままです。

## テスト / 検証

- 手動スモークテスト:
  - グループで`@openclaw`ピンを送信し、送信者名を参照する返信を確認します。
  - 2回目のピンを送信し、履歴ブロックが含まれ、次のターンでクリアされることを確認します。
- Gatewayログ（`--verbose`で実行）を確認して、`inbound web message`エントリに`from: <groupJid>`と`[from: …]`サフィックスが表示されていることを確認します。

## 既知の考慮事項

- グループではノイズの多いブロードキャストを避けるため、ハートビートは意図的にスキップされます。
- エコー抑制は結合されたバッチ文字列を使用します。メンションなしで同一のテキストを2回送信した場合、最初のものだけが応答を受け取ります。
- セッションストアエントリは、セッションストア（デフォルトでは`~/.openclaw/agents/<agentId>/sessions/sessions.json`）に`agent:<agentId>:whatsapp:group:<jid>`として表示されます。エントリがないということは、そのグループがまだ実行をトリガーしていないことを意味します。
- グループでのタイピングインジケーターは`agents.defaults.typingMode`に従います（メンションされていない場合のデフォルト: `message`）。
