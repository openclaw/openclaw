---
summary: "ストリーミング + チャンキング動作（ブロック返信、チャンネルプレビューストリーミング、モードマッピング）"
read_when:
  - Explaining how streaming or chunking works on channels
  - Changing block streaming or channel chunking behavior
  - Debugging duplicate/early block replies or channel preview streaming
title: "ストリーミングとチャンキング"
---

# ストリーミング + チャンキング

OpenClawには2つの別々のストリーミングレイヤーがあります:

- **ブロックストリーミング（チャンネル）:** アシスタントが書き込むにつれて完了した**ブロック**を送信します。これらは通常のチャンネルメッセージです（トークンデルタではありません）。
- **プレビューストリーミング（Telegram/Discord/Slack）:** 生成中に一時的な**プレビューメッセージ**を更新します。

今日、チャンネルメッセージへの**真のトークンデルタストリーミング**はありません。プレビューストリーミングはメッセージベースです（送信 + 編集/追加）。

## ブロックストリーミング（チャンネルメッセージ）

ブロックストリーミングは利用可能になるにつれてアシスタントの出力を粗いチャンクで送信します。

```
モデル出力
  └─ text_delta/events
       ├─ (blockStreamingBreak=text_end)
       │    └─ チャンカーがバッファの成長に応じてブロックを送信
       └─ (blockStreamingBreak=message_end)
            └─ チャンカーがmessage_endでフラッシュ
                   └─ チャンネル送信（ブロック返信）
```

凡例:

- `text_delta/events`: モデルストリームイベント（非ストリーミングモデルではスパースな場合があります）。
- `chunker`: min/max境界 + 改行の優先度を適用する`EmbeddedBlockChunker`。
- `channel send`: 実際の送信メッセージ（ブロック返信）。

**設定:**

- `agents.defaults.blockStreamingDefault`: `"on"`/`"off"`（デフォルトoff）。
- チャンネルオーバーライド: `*.blockStreaming`（およびアカウントごとのバリアント）でチャンネルごとに`"on"`/`"off"`を強制。
- `agents.defaults.blockStreamingBreak`: `"text_end"`または`"message_end"`。
- `agents.defaults.blockStreamingChunk`: `{ minChars, maxChars, breakPreference? }`。
- `agents.defaults.blockStreamingCoalesce`: `{ minChars?, maxChars?, idleMs? }`（送信前のストリーミングブロックのマージ）。
- チャンネルハードキャップ: `*.textChunkLimit`（例: `channels.whatsapp.textChunkLimit`）。
- チャンネルチャンクモード: `*.chunkMode`（`length`がデフォルト、`newline`は長さチャンキングの前に空行（段落境界）で分割）。
- Discordソフトキャップ: `channels.discord.maxLinesPerMessage`（デフォルト17）はUIクリッピングを避けるために長い返信を分割します。

**境界のセマンティクス:**

- `text_end`: チャンカーが送信するとすぐにブロックをストリーミング。各`text_end`でフラッシュ。
- `message_end`: アシスタントメッセージが完了するまで待ってから、バッファされた出力をフラッシュ。

`message_end`でもバッファされたテキストが`maxChars`を超える場合はチャンカーを使用するため、最後に複数のチャンクを送信する場合があります。

## チャンキングアルゴリズム（低/高境界）

ブロックチャンキングは`EmbeddedBlockChunker`によって実装されます:

- **低境界:** バッファが`minChars`以上になるまで送信しない（強制時を除く）。
- **高境界:** `maxChars`前での分割を優先。強制時は`maxChars`で分割。
- **改行の優先度:** `paragraph` → `newline` → `sentence` → `whitespace` → ハードブレーク。
- **コードフェンス:** フェンス内では分割しない。`maxChars`で強制される場合、Markdownを有効に保つためにフェンスを閉じて再度開く。

`maxChars`はチャンネルの`textChunkLimit`にクランプされるため、チャンネルごとのキャップを超えることはできません。

## コアレッシング（ストリーミングブロックのマージ）

ブロックストリーミングが有効な場合、OpenClawは送信前に**連続するブロックチャンクをマージ**できます。これにより、プログレッシブな出力を提供しながら「単一行スパム」を削減します。

- コアレッシングは**アイドルギャップ**（`idleMs`）が発生するまでフラッシュを待機します。
- バッファは`maxChars`で制限され、超過するとフラッシュします。
- `minChars`は十分なテキストが蓄積されるまで小さなフラグメントの送信を防ぎます（最終フラッシュは常に残りのテキストを送信）。
- ジョイナーは`blockStreamingChunk.breakPreference`から導出されます（`paragraph` → `\n\n`、`newline` → `\n`、`sentence` → スペース）。
- チャンネルオーバーライドは`*.blockStreamingCoalesce`（アカウントごとの設定を含む）で利用可能です。
- Signal/Slack/Discordのデフォルトのコアレッシング`minChars`はオーバーライドされない限り1500に引き上げられます。

## ブロック間の人間らしいペーシング

ブロックストリーミングが有効な場合、ブロック返信間に（最初のブロックの後）**ランダム化された一時停止**を追加できます。これにより、マルチバブル返信がより自然に感じられます。

- 設定: `agents.defaults.humanDelay`（`agents.list[].humanDelay`でエージェントごとにオーバーライド）。
- モード: `off`（デフォルト）、`natural`（800-2500ms）、`custom`（`minMs`/`maxMs`）。
- **ブロック返信**にのみ適用されます。最終返信やツールサマリーには適用されません。

## 「チャンクをストリーミングするか、すべてをストリーミングするか」

これは以下にマッピングされます:

- **チャンクをストリーミング:** `blockStreamingDefault: "on"` + `blockStreamingBreak: "text_end"`（進行中に送信）。Telegram以外のチャンネルでは`*.blockStreaming: true`も必要です。
- **最後にすべてをストリーミング:** `blockStreamingBreak: "message_end"`（1回フラッシュ、非常に長い場合は複数チャンクの可能性あり）。
- **ブロックストリーミングなし:** `blockStreamingDefault: "off"`（最終返信のみ）。

**チャンネルに関する注意:** ブロックストリーミングは`*.blockStreaming`が明示的に`true`に設定されて**いない限りオフ**です。チャンネルはブロック返信なしでライブプレビューをストリーミングできます（`channels.<channel>.streaming`）。

設定場所の確認: `blockStreaming*`デフォルトは`agents.defaults`配下にあり、ルート設定ではありません。

## プレビューストリーミングモード

正規キー: `channels.<channel>.streaming`

モード:

- `off`: プレビューストリーミングを無効化。
- `partial`: 最新のテキストで置き換えられる単一のプレビュー。
- `block`: チャンク/追加ステップでプレビューを更新。
- `progress`: 生成中の進行状況/ステータスプレビュー、完了時に最終回答。

### チャンネルマッピング

| チャンネル | `off` | `partial` | `block` | `progress`        |
| ---------- | ----- | --------- | ------- | ----------------- |
| Telegram   | ✅    | ✅        | ✅      | `partial`にマップ |
| Discord    | ✅    | ✅        | ✅      | `partial`にマップ |
| Slack      | ✅    | ✅        | ✅      | ✅                |

Slackのみ:

- `channels.slack.nativeStreaming`は`streaming=partial`時のSlackネイティブストリーミングAPI呼び出しを切り替えます（デフォルト: `true`）。

レガシーキーの移行:

- Telegram: `streamMode` + ブール値`streaming`が`streaming`列挙型に自動移行。
- Discord: `streamMode` + ブール値`streaming`が`streaming`列挙型に自動移行。
- Slack: `streamMode`が`streaming`列挙型に自動移行。ブール値`streaming`は`nativeStreaming`に自動移行。

### ランタイム動作

Telegram:

- Bot API `sendMessage` + `editMessageText`を使用。
- Telegramブロックストリーミングが明示的に有効な場合、プレビューストリーミングはスキップされます（二重ストリーミングを回避）。
- `/reasoning stream`で推論をプレビューに書き込み可能。

Discord:

- 送信 + 編集のプレビューメッセージを使用。
- `block`モードはドラフトチャンキング（`draftChunk`）を使用。
- Discordブロックストリーミングが明示的に有効な場合、プレビューストリーミングはスキップされます。

Slack:

- `partial`はSlackネイティブストリーミング（`chat.startStream`/`append`/`stop`）を利用可能な場合に使用可能。
- `block`は追加スタイルのドラフトプレビューを使用。
- `progress`はステータスプレビューテキストを使用し、その後最終回答。
