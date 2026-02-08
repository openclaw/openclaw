---
summary: "メッセージのフロー、セッション、キューイング、および推論の可視性"
read_when:
  - 受信メッセージがどのように返信へ変換されるかを説明する場合
  - セッション、キューイング モード、またはストリーミングの挙動を明確化する場合
  - 推論の可視性と使用上の影響を文書化する場合
title: "メッセージ"
x-i18n:
  source_path: concepts/messages.md
  source_hash: 773301d5c0c1e3b8
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:21:35Z
---

# メッセージ

このページでは、OpenClaw が受信メッセージ、セッション、キューイング、
ストリーミング、および推論の可視性をどのように扱うかをまとめて説明します。

## メッセージ フロー（概要）

```
Inbound message
  -> routing/bindings -> session key
  -> queue (if a run is active)
  -> agent run (streaming + tools)
  -> outbound replies (channel limits + chunking)
```

主要な設定項目は 設定 にあります。

- `messages.*`：プレフィックス、キューイング、グループの挙動。
- `agents.defaults.*`：ブロック ストリーミングとチャンク化の既定値。
- チャンネルごとの上書き（`channels.whatsapp.*`、`channels.telegram.*` など）：上限やストリーミング トグル。

完全なスキーマは [設定](/gateway/configuration) を参照してください。

## 受信の重複排除

チャンネルは、再接続後に同一メッセージを再配信する場合があります。OpenClaw は
channel/account/peer/session/message id をキーにした短命のキャッシュを保持し、
重複配信が別のエージェント実行を引き起こさないようにします。

## 受信のデバウンス

**同一送信者** からの短時間に連続するメッセージは、`messages.inbound` により
単一のエージェント ターンにバッチ化できます。デバウンスは
チャンネル + 会話 単位で適用され、返信のスレッド化/ID には最新のメッセージを使用します。

設定（グローバル既定 + チャンネルごとの上書き）：

```json5
{
  messages: {
    inbound: {
      debounceMs: 2000,
      byChannel: {
        whatsapp: 5000,
        slack: 1500,
        discord: 1500,
      },
    },
  },
}
```

注記：

- デバウンスは **テキストのみ** のメッセージに適用されます。メディア/添付は即時にフラッシュされます。
- 制御コマンドはデバウンスをバイパスし、単独で扱われます。

## セッションとデバイス

セッションはクライアントではなく、ゲートウェイが所有します。

- ダイレクト チャットは、エージェントのメイン セッション キーに集約されます。
- グループ/チャンネルは、それぞれ独自のセッション キーを持ちます。
- セッション ストアとトランスクリプトは、ゲートウェイ ホスト上に保存されます。

複数のデバイス/チャンネルが同一セッションにマッピングされることはありますが、
履歴はすべてのクライアントへ完全に同期されるわけではありません。推奨事項として、
文脈の分岐を避けるため、長い会話では 1 台の主要デバイスを使用してください。
Control UI と TUI は常に、ゲートウェイに裏打ちされたセッションのトランスクリプトを表示するため、
それらが信頼できる唯一の情報源です。

詳細： [セッション管理](/concepts/session)。

## 受信ボディと履歴コンテキスト

OpenClaw は **プロンプト ボディ** と **コマンド ボディ** を分離します。

- `Body`：エージェントに送信されるプロンプト テキスト。チャンネルのエンベロープや
  任意の履歴ラッパーを含む場合があります。
- `CommandBody`：指示/コマンド解析用の生のユーザー テキスト。
- `RawBody`：`CommandBody` のレガシー エイリアス（互換性のため保持）。

チャンネルが履歴を提供する場合、共通のラッパーを使用します。

- `[Chat messages since your last reply - for context]`
- `[Current message - respond to this]`

**非ダイレクト チャット**（グループ/チャンネル/ルーム）では、**現在のメッセージ ボディ** に
送信者ラベルがプレフィックスとして付与されます（履歴エントリと同じ形式）。
これにより、リアルタイム メッセージとキュー/履歴メッセージが、エージェント プロンプト内で一貫します。

履歴バッファは **保留のみ** です。つまり、実行をトリガーしなかった
グループ メッセージ（例：メンション ゲートされたメッセージ）を含み、
すでにセッション トランスクリプトにあるメッセージは **除外** されます。

ディレクティブのストリッピングは **現在のメッセージ** セクションのみに適用されるため、
履歴は保持されます。履歴をラップするチャンネルは、元のメッセージ テキストとして
`CommandBody`（または `RawBody`）を設定し、結合されたプロンプトとして
`Body` を維持してください。履歴バッファは `messages.groupChat.historyLimit`（グローバル既定）および
`channels.slack.historyLimit` や `channels.telegram.accounts.<id>.historyLimit` といったチャンネルごとの上書きで設定できます
（無効化するには `0` を設定）。

## キューイングとフォローアップ

実行がすでにアクティブな場合、受信メッセージはキューに入れられたり、
現在の実行に誘導されたり、フォローアップ ターン用に収集されたりします。

- `messages.queue`（および `messages.queue.byChannel`）で設定します。
- モード：`interrupt`、`steer`、`followup`、`collect`、およびバックログのバリアント。

詳細： [キューイング](/concepts/queue)。

## ストリーミング、チャンク化、バッチ処理

ブロック ストリーミングは、モデルがテキスト ブロックを生成するのに合わせて部分的な返信を送信します。
チャンク化は、チャンネルのテキスト制限を尊重し、フェンス付きコードの分割を回避します。

主要な設定：

- `agents.defaults.blockStreamingDefault`（`on|off`、既定はオフ）
- `agents.defaults.blockStreamingBreak`（`text_end|message_end`）
- `agents.defaults.blockStreamingChunk`（`minChars|maxChars|breakPreference`）
- `agents.defaults.blockStreamingCoalesce`（アイドル ベースのバッチ処理）
- `agents.defaults.humanDelay`（ブロック返信間の人間らしい間）
- チャンネルごとの上書き：`*.blockStreaming` および `*.blockStreamingCoalesce`（Telegram 以外のチャンネルでは、明示的な `*.blockStreaming: true` が必要）

詳細： [ストリーミング + チャンク化](/concepts/streaming)。

## 推論の可視性とトークン

OpenClaw は、モデルの推論を公開または非公開にできます。

- `/reasoning on|off|stream` が可視性を制御します。
- 推論コンテンツは、モデルが生成した場合、トークン使用量に引き続きカウントされます。
- Telegram は、下書きバブルへの推論ストリームをサポートします。

詳細： [思考 + 推論ディレクティブ](/tools/thinking) および [トークン使用量](/reference/token-use)。

## プレフィックス、スレッド化、返信

送信メッセージのフォーマットは、`messages` に集約されています。

- `messages.responsePrefix`、`channels.<channel>.responsePrefix`、`channels.<channel>.accounts.<id>.responsePrefix`（送信プレフィックスのカスケード）、および `channels.whatsapp.messagePrefix`（WhatsApp 受信プレフィックス）
- `replyToMode` による返信のスレッド化と、チャンネルごとの既定値

詳細： [設定](/gateway/configuration#messages) および各チャンネルのドキュメント。
