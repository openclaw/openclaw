---
read_when:
    - 受信メッセージがどのように返信になるかを説明する場合
    - セッション、キューイングモード、ストリーミング動作を明確にする場合
    - 推論の可視性と使用量への影響をドキュメント化する場合
summary: メッセージフロー、セッション、キューイング、推論の可視性
title: メッセージ
x-i18n:
    generated_at: "2026-04-02T07:38:02Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 475f892bd534fdb10a2ee5d3c57a3d4a7fb8e1ab68d695189ba186004713f6f3
    source_path: concepts/messages.md
    workflow: 15
---

# メッセージ

このページでは、OpenClawが受信メッセージ、セッション、キューイング、ストリーミング、推論の可視性をどのように処理するかをまとめて説明します。

## メッセージフロー（概要）

```
受信メッセージ
  -> ルーティング/バインディング -> セッションキー
  -> キュー（実行中の場合）
  -> エージェント実行（ストリーミング + ツール）
  -> 送信返信（チャネル制限 + チャンキング）
```

主要な設定は設定ファイルにあります:

- `messages.*` プレフィックス、キューイング、グループ動作用。
- `agents.defaults.*` ブロックストリーミングとチャンキングのデフォルト用。
- チャネルオーバーライド（`channels.whatsapp.*`、`channels.telegram.*` など）上限とストリーミングトグル用。

完全なスキーマについては[設定](/gateway/configuration)を参照してください。

## 受信メッセージの重複排除

チャネルは再接続後に同じメッセージを再配信することがあります。OpenClawはチャネル/アカウント/ピア/セッション/メッセージIDをキーとする短期キャッシュを保持し、重複配信が別のエージェント実行をトリガーしないようにします。

## 受信メッセージのデバウンス

**同一送信者**からの連続した高速メッセージは、`messages.inbound` を使用して単一のエージェントターンにバッチ化できます。デバウンスはチャネル + 会話ごとにスコープされ、返信スレッディング/IDには最新のメッセージが使用されます。

設定（グローバルデフォルト + チャネルごとのオーバーライド）:

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

注意事項:

- デバウンスは**テキストのみ**のメッセージに適用されます。メディア/添付ファイルは即座にフラッシュされます。
- コントロールコマンドはデバウンスをバイパスし、独立したまま処理されます。

## セッションとデバイス

セッションはクライアントではなく、Gateway ゲートウェイが所有します。

- ダイレクトチャットはエージェントのメインセッションキーに集約されます。
- グループ/チャネルはそれぞれ独自のセッションキーを取得します。
- セッションストアとトランスクリプトは Gateway ゲートウェイホスト上に保存されます。

複数のデバイス/チャネルが同じセッションにマッピングされることがありますが、履歴はすべてのクライアントに完全に同期されるわけではありません。推奨: 長い会話にはプライマリデバイスを1つ使用し、コンテキストの分岐を避けてください。コントロールUIとTUIは常に Gateway ゲートウェイのセッショントランスクリプトを表示するため、信頼できる情報源となります。

詳細: [セッション管理](/concepts/session)。

## 受信メッセージ本文と履歴コンテキスト

OpenClawは**プロンプト本文**と**コマンド本文**を分離します:

- `Body`: エージェントに送信されるプロンプトテキスト。チャネルエンベロープやオプションの履歴ラッパーを含む場合があります。
- `CommandBody`: ディレクティブ/コマンドパース用の生のユーザーテキスト。
- `RawBody`: `CommandBody` のレガシーエイリアス（互換性のために保持）。

チャネルが履歴を提供する場合、共有ラッパーを使用します:

- `[Chat messages since your last reply - for context]`
- `[Current message - respond to this]`

**非ダイレクトチャット**（グループ/チャネル/ルーム）では、**現在のメッセージ本文**に送信者ラベルがプレフィックスとして付与されます（履歴エントリと同じスタイル）。これにより、エージェントプロンプト内でリアルタイムメッセージとキューイング/履歴メッセージの一貫性が保たれます。

履歴バッファは**保留中のみ**です: 実行をトリガーしなかったグループメッセージ（例えば、メンションゲートされたメッセージ）を含み、セッショントランスクリプトに既にあるメッセージは**除外**されます。

ディレクティブの除去は**現在のメッセージ**セクションにのみ適用され、履歴はそのまま保持されます。履歴をラップするチャネルは、`CommandBody`（または `RawBody`）を元のメッセージテキストに設定し、`Body` を結合されたプロンプトとして保持する必要があります。
履歴バッファは `messages.groupChat.historyLimit`（グローバルデフォルト）およびチャネルごとのオーバーライド（`channels.slack.historyLimit` や `channels.telegram.accounts.<id>.historyLimit` など）で設定可能です（`0` に設定すると無効になります）。

## キューイングとフォローアップ

実行中の場合、受信メッセージはキューイング、現在の実行へのステアリング、またはフォローアップターンへの収集が可能です。

- `messages.queue`（および `messages.queue.byChannel`）で設定します。
- モード: `interrupt`、`steer`、`followup`、`collect`、およびバックログバリアント。

詳細: [キューイング](/concepts/queue)。

## ストリーミング、チャンキング、バッチング

ブロックストリーミングは、モデルがテキストブロックを生成するにつれて部分的な返信を送信します。チャンキングはチャネルのテキスト制限を遵守し、フェンスドコードの分割を避けます。

主要な設定:

- `agents.defaults.blockStreamingDefault`（`on|off`、デフォルトoff）
- `agents.defaults.blockStreamingBreak`（`text_end|message_end`）
- `agents.defaults.blockStreamingChunk`（`minChars|maxChars|breakPreference`）
- `agents.defaults.blockStreamingCoalesce`（アイドルベースのバッチング）
- `agents.defaults.humanDelay`（ブロック返信間の人間的な間隔）
- チャネルオーバーライド: `*.blockStreaming` と `*.blockStreamingCoalesce`（Telegram以外のチャネルでは明示的に `*.blockStreaming: true` が必要）

詳細: [ストリーミング + チャンキング](/concepts/streaming)。

## 推論の可視性とトークン

OpenClawはモデルの推論を表示または非表示にできます:

- `/reasoning on|off|stream` で可視性を制御します。
- 推論コンテンツはモデルが生成した場合、トークン使用量にカウントされます。
- Telegramはドラフトバブルへの推論ストリームをサポートしています。

詳細: [思考 + 推論ディレクティブ](/tools/thinking)と[トークン使用量](/reference/token-use)。

## プレフィックス、スレッディング、返信

送信メッセージのフォーマットは `messages` に集約されています:

- `messages.responsePrefix`、`channels.<channel>.responsePrefix`、`channels.<channel>.accounts.<id>.responsePrefix`（送信プレフィックスカスケード）、および `channels.whatsapp.messagePrefix`（WhatsApp受信プレフィックス）
- `replyToMode` とチャネルごとのデフォルトによる返信スレッディング

詳細: [設定](/gateway/configuration-reference#messages)とチャネルドキュメント。

## 関連

- [ストリーミング](/concepts/streaming) — リアルタイムメッセージ配信
- [リトライ](/concepts/retry) — メッセージ配信のリトライ動作
- [キュー](/concepts/queue) — メッセージ処理キュー
- [チャネル](/channels) — メッセージングプラットフォーム連携
