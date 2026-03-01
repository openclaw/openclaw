---
summary: "詳細解説: セッションストアとトランスクリプト、ライフサイクル、（自動）コンパクションの内部"
read_when:
  - セッション ID、トランスクリプト JSONL、sessions.json フィールドをデバッグする必要があるとき
  - 自動コンパクションの動作を変更したり「コンパクション前」のハウスキーピングを追加するとき
  - メモリフラッシュやサイレントシステムターンを実装したいとき
title: "セッション管理の詳細解説"
---

# セッション管理とコンパクション（詳細解説）

このドキュメントでは、OpenClaw がセッションをエンドツーエンドで管理する方法を説明します:

- **セッションルーティング**（受信メッセージが `sessionKey` にマッピングされる方法）
- **セッションストア**（`sessions.json`）とその追跡内容
- **トランスクリプトの永続化**（`*.jsonl`）とその構造
- **トランスクリプトの衛生管理**（実行前のプロバイダー固有の修正）
- **コンテキスト制限**（コンテキストウィンドウと追跡トークン）
- **コンパクション**（手動 + 自動コンパクション）とコンパクション前のフックを追加する場所
- **サイレントハウスキーピング**（例: ユーザーに表示されるべきでないメモリ書き込み）

高レベルの概要から始めたい場合は、以下を参照してください:

- [/concepts/session](/concepts/session)
- [/concepts/compaction](/concepts/compaction)
- [/concepts/session-pruning](/concepts/session-pruning)
- [/reference/transcript-hygiene](/reference/transcript-hygiene)

---

## 信頼の源: Gateway

OpenClaw は、セッション状態を管理する単一の **Gateway プロセス**を中心に設計されています。

- UI（macOS アプリ、Web コントロール UI、TUI）はセッションリストとトークンカウントのために Gateway に問い合わせる必要があります。
- リモートモードでは、セッションファイルはリモートホストにあります。「ローカル Mac のファイルを確認する」では Gateway が使用しているものは反映されません。

---

## 2 つの永続化レイヤー

OpenClaw はセッションを 2 つのレイヤーで永続化します:

1. **セッションストア（`sessions.json`）**
   - キー/バリューマップ: `sessionKey -> SessionEntry`
   - 小さく、変更可能、安全に編集（またはエントリを削除）できます
   - セッションのメタデータを追跡します（現在のセッション ID、最後のアクティビティ、トグル、トークンカウンターなど）

2. **トランスクリプト（`<sessionId>.jsonl`）**
   - ツリー構造を持つ追記専用のトランスクリプト（エントリには `id` + `parentId` がある）
   - 実際の会話 + ツール呼び出し + コンパクションサマリーを保存します
   - 将来のターンのためにモデルコンテキストを再構築するために使用されます

---

## ディスク上の場所

Gateway ホスト上の各エージェントごと:

- ストア: `~/.openclaw/agents/<agentId>/sessions/sessions.json`
- トランスクリプト: `~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl`
  - Telegram トピックセッション: `.../<sessionId>-topic-<threadId>.jsonl`

OpenClaw はこれらを `src/config/sessions.ts` 経由で解決します。

---

## ストアのメンテナンスとディスク制御

セッションの永続化には、`sessions.json` とトランスクリプト成果物のための自動メンテナンス制御（`session.maintenance`）があります:

- `mode`: `warn`（デフォルト）または `enforce`
- `pruneAfter`: 古いエントリの年齢カットオフ（デフォルト `30d`）
- `maxEntries`: `sessions.json` のエントリ数の上限（デフォルト `500`）
- `rotateBytes`: サイズオーバー時に `sessions.json` をローテーション（デフォルト `10mb`）
- `resetArchiveRetention`: `*.reset.<timestamp>` トランスクリプトアーカイブの保持期間（デフォルト: `pruneAfter` と同じ。`false` でクリーンアップを無効化）
- `maxDiskBytes`: オプションのセッションディレクトリの予算
- `highWaterBytes`: クリーンアップ後のオプションのターゲット（`maxDiskBytes` のデフォルト `80%`）

ディスク予算クリーンアップの強制順序（`mode: "enforce"`）:

1. 最初に最も古いアーカイブまたは孤立したトランスクリプト成果物を削除します。
2. それでもターゲットを超えている場合は、最も古いセッションエントリとそのトランスクリプトファイルを削除します。
3. 使用量が `highWaterBytes` 以下になるまで続けます。

`mode: "warn"` では、OpenClaw は潜在的な削除を報告しますが、ストア/ファイルを変更しません。

オンデマンドでメンテナンスを実行します:

```bash
openclaw sessions cleanup --dry-run
openclaw sessions cleanup --enforce
```

---

## Cron セッションと実行ログ

分離された Cron 実行もセッションエントリ/トランスクリプトを作成し、専用の保持制御があります:

- `cron.sessionRetention`（デフォルト `24h`）は古い分離された Cron 実行セッションをセッションストアから削除します（`false` で無効化）。
- `cron.runLog.maxBytes` + `cron.runLog.keepLines` は `~/.openclaw/cron/runs/<jobId>.jsonl` ファイルを削除します（デフォルト: `2_000_000` バイトと `2000` 行）。

---

## セッションキー（`sessionKey`）

`sessionKey` は、あなたがどの会話バケットにいるかを識別します（ルーティング + 分離）。

一般的なパターン:

- メイン/ダイレクトチャット（エージェントごと）: `agent:<agentId>:<mainKey>`（デフォルト `main`）
- グループ: `agent:<agentId>:<channel>:group:<id>`
- ルーム/チャンネル（Discord/Slack）: `agent:<agentId>:<channel>:channel:<id>` または `...:room:<id>`
- Cron: `cron:<job.id>`
- Webhook: `hook:<uuid>`（オーバーライドされない限り）

正規のルールは [/concepts/session](/concepts/session) に文書化されています。

---

## セッション ID（`sessionId`）

各 `sessionKey` は現在の `sessionId`（会話を継続するトランスクリプトファイル）を指します。

経験則:

- **リセット**（`/new`、`/reset`）はその `sessionKey` に対して新しい `sessionId` を作成します。
- **日次リセット**（Gateway ホストのローカル時間でデフォルト午前 4:00）は、リセット境界後の次のメッセージで新しい `sessionId` を作成します。
- **アイドル有効期限**（`session.reset.idleMinutes` またはレガシー `session.idleMinutes`）は、アイドルウィンドウ後にメッセージが到着したときに新しい `sessionId` を作成します。日次とアイドルの両方が設定されている場合、最初に有効期限が切れた方が優先されます。
- **スレッド親フォークガード**（`session.parentForkMaxTokens`、デフォルト `100000`）は、親セッションが既に大きすぎる場合に親トランスクリプトのフォークをスキップします。新しいスレッドは新しい状態から開始します。無効にするには `0` を設定してください。

実装の詳細: 決定は `src/auto-reply/reply/session.ts` の `initSessionState()` で行われます。

---

## セッションストアスキーマ（`sessions.json`）

ストアの値の型は `src/config/sessions.ts` の `SessionEntry` です。

主要フィールド（網羅的ではありません）:

- `sessionId`: 現在のトランスクリプト ID（`sessionFile` が設定されていない限り、ファイル名はこれから導出されます）
- `updatedAt`: 最後のアクティビティのタイムスタンプ
- `sessionFile`: オプションの明示的なトランスクリプトパスオーバーライド
- `chatType`: `direct | group | room`（UI と送信ポリシーに役立ちます）
- `provider`、`subject`、`room`、`space`、`displayName`: グループ/チャンネルのラベリング用メタデータ
- トグル:
  - `thinkingLevel`、`verboseLevel`、`reasoningLevel`、`elevatedLevel`
  - `sendPolicy`（セッションごとのオーバーライド）
- モデル選択:
  - `providerOverride`、`modelOverride`、`authProfileOverride`
- トークンカウンター（ベストエフォート/プロバイダー依存）:
  - `inputTokens`、`outputTokens`、`totalTokens`、`contextTokens`
- `compactionCount`: このセッションキーの自動コンパクションが完了した回数
- `memoryFlushAt`: 最後のコンパクション前メモリフラッシュのタイムスタンプ
- `memoryFlushCompactionCount`: 最後のフラッシュが実行されたときのコンパクションカウント

ストアは安全に編集できますが、Gateway が権威を持ちます。セッションが実行されるにつれて、エントリを書き直したり再ハイドレートしたりする場合があります。

---

## トランスクリプト構造（`*.jsonl`）

トランスクリプトは `@mariozechner/pi-coding-agent` の `SessionManager` によって管理されます。

ファイルは JSONL 形式です:

- 最初の行: セッションヘッダー（`type: "session"`、`id`、`cwd`、`timestamp`、オプションの `parentSession` を含む）
- 以降: `id` + `parentId`（ツリー）を持つセッションエントリ

主要なエントリタイプ:

- `message`: ユーザー/アシスタント/toolResult メッセージ
- `custom_message`: モデルコンテキストに_入る_拡張注入メッセージ（UI から非表示にできます）
- `custom`: モデルコンテキストに_入らない_拡張状態
- `compaction`: `firstKeptEntryId` と `tokensBefore` を持つ永続化されたコンパクションサマリー
- `branch_summary`: ツリーブランチをナビゲートするときの永続化されたサマリー

OpenClaw は意図的にトランスクリプトを「修正」しません。Gateway は `SessionManager` を使用してそれらを読み書きします。

---

## コンテキストウィンドウと追跡トークン

2 つの異なる概念が重要です:

1. **モデルコンテキストウィンドウ**: モデルごとの厳格な上限（モデルに表示されるトークン）
2. **セッションストアカウンター**: `sessions.json` に書き込まれるローリング統計（`/status` とダッシュボードに使用）

制限を調整する場合:

- コンテキストウィンドウはモデルカタログから取得されます（設定でオーバーライドできます）。
- ストアの `contextTokens` は実行時の推定/報告値です。厳格な保証として扱わないでください。

詳細については [/token-use](/reference/token-use) を参照してください。

---

## コンパクション: それが何であるか

コンパクションは、古い会話をトランスクリプトの永続化された `compaction` エントリにまとめ、最近のメッセージはそのまま保持します。

コンパクション後、将来のターンには以下が表示されます:

- コンパクションサマリー
- `firstKeptEntryId` 以降のメッセージ

コンパクションは**永続的**です（セッションプルーニングとは異なります）。[/concepts/session-pruning](/concepts/session-pruning) を参照してください。

---

## 自動コンパクションが発生するとき（Pi ランタイム）

埋め込み Pi エージェントでは、自動コンパクションは 2 つのケースでトリガーされます:

1. **オーバーフロー回復**: モデルがコンテキストオーバーフローエラーを返す → コンパクション → リトライ。
2. **閾値メンテナンス**: 成功したターンの後、次の条件が満たされたとき:

`contextTokens > contextWindow - reserveTokens`

ここで:

- `contextWindow` はモデルのコンテキストウィンドウ
- `reserveTokens` はプロンプト + 次のモデル出力のために確保されたヘッドルーム

これらは Pi ランタイムのセマンティクスです（OpenClaw がイベントを消費しますが、コンパクションするかどうかは Pi が決定します）。

---

## コンパクション設定（`reserveTokens`、`keepRecentTokens`）

Pi のコンパクション設定は Pi の設定に存在します:

```json5
{
  compaction: {
    enabled: true,
    reserveTokens: 16384,
    keepRecentTokens: 20000,
  },
}
```

OpenClaw は埋め込み実行のために安全フロアも強制します:

- `compaction.reserveTokens < reserveTokensFloor` の場合、OpenClaw はそれを引き上げます。
- デフォルトフロアは `20000` トークンです。
- フロアを無効にするには `agents.defaults.compaction.reserveTokensFloor: 0` を設定してください。
- 既に高い場合、OpenClaw はそのままにします。

理由: マルチターンの「ハウスキーピング」（メモリ書き込みなど）のために、コンパクションが避けられなくなる前に十分なヘッドルームを確保するためです。

実装: `src/agents/pi-settings.ts` の `ensurePiCompactionReserveTokens()`
（`src/agents/pi-embedded-runner.ts` から呼び出されます）。

---

## ユーザーに表示されるサーフェス

コンパクションとセッション状態は以下で観察できます:

- `/status`（任意のチャットセッション内）
- `openclaw status`（CLI）
- `openclaw sessions` / `sessions --json`
- 詳細モード: `🧹 Auto-compaction complete` + コンパクションカウント

---

## サイレントハウスキーピング（`NO_REPLY`）

OpenClaw は、ユーザーが中間出力を見るべきでないバックグラウンドタスクのための「サイレント」ターンをサポートしています。

規約:

- アシスタントは出力を `NO_REPLY` で開始して「ユーザーに返信を配信しない」ことを示します。
- OpenClaw はこれを配信レイヤーで削除/抑制します。

`2026.1.10` 以降、OpenClaw は部分的なチャンクが `NO_REPLY` で始まる場合に**下書き/タイピングストリーミング**も抑制するため、サイレント操作がターン中に部分的な出力を漏らしません。

---

## コンパクション前の「メモリフラッシュ」（実装済み）

目標: 自動コンパクションが発生する前に、サイレントなエージェントターンを実行して永続的な状態をディスクに書き込みます（例: エージェントワークスペースの `memory/YYYY-MM-DD.md`）。これにより、コンパクションが重要なコンテキストを消去できなくなります。

OpenClaw は**プレ閾値フラッシュ**アプローチを使用します:

1. セッションのコンテキスト使用量を監視します。
2. 「ソフト閾値」（Pi のコンパクション閾値以下）を超えたとき、エージェントにサイレントな「今すぐメモリを書き込む」ディレクティブを実行します。
3. ユーザーには何も表示されないよう `NO_REPLY` を使用します。

設定（`agents.defaults.compaction.memoryFlush`）:

- `enabled`（デフォルト: `true`）
- `softThresholdTokens`（デフォルト: `4000`）
- `prompt`（フラッシュターンのユーザーメッセージ）
- `systemPrompt`（フラッシュターンに追加される追加システムプロンプト）

注意:

- デフォルトのプロンプト/システムプロンプトには配信を抑制する `NO_REPLY` ヒントが含まれています。
- フラッシュはコンパクションサイクルごとに 1 回実行されます（`sessions.json` で追跡）。
- フラッシュは埋め込み Pi セッションのみで実行されます（CLI バックエンドはスキップ）。
- セッションワークスペースが読み取り専用の場合（`workspaceAccess: "ro"` または `"none"`）、フラッシュはスキップされます。
- ワークスペースファイルのレイアウトと書き込みパターンについては [メモリ](/concepts/memory) を参照してください。

Pi は拡張 API に `session_before_compact` フックも公開していますが、OpenClaw のフラッシュロジックは現在 Gateway 側にあります。

---

## トラブルシューティングチェックリスト

- セッションキーが間違っている？ [/concepts/session](/concepts/session) から始めて、`/status` の `sessionKey` を確認してください。
- ストアとトランスクリプトが一致しない？ `openclaw status` で Gateway ホストとストアのパスを確認してください。
- コンパクションスパム？ 次を確認してください:
  - モデルのコンテキストウィンドウ（小さすぎる）
  - コンパクション設定（`reserveTokens` がモデルウィンドウに対して高すぎると、より早いコンパクションを引き起こす可能性がある）
  - ツール結果の肥大化: セッションプルーニングを有効化/調整してください
- サイレントターンが漏れている？ 返信が `NO_REPLY`（正確なトークン）で始まっていること、およびストリーミング抑制修正を含むビルドであることを確認してください。
