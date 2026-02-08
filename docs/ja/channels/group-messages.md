---
summary: "WhatsApp のグループメッセージ処理における挙動と設定（mentionPatterns は各サーフェスで共有されます）"
read_when:
  - グループメッセージのルールやメンションを変更する場合
title: "グループメッセージ"
x-i18n:
  source_path: channels/group-messages.md
  source_hash: 181a72f12f5021af
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:20:56Z
---

# グループメッセージ（WhatsApp Web チャンネル）

目的：Clawd を WhatsApp のグループに参加させ、ピンされたときのみ起動し、そのスレッドを個人のダイレクトメッセージ（DM）セッションとは分離して保持することです。

注記：`agents.list[].groupChat.mentionPatterns` は現在 Telegram / Discord / Slack / iMessage でも使用されています。本ドキュメントは WhatsApp 固有の挙動に焦点を当てています。マルチエージェント構成では、エージェントごとに `agents.list[].groupChat.mentionPatterns` を設定してください（または `messages.groupChat.mentionPatterns` をグローバルなフォールバックとして使用します）。

## 実装済み内容（2025-12-03）

- 起動モード：`mention`（デフォルト）または `always`。`mention` ではピンが必須です（実際の WhatsApp の @ メンションは `mentionedJids` 経由、正規表現パターン、またはテキスト内の任意の位置にあるボットの E.164）。`always` はすべてのメッセージでエージェントを起動しますが、有意義な価値を追加できる場合のみ返信し、それ以外の場合はサイレントトークン `NO_REPLY` を返します。デフォルトは設定（`channels.whatsapp.groups`）で指定でき、グループごとに `/activation` で上書きできます。`channels.whatsapp.groups` を設定すると、グループの許可リストとしても機能します（すべてを許可するには `"*"` を含めてください）。
- グループポリシー：`channels.whatsapp.groupPolicy` は、グループメッセージを受け付けるかどうか（`open|disabled|allowlist`）を制御します。`allowlist` は `channels.whatsapp.groupAllowFrom` を使用します（フォールバック：明示的な `channels.whatsapp.allowFrom`）。デフォルトは `allowlist`（送信者を追加するまでブロック）です。
- グループ単位のセッション：セッションキーは `agent:<agentId>:whatsapp:group:<jid>` のようになります。そのため、`/verbose on` や `/think high`（単独メッセージとして送信）などのコマンドは、そのグループにスコープされます。個人 DM の状態には影響しません。グループスレッドではハートビートはスキップされます。
- コンテキスト注入：実行をトリガーしなかった **未処理のみ** のグループメッセージ（デフォルト 50 件）が、`[Chat messages since your last reply - for context]` の下にプレフィックス付きで挿入され、トリガーとなった行は `[Current message - respond to this]` の下に配置されます。すでにセッションに含まれているメッセージは再注入されません。
- 送信者の明示：各グループバッチの末尾に `[from: Sender Name (+E164)]` が付与され、Pi が発話者を認識できるようになっています。
- 一時表示／一度きり表示：テキストやメンションを抽出する前にこれらを展開するため、その内部にあるピンも正しくトリガーされます。
- グループ用システムプロンプト：グループセッションの最初のターン（および `/activation` によりモードが変更されたとき）に、`You are replying inside the WhatsApp group "<subject>". Group members: Alice (+44...), Bob (+43...), … Activation: trigger-only … Address the specific sender noted in the message context.` のような短い説明文をシステムプロンプトに注入します。メタデータが利用できない場合でも、エージェントにはグループチャットであることを伝えます。

## 設定例（WhatsApp）

WhatsApp がテキスト本文から視覚的な `@` を削除する場合でも表示名によるピンが機能するように、`~/.openclaw/openclaw.json` に `groupChat` ブロックを追加してください。

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

注記：

- 正規表現は大文字・小文字を区別しません。`@openclaw` のような表示名ピンと、`+` やスペースの有無にかかわらない生の番号の両方をカバーします。
- WhatsApp では、連絡先をタップした場合に `mentionedJids` 経由で正規のメンションが送信されます。そのため番号フォールバックが必要になることは稀ですが、有用なセーフティネットです。

### 起動コマンド（オーナー専用）

グループチャットコマンドを使用します：

- `/activation mention`
- `/activation always`

これを変更できるのは、オーナー番号（`channels.whatsapp.allowFrom`、未設定の場合はボット自身の E.164）のみです。現在の起動モードを確認するには、グループで `/status` を単独メッセージとして送信してください。

## 使い方

1. WhatsApp アカウント（OpenClaw を実行しているもの）をグループに追加します。
2. `@openclaw …` と発言します（または番号を含めます）。`groupPolicy: "open"` を設定していない限り、許可リストに含まれる送信者のみがトリガーできます。
3. エージェントのプロンプトには、最近のグループコンテキストと、適切な相手に対応できるよう末尾の `[from: …]` マーカーが含まれます。
4. セッションレベルの指示（`/verbose on`、`/think high`、`/new`、または `/reset`、`/compact`）は、そのグループのセッションにのみ適用されます。認識されるよう、単独メッセージとして送信してください。個人 DM のセッションは独立したままです。

## テスト／検証

- 手動スモークテスト：
  - グループで `@openclaw` のピンを送信し、送信者名に言及した返信があることを確認します。
  - 2 回目のピンを送信し、履歴ブロックが含まれ、その次のターンでクリアされることを確認します。
- ゲートウェイログを確認します（`--verbose` で実行）。`from: <groupJid>` と `[from: …]` のサフィックスを示す `inbound web message` エントリが表示されます。

## 既知の考慮事項

- ノイズの多いブロードキャストを避けるため、グループではハートビートは意図的にスキップされます。
- エコー抑制は結合されたバッチ文字列を使用します。メンションなしで同一のテキストを 2 回送信した場合、応答が得られるのは最初のみです。
- セッションストアのエントリは、セッションストア（デフォルトでは `~/.openclaw/agents/<agentId>/sessions/sessions.json`）内で `agent:<agentId>:whatsapp:group:<jid>` として表示されます。エントリが存在しない場合は、そのグループがまだ実行をトリガーしていないことを意味します。
- グループでの入力中インジケーターは `agents.defaults.typingMode` に従います（デフォルト：メンションされていない場合は `message`）。
