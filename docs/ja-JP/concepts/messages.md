---
summary: "メッセージフロー、セッション、キューイング、推論の可視性"
read_when:
  - Explaining how inbound messages become replies
  - Clarifying sessions, queueing modes, or streaming behavior
  - Documenting reasoning visibility and usage implications
title: "メッセージ"
---

# メッセージ

このページでは、OpenClawが受信メッセージ、セッション、キューイング、ストリーミング、推論の可視性をどのように処理するかをまとめています。

## メッセージフロー（概要）

```
受信メッセージ
  -> ルーティング/バインディング -> セッションキー
  -> キュー（実行中の場合）
  -> エージェント実行（ストリーミング + ツール）
  -> 送信返信（チャンネル制限 + チャンキング）
```

主な設定項目:

- `messages.*`: プレフィックス、キューイング、グループ動作。
- `agents.defaults.*`: ブロックストリーミングとチャンキングのデフォルト。
- チャンネルオーバーライド（`channels.whatsapp.*`、`channels.telegram.*`など）: キャップとストリーミングの切り替え。

完全なスキーマについては[設定](/gateway/configuration)を参照してください。

## 受信メッセージの重複排除

チャンネルは再接続後に同じメッセージを再配信することがあります。OpenClawはチャンネル/アカウント/ピア/セッション/メッセージIDをキーとした短寿命キャッシュを保持し、重複配信が別のエージェント実行をトリガーしないようにします。

## 受信メッセージのデバウンス

**同じ送信者**からの連続した高速メッセージは、`messages.inbound`を介して単一のエージェントターンにバッチ処理できます。デバウンスはチャンネル + 会話ごとにスコープされ、返信スレッディング/IDには最新のメッセージが使用されます。

設定（グローバルデフォルト + チャンネルごとのオーバーライド）:

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
- コントロールコマンドはデバウンスをバイパスし、独立したメッセージとして扱われます。

## セッションとデバイス

セッションはクライアントではなくGatewayが所有します。

- ダイレクトチャットはエージェントのメインセッションキーに集約されます。
- グループ/チャンネルはそれぞれ独自のセッションキーを持ちます。
- セッションストアとトランスクリプトはGatewayホスト上に存在します。

複数のデバイス/チャンネルが同じセッションにマッピングされることがありますが、履歴はすべてのクライアントに完全に同期されるわけではありません。推奨: コンテキストの分岐を避けるため、長い会話にはプライマリデバイスを1つ使用してください。コントロールUIとTUIは常にGatewayが保持するセッションのトランスクリプトを表示するため、これが信頼できる情報源です。

詳細: [セッション管理](/concepts/session)。

## 受信ボディと履歴コンテキスト

OpenClawは**プロンプトボディ**と**コマンドボディ**を分離します:

- `Body`: エージェントに送信されるプロンプトテキスト。チャンネルエンベロープやオプションの履歴ラッパーを含むことがあります。
- `CommandBody`: ディレクティブ/コマンド解析用の生のユーザーテキスト。
- `RawBody`: `CommandBody`のレガシーエイリアス（互換性のために保持）。

チャンネルが履歴を提供する場合、共有ラッパーを使用します:

- `[Chat messages since your last reply - for context]`
- `[Current message - respond to this]`

**非ダイレクトチャット**（グループ/チャンネル/ルーム）では、**現在のメッセージボディ**に送信者ラベルがプレフィックスとして付けられます（履歴エントリと同じスタイル）。これにより、リアルタイムとキュー/履歴メッセージがエージェントプロンプトで一貫性を保ちます。

履歴バッファは**保留中のみ**: 実行をトリガーしなかったグループメッセージ（例: メンションゲートされたメッセージ）を含み、すでにセッションのトランスクリプトにあるメッセージは**除外**されます。

ディレクティブの除去は**現在のメッセージ**セクションにのみ適用され、履歴はそのまま維持されます。履歴をラップするチャンネルは`CommandBody`（または`RawBody`）を元のメッセージテキストに設定し、`Body`を結合されたプロンプトとして保持する必要があります。
履歴バッファは`messages.groupChat.historyLimit`（グローバルデフォルト）やチャンネルごとのオーバーライド（`channels.slack.historyLimit`や`channels.telegram.accounts.<id>.historyLimit`など）で設定できます（`0`に設定すると無効）。

## キューイングとフォローアップ

実行中の場合、受信メッセージはキューに入れたり、現在の実行にステアリングしたり、フォローアップターンとして収集したりできます。

- `messages.queue`（および`messages.queue.byChannel`）で設定します。
- モード: `interrupt`、`steer`、`followup`、`collect`、およびバックログバリアント。

詳細: [キューイング](/concepts/queue)。

## ストリーミング、チャンキング、バッチング

ブロックストリーミングはモデルがテキストブロックを生成するにつれて部分的な返信を送信します。
チャンキングはチャンネルのテキスト制限を尊重し、フェンスされたコードの分割を回避します。

主な設定:

- `agents.defaults.blockStreamingDefault`（`on|off`、デフォルトoff）
- `agents.defaults.blockStreamingBreak`（`text_end|message_end`）
- `agents.defaults.blockStreamingChunk`（`minChars|maxChars|breakPreference`）
- `agents.defaults.blockStreamingCoalesce`（アイドルベースのバッチング）
- `agents.defaults.humanDelay`（ブロック返信間の人間らしい一時停止）
- チャンネルオーバーライド: `*.blockStreaming`と`*.blockStreamingCoalesce`（Telegram以外のチャンネルでは明示的に`*.blockStreaming: true`が必要）

詳細: [ストリーミング + チャンキング](/concepts/streaming)。

## 推論の可視性とトークン

OpenClawはモデルの推論を公開または非表示にできます:

- `/reasoning on|off|stream`で可視性を制御します。
- 推論コンテンツはモデルが生成した場合、トークン使用量にカウントされます。
- Telegramは下書きバブルへの推論ストリーミングをサポートしています。

詳細: [思考 + 推論ディレクティブ](/tools/thinking)および[トークン使用量](/reference/token-use)。

## プレフィックス、スレッディング、返信

送信メッセージのフォーマットは`messages`で一元管理されます:

- `messages.responsePrefix`、`channels.<channel>.responsePrefix`、`channels.<channel>.accounts.<id>.responsePrefix`（送信プレフィックスカスケード）、および`channels.whatsapp.messagePrefix`（WhatsApp受信プレフィックス）
- `replyToMode`とチャンネルごとのデフォルトによる返信スレッディング

詳細: [設定](/gateway/configuration#messages)およびチャンネルドキュメント。
