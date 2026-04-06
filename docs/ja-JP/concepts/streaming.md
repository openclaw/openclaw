---
read_when:
    - チャネルでのストリーミングやチャンキングの仕組みを説明する場合
    - ブロックストリーミングやチャネルチャンキングの動作を変更する場合
    - 重複・早期ブロック返信やチャネルプレビューストリーミングのデバッグ
summary: ストリーミング＋チャンキング動作（ブロック返信、チャネルプレビューストリーミング、モードマッピング）
title: ストリーミングとチャンキング
x-i18n:
    generated_at: "2026-04-02T07:40:31Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 44b0d08c7eafcb32030ef7c8d5719c2ea2d34e4bac5fdad8cc8b3f4e9e9fad97
    source_path: concepts/streaming.md
    workflow: 15
---

# ストリーミング＋チャンキング

OpenClawには2つの独立したストリーミングレイヤーがあります：

- **ブロックストリーミング（チャネル）：** アシスタントが書き込むにつれて、完成した**ブロック**を送信します。これらは通常のチャネルメッセージです（トークンデルタではありません）。
- **プレビューストリーミング（Telegram/Discord/Slack）：** 生成中に一時的な**プレビューメッセージ**を更新します。

現在、チャネルメッセージへの**真のトークンデルタストリーミングはありません**。プレビューストリーミングはメッセージベースです（送信＋編集/追加）。

## ブロックストリーミング（チャネルメッセージ）

ブロックストリーミングは、アシスタントの出力を利用可能になった時点で粗いチャンクとして送信します。

```
Model output
  └─ text_delta/events
       ├─ (blockStreamingBreak=text_end)
       │    └─ chunker emits blocks as buffer grows
       └─ (blockStreamingBreak=message_end)
            └─ chunker flushes at message_end
                   └─ channel send (block replies)
```

凡例：

- `text_delta/events`：モデルストリームイベント（非ストリーミングモデルではまばらになる場合があります）。
- `chunker`：min/max境界＋ブレーク設定を適用する`EmbeddedBlockChunker`。
- `channel send`：実際の送信メッセージ（ブロック返信）。

**制御項目：**

- `agents.defaults.blockStreamingDefault`：`"on"`/`"off"`（デフォルトはoff）。
- チャネルオーバーライド：`*.blockStreaming`（およびアカウントごとのバリアント）でチャネルごとに`"on"`/`"off"`を強制。
- `agents.defaults.blockStreamingBreak`：`"text_end"`または`"message_end"`。
- `agents.defaults.blockStreamingChunk`：`{ minChars, maxChars, breakPreference? }`。
- `agents.defaults.blockStreamingCoalesce`：`{ minChars?, maxChars?, idleMs? }`（送信前にストリーミングされたブロックをマージ）。
- チャネルハードキャップ：`*.textChunkLimit`（例：`channels.whatsapp.textChunkLimit`）。
- チャネルチャンクモード：`*.chunkMode`（`length`がデフォルト、`newline`は長さチャンキングの前に空行（段落境界）で分割）。
- Discordソフトキャップ：`channels.discord.maxLinesPerMessage`（デフォルト17）はUI切り詰めを避けるために長い返信を分割します。

**境界セマンティクス：**

- `text_end`：チャンカーが出力した時点でブロックをストリーミングし、各`text_end`でフラッシュ。
- `message_end`：アシスタントメッセージが完了するまで待機し、バッファされた出力をフラッシュ。

`message_end`でもバッファされたテキストが`maxChars`を超える場合はチャンカーを使用するため、最後に複数のチャンクを出力する場合があります。

## チャンキングアルゴリズム（低/高境界）

ブロックチャンキングは`EmbeddedBlockChunker`によって実装されています：

- **低境界：** バッファ >= `minChars`になるまで出力しない（強制時を除く）。
- **高境界：** `maxChars`の前での分割を優先。強制時は`maxChars`で分割。
- **ブレーク優先順位：** `paragraph` → `newline` → `sentence` → `whitespace` → ハードブレーク。
- **コードフェンス：** フェンス内では分割しない。`maxChars`で強制分割が必要な場合、Markdownの有効性を保つためにフェンスを閉じて再度開く。

`maxChars`はチャネルの`textChunkLimit`にクランプされるため、チャネルごとの上限を超えることはできません。

## コアレシング（ストリーミングされたブロックのマージ）

ブロックストリーミングが有効な場合、OpenClawは送信前に**連続するブロックチャンクをマージ**できます。これにより「1行ごとのスパム」を減らしつつ、段階的な出力を提供します。

- コアレシングは**アイドルギャップ**（`idleMs`）を待ってからフラッシュします。
- バッファは`maxChars`で上限が設定され、超過するとフラッシュされます。
- `minChars`は十分なテキストが蓄積されるまで小さなフラグメントの送信を防ぎます（最終フラッシュでは常に残りのテキストを送信）。
- ジョイナーは`blockStreamingChunk.breakPreference`から導出されます（`paragraph` → `\n\n`、`newline` → `\n`、`sentence` → スペース）。
- チャネルオーバーライドは`*.blockStreamingCoalesce`（アカウントごとの設定を含む）で利用可能です。
- デフォルトのコアレシング`minChars`は、オーバーライドされない限りSignal/Slack/Discordでは1500に引き上げられます。

## ブロック間の人間らしいペーシング

ブロックストリーミングが有効な場合、ブロック返信間に**ランダムなポーズ**を追加できます（最初のブロックの後）。これにより、複数バブルのレスポンスがより自然に感じられます。

- 設定：`agents.defaults.humanDelay`（エージェントごとに`agents.list[].humanDelay`でオーバーライド可能）。
- モード：`off`（デフォルト）、`natural`（800〜2500ms）、`custom`（`minMs`/`maxMs`）。
- **ブロック返信**にのみ適用され、最終返信やツールサマリーには適用されません。

## 「チャンクをストリーミングするか、すべてをストリーミングするか」

これは以下にマッピングされます：

- **チャンクをストリーミング：** `blockStreamingDefault: "on"` + `blockStreamingBreak: "text_end"`（逐次送信）。Telegram以外のチャネルでは`*.blockStreaming: true`も必要です。
- **最後にすべてをストリーミング：** `blockStreamingBreak: "message_end"`（1回フラッシュ、非常に長い場合は複数チャンクの可能性あり）。
- **ブロックストリーミングなし：** `blockStreamingDefault: "off"`（最終返信のみ）。

**チャネルに関する注意：** ブロックストリーミングは`*.blockStreaming`が明示的に`true`に設定**されない限りオフ**です。チャネルはブロック返信なしでライブプレビューをストリーミング（`channels.<channel>.streaming`）できます。

設定場所の補足：`blockStreaming*`のデフォルトはルート設定ではなく`agents.defaults`配下にあります。

## プレビューストリーミングモード

正規キー：`channels.<channel>.streaming`

モード：

- `off`：プレビューストリーミングを無効化。
- `partial`：最新のテキストで置き換えられる単一のプレビュー。
- `block`：チャンク/追加ステップでプレビューを更新。
- `progress`：生成中にプログレス/ステータスプレビューを表示し、完了時に最終回答。

### チャネルマッピング

| チャネル  | `off` | `partial` | `block` | `progress`        |
| --------- | ----- | --------- | ------- | ----------------- |
| Telegram  | ✅    | ✅        | ✅      | `partial`にマッピング |
| Discord   | ✅    | ✅        | ✅      | `partial`にマッピング |
| Slack     | ✅    | ✅        | ✅      | ✅                |

Slack固有：

- `channels.slack.nativeStreaming`は`streaming=partial`時にSlackネイティブストリーミングAPI呼び出しを切り替えます（デフォルト：`true`）。

レガシーキーの移行：

- Telegram：`streamMode` + ブール値`streaming`が`streaming`列挙型に自動移行されます。
- Discord：`streamMode` + ブール値`streaming`が`streaming`列挙型に自動移行されます。
- Slack：`streamMode`が`streaming`列挙型に自動移行されます。ブール値`streaming`は`nativeStreaming`に自動移行されます。

### ランタイム動作

Telegram：

- ダイレクトメッセージおよびグループ/トピック全体で`sendMessage` + `editMessageText`プレビュー更新を使用します。
- Telegramのブロックストリーミングが明示的に有効な場合、プレビューストリーミングはスキップされます（二重ストリーミングを避けるため）。
- `/reasoning stream`でリーズニングをプレビューに書き込めます。

Discord：

- 送信＋編集によるプレビューメッセージを使用します。
- `block`モードはドラフトチャンキング（`draftChunk`）を使用します。
- Discordのブロックストリーミングが明示的に有効な場合、プレビューストリーミングはスキップされます。

Slack：

- `partial`は利用可能な場合、Slackネイティブストリーミング（`chat.startStream`/`append`/`stop`）を使用できます。
- `block`は追加スタイルのドラフトプレビューを使用します。
- `progress`はステータスプレビューテキストを使用し、その後最終回答を表示します。

## 関連項目

- [メッセージ](/concepts/messages) — メッセージのライフサイクルと配信
- [リトライ](/concepts/retry) — 配信失敗時のリトライ動作
- [チャネル](/channels) — チャネルごとのストリーミングサポート
