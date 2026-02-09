---
summary: "ストリーミングおよびチャンク化の挙動（ブロック返信、下書きストリーミング、制限）"
read_when:
  - チャンネル上でのストリーミングやチャンク化の仕組みを説明する場合
  - ブロックストリーミングやチャンネルのチャンク化挙動を変更する場合
  - 重複した／早すぎるブロック返信や下書きストリーミングをデバッグする場合
title: "ストリーミングとチャンク化"
---

# ストリーミング + チャンク化

OpenClaw には 2 つの独立した「ストリーミング」レイヤーがあります。

- **ブロックストリーミング（チャンネル）:** アシスタントが書き進めるにつれて、完成した **ブロック** を送信します。これは通常のチャンネルメッセージであり、トークンデルタではありません。 これらは通常のチャネルメッセージです(トークンデルタではありません)。
- **疑似トークンストリーミング（Telegram のみ）:** 生成中に **下書きバブル** を部分テキストで更新し、最後に最終メッセージを送信します。

現在、外部チャンネルのメッセージに対する **本当のトークンストリーミング** はありません。部分的にストリーミングされるのは Telegram の下書きストリーミングのみです。 テレグラムのドラフトストリーミングは、唯一の部分的なストリームサーフェスです。

## ブロックストリーミング（チャンネルメッセージ）

ブロックストリーミングは、利用可能になった時点でアシスタントの出力を粗いチャンク単位で送信します。

```
Model output
  └─ text_delta/events
       ├─ (blockStreamingBreak=text_end)
       │    └─ chunker emits blocks as buffer grows
       └─ (blockStreamingBreak=message_end)
            └─ chunker flushes at message_end
                   └─ channel send (block replies)
```

凡例:

- `text_delta/events`: モデルのストリームイベント（非ストリーミングモデルでは疎になる場合があります）。
- `chunker`: 最小／最大境界と分割優先度を適用する `EmbeddedBlockChunker`。
- `channel send`: 実際に送信されるメッセージ（ブロック返信）。

**制御項目:**

- `agents.defaults.blockStreamingDefault`: `"on"`/`"off"`（デフォルトはオフ）。
- チャンネル上書き: `*.blockStreaming`（およびアカウント別バリアント）により、チャンネルごとに `"on"`/`"off"` を強制。
- `agents.defaults.blockStreamingBreak`: `"text_end"` または `"message_end"`。
- `agents.defaults.blockStreamingChunk`: `{ minChars, maxChars, breakPreference? }`。
- `agents.defaults.blockStreamingCoalesce`: `{ minChars?, maxChars?, idleMs? }`（送信前にストリーミングされたブロックを結合）。
- チャンネルのハード上限: `*.textChunkLimit`（例: `channels.whatsapp.textChunkLimit`）。
- チャンネルのチャンクモード: `*.chunkMode`（デフォルトは `length`、`newline` は長さによる分割の前に空行（段落境界）で分割）。
- Discord のソフト上限: `channels.discord.maxLinesPerMessage`（デフォルト 17）。UI のクリッピングを避けるために長い返信を分割します。

**境界のセマンティクス:**

- `text_end`: チャンカーが出力したらすぐにブロックをストリームし、各 `text_end` ごとにフラッシュします。
- `message_end`: アシスタントのメッセージが完了するまで待ち、その後にバッファされた出力をフラッシュします。

`message_end` でも、バッファされたテキストが `maxChars` を超える場合はチャンカーが使用されるため、最後に複数チャンクが送出されることがあります。

## チャンク化アルゴリズム（下限／上限）

ブロックのチャンク化は `EmbeddedBlockChunker` によって実装されています。

- **下限:** バッファが `minChars` 以上になるまで送信しません（強制されない限り）。
- **上限:** `maxChars` より前での分割を優先し、強制時は `maxChars` で分割します。
- **分割優先度:** `paragraph` → `newline` → `sentence` → `whitespace` → 強制分割。
- **コードフェンス:** フェンス内では分割しません。`maxChars` で強制分割される場合は、Markdown の整合性を保つためにフェンスを閉じて再オープンします。

`maxChars` はチャンネルの `textChunkLimit` にクランプされるため、チャンネルごとの上限を超えることはできません。

## 結合（ストリーミングされたブロックのマージ）

ブロックストリーミングが有効な場合、OpenClaw は送信前に **連続するブロックチャンクを結合** できます。これにより、進捗を提供しつつ「1 行スパム」を減らせます。 これにより、
プログレッシブ出力を提供しながら「単線スパム」を減少させます。

- Coalescingは、フラッシュする前に**アイドルギャップ** (`idleMs`) を待ちます。
- バッファは `maxChars` で上限が設定され、超過するとフラッシュされます。
- `minChars` は、十分なテキストが蓄積するまで小さな断片の送信を防ぎます
  （最終フラッシュでは残りのテキストが必ず送信されます）。
- 連結子は `blockStreamingChunk.breakPreference` から導出されます
  （`paragraph` → `\n\n`、`newline` → `\n`、`sentence` → 半角スペース）。
- チャンネル上書きは `*.blockStreamingCoalesce`（アカウント別設定を含む）で利用できます。
- デフォルトの結合 `minChars` は、上書きされない限り Signal/Slack/Discord では 1500 に引き上げられます。

## ブロック間の人間らしいペーシング

ブロックストリーミングが有効な場合、（最初のブロックの後に）ブロック返信の間へ **ランダム化されたポーズ** を追加できます。これにより、複数バブルの応答がより自然に感じられます。 これにより、マルチバブル応答は
より自然に感じられます。

- 設定: `agents.defaults.humanDelay`（`agents.list[].humanDelay` によりエージェントごとに上書き可能）。
- モード: `off`（デフォルト）、`natural`（800–2500ms）、`custom`（`minMs`/`maxMs`）。
- **ブロック返信** のみに適用され、最終返信やツールサマリーには適用されません。

## 「チャンクをストリームするか、すべてを送るか」

これは次にマップされます。

- **チャンクをストリーム:** `blockStreamingDefault: "on"` + `blockStreamingBreak: "text_end"`（進行に合わせて送信）。非 Telegram チャンネルでは `*.blockStreaming: true` も必要です。 Telegram以外のチャンネルでも`*.blockStreaming: true`が必要です。
- **最後にすべてをストリーム:** `blockStreamingBreak: "message_end"`（1 回でフラッシュ。非常に長い場合は複数チャンクになることがあります）。
- **ブロックストリーミングなし:** `blockStreamingDefault: "off"`（最終返信のみ）。

**チャンネル注記:** 非 Telegram チャンネルでは、`*.blockStreaming` が明示的に `true` に設定されない限り、ブロックストリーミングは **オフ** です。Telegram では、ブロック返信なしで下書きをストリーム（`channels.telegram.streamMode`）できます。 Telegramはブロックの返信なしで下書き
(`channels.telegram.streamMode`) をストリーミングできます。

設定場所の注意: `blockStreaming*` のデフォルトは、ルート設定ではなく
`agents.defaults` 配下にあります。

## Telegram の下書きストリーミング（疑似トークン）

下書きストリーミングを備えるチャンネルは Telegram のみです。

- Bot API の `sendMessageDraft` を **トピック付きのプライベートチャット** で使用します。
- `channels.telegram.streamMode: "partial" | "block" | "off"`。
  - `partial`: 最新のストリームテキストで下書きを更新します。
  - `block`: チャンク化されたブロックで下書きを更新します（同じチャンカー規則）。
  - `off`: 下書きストリーミングなし。
- 下書きのチャンク設定（`streamMode: "block"` のみ）: `channels.telegram.draftChunk`（デフォルト: `minChars: 200`、`maxChars: 800`）。
- 下書きストリーミングはブロックストリーミングとは独立しています。ブロック返信はデフォルトでオフであり、非 Telegram チャンネルでは `*.blockStreaming: true` によってのみ有効化されます。
- 最終返信は通常のメッセージです。
- `/reasoning stream` は推論内容を下書きバブルに書き込みます（Telegram のみ）。

下書きストリーミングが有効な場合、二重ストリーミングを避けるため、その返信では OpenClaw はブロックストリーミングを無効化します。

```
Telegram (private + topics)
  └─ sendMessageDraft (draft bubble)
       ├─ streamMode=partial → update latest text
       └─ streamMode=block   → chunker updates draft
  └─ final reply → normal message
```

凡例:

- `sendMessageDraft`: Telegram の下書きバブル（実際のメッセージではありません）。
- `final reply`: 通常の Telegram メッセージ送信。
