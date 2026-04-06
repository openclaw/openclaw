---
read_when:
    - セッションID、トランスクリプトJSONL、またはsessions.jsonのフィールドをデバッグする必要がある場合
    - 自動コンパクションの動作を変更したり、「コンパクション前」のハウスキーピングを追加する場合
    - メモリフラッシュやサイレントシステムターンを実装したい場合
summary: '詳細解説: セッションストア + トランスクリプト、ライフサイクル、および（自動）コンパクション内部構造'
title: セッション管理の詳細解説
x-i18n:
    generated_at: "2026-04-02T07:53:26Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: a0883b76b85c61d8d3524e57b98ad96bac181d16865a80cc6e13ab390df4de54
    source_path: reference/session-management-compaction.md
    workflow: 15
---

# セッション管理とコンパクション（詳細解説）

このドキュメントでは、OpenClawがセッションをエンドツーエンドで管理する方法を説明します:

- **セッションルーティング**（受信メッセージが `sessionKey` にマッピングされる仕組み）
- **セッションストア**（`sessions.json`）とその追跡内容
- **トランスクリプトの永続化**（`*.jsonl`）とその構造
- **トランスクリプトのハイジーン**（実行前のプロバイダー固有の修正処理）
- **コンテキスト制限**（コンテキストウィンドウ vs 追跡トークン）
- **コンパクション**（手動 + 自動コンパクション）とコンパクション前の処理をフックする場所
- **サイレントハウスキーピング**（ユーザーに表示される出力を生成すべきでないメモリ書き込みなど）

最初に高レベルの概要を確認したい場合は、以下を参照してください:

- [/concepts/session](/concepts/session)
- [/concepts/compaction](/concepts/compaction)
- [/concepts/memory](/concepts/memory)
- [/concepts/memory-search](/concepts/memory-search)
- [/concepts/session-pruning](/concepts/session-pruning)
- [/reference/transcript-hygiene](/reference/transcript-hygiene)

---

## 信頼できる情報源: Gateway ゲートウェイ

OpenClawは、セッション状態を所有する単一の**Gateway ゲートウェイプロセス**を中心に設計されています。

- UI（macOSアプリ、Web Control UI、TUI）は、セッション一覧やトークン数をGateway ゲートウェイに問い合わせる必要があります。
- リモートモードでは、セッションファイルはリモートホスト上にあります。「ローカルMacのファイルを確認する」ことでは、Gateway ゲートウェイが使用している内容は反映されません。

---

## 2つの永続化レイヤー

OpenClawはセッションを2つのレイヤーで永続化します:

1. **セッションストア（`sessions.json`）**
   - キー/バリューマップ: `sessionKey -> SessionEntry`
   - 小さく、可変で、安全に編集（またはエントリの削除）が可能
   - セッションメタデータ（現在のセッションID、最終アクティビティ、トグル、トークンカウンターなど）を追跡

2. **トランスクリプト（`<sessionId>.jsonl`）**
   - ツリー構造を持つ追記専用トランスクリプト（エントリには `id` + `parentId` がある）
   - 実際の会話 + ツール呼び出し + コンパクションサマリーを保存
   - 将来のターンでモデルコンテキストを再構築するために使用

---

## ディスク上の保存場所

エージェントごとに、Gateway ゲートウェイホスト上:

- ストア: `~/.openclaw/agents/<agentId>/sessions/sessions.json`
- トランスクリプト: `~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl`
  - Telegramトピックセッション: `.../<sessionId>-topic-<threadId>.jsonl`

OpenClawはこれらを `src/config/sessions.ts` 経由で解決します。

---

## ストアのメンテナンスとディスク制御

セッション永続化には、`sessions.json` とトランスクリプトアーティファクト用の自動メンテナンス制御（`session.maintenance`）があります:

- `mode`: `warn`（デフォルト）または `enforce`
- `pruneAfter`: 古いエントリの期限カットオフ（デフォルト `30d`）
- `maxEntries`: `sessions.json` のエントリ数上限（デフォルト `500`）
- `rotateBytes`: サイズ超過時に `sessions.json` をローテーション（デフォルト `10mb`）
- `resetArchiveRetention`: `*.reset.<timestamp>` トランスクリプトアーカイブの保持期間（デフォルト: `pruneAfter` と同じ。`false` でクリーンアップを無効化）
- `maxDiskBytes`: オプションのセッションディレクトリ予算
- `highWaterBytes`: クリーンアップ後のオプションの目標値（デフォルト `maxDiskBytes` の `80%`）

ディスク予算クリーンアップの実行順序（`mode: "enforce"`）:

1. 最も古いアーカイブ済みまたは孤立したトランスクリプトアーティファクトを最初に削除。
2. まだ目標を超えている場合、最も古いセッションエントリとそのトランスクリプトファイルを削除。
3. 使用量が `highWaterBytes` 以下になるまで続行。

`mode: "warn"` では、OpenClawは潜在的な削除を報告しますが、ストア/ファイルを変更しません。

オンデマンドでメンテナンスを実行:

```bash
openclaw sessions cleanup --dry-run
openclaw sessions cleanup --enforce
```

---

## Cronセッションと実行ログ

分離されたcron実行もセッションエントリ/トランスクリプトを作成し、専用の保持制御があります:

- `cron.sessionRetention`（デフォルト `24h`）は、セッションストアから古い分離cron実行セッションをプルーニングします（`false` で無効化）。
- `cron.runLog.maxBytes` + `cron.runLog.keepLines` は `~/.openclaw/cron/runs/<jobId>.jsonl` ファイルをプルーニングします（デフォルト: `2_000_000` バイトおよび `2000` 行）。

---

## セッションキー（`sessionKey`）

`sessionKey` は、_どの会話バケットにいるか_（ルーティング + 分離）を識別します。

一般的なパターン:

- メイン/ダイレクトチャット（エージェントごと）: `agent:<agentId>:<mainKey>`（デフォルト `main`）
- グループ: `agent:<agentId>:<channel>:group:<id>`
- ルーム/チャネル（Discord/Slack）: `agent:<agentId>:<channel>:channel:<id>` または `...:room:<id>`
- Cron: `cron:<job.id>`
- Webhook: `hook:<uuid>`（オーバーライドされない限り）

正式なルールは [/concepts/session](/concepts/session) に記載されています。

---

## セッションID（`sessionId`）

各 `sessionKey` は現在の `sessionId`（会話を継続するトランスクリプトファイル）を指します。

経験則:

- **リセット**（`/new`、`/reset`）は、その `sessionKey` に対して新しい `sessionId` を作成します。
- **デイリーリセット**（デフォルトはGateway ゲートウェイホストのローカル時間で午前4:00）は、リセット境界後の次のメッセージで新しい `sessionId` を作成します。
- **アイドル期限切れ**（`session.reset.idleMinutes` またはレガシーの `session.idleMinutes`）は、アイドルウィンドウ後にメッセージが到着すると新しい `sessionId` を作成します。デイリーとアイドルの両方が設定されている場合、先に期限切れになった方が優先されます。
- **スレッド親フォークガード**（`session.parentForkMaxTokens`、デフォルト `100000`）は、親セッションが既に大きすぎる場合に親トランスクリプトのフォークをスキップし、新しいスレッドはゼロから開始します。`0` に設定すると無効化されます。

実装の詳細: この判定は `src/auto-reply/reply/session.ts` の `initSessionState()` で行われます。

---

## セッションストアスキーマ（`sessions.json`）

ストアの値型は `src/config/sessions.ts` の `SessionEntry` です。

主要フィールド（すべてではありません）:

- `sessionId`: 現在のトランスクリプトID（`sessionFile` が設定されていない限り、ファイル名はここから導出されます）
- `updatedAt`: 最終アクティビティのタイムスタンプ
- `sessionFile`: オプションの明示的トランスクリプトパスオーバーライド
- `chatType`: `direct | group | room`（UIと送信ポリシーに役立つ）
- `provider`、`subject`、`room`、`space`、`displayName`: グループ/チャネルラベリング用メタデータ
- トグル:
  - `thinkingLevel`、`verboseLevel`、`reasoningLevel`、`elevatedLevel`
  - `sendPolicy`（セッションごとのオーバーライド）
- モデル選択:
  - `providerOverride`、`modelOverride`、`authProfileOverride`
- トークンカウンター（ベストエフォート / プロバイダー依存）:
  - `inputTokens`、`outputTokens`、`totalTokens`、`contextTokens`
- `compactionCount`: このセッションキーで自動コンパクションが完了した回数
- `memoryFlushAt`: 最後のコンパクション前メモリフラッシュのタイムスタンプ
- `memoryFlushCompactionCount`: 最後のフラッシュ実行時のコンパクションカウント

ストアは安全に編集できますが、Gateway ゲートウェイが権限を持ちます: セッション実行中にエントリを書き換えたり再ハイドレートしたりする場合があります。

---

## トランスクリプト構造（`*.jsonl`）

トランスクリプトは `@mariozechner/pi-coding-agent` の `SessionManager` によって管理されます。

ファイルはJSONL形式です:

- 最初の行: セッションヘッダー（`type: "session"`、`id`、`cwd`、`timestamp`、オプションの `parentSession` を含む）
- 以降: `id` + `parentId` を持つセッションエントリ（ツリー構造）

主なエントリタイプ:

- `message`: ユーザー/アシスタント/toolResultメッセージ
- `custom_message`: 拡張機能が注入したメッセージで、モデルコンテキストに_入る_（UIからは非表示にできる）
- `custom`: モデルコンテキストには_入らない_拡張機能の状態
- `compaction`: `firstKeptEntryId` と `tokensBefore` を持つ永続化されたコンパクションサマリー
- `branch_summary`: ツリーブランチをナビゲートする際の永続化されたサマリー

OpenClawは意図的にトランスクリプトを「修正」**しません**。Gateway ゲートウェイは `SessionManager` を使用してトランスクリプトの読み書きを行います。

---

## コンテキストウィンドウ vs 追跡トークン

2つの異なる概念が重要です:

1. **モデルコンテキストウィンドウ**: モデルごとのハードキャップ（モデルに見えるトークン数）
2. **セッションストアカウンター**: `sessions.json` に書き込まれるローリング統計（/statusやダッシュボードに使用）

制限を調整する場合:

- コンテキストウィンドウはモデルカタログから取得されます（設定でオーバーライド可能）。
- ストアの `contextTokens` はランタイムの推定値/レポート値です。厳密な保証としては扱わないでください。

詳細は [/token-use](/reference/token-use) を参照してください。

---

## コンパクション: その概要

コンパクションは、古い会話をトランスクリプト内の永続化された `compaction` エントリに要約し、最近のメッセージはそのまま保持します。

コンパクション後、将来のターンでは以下が表示されます:

- コンパクションサマリー
- `firstKeptEntryId` 以降のメッセージ

コンパクションは**永続的**です（セッションプルーニングとは異なります）。[/concepts/session-pruning](/concepts/session-pruning) を参照してください。

---

## 自動コンパクションが発生するタイミング（Piランタイム）

組み込みPiエージェントでは、自動コンパクションは2つのケースでトリガーされます:

1. **オーバーフローリカバリー**: モデルがコンテキストオーバーフローエラーを返す → コンパクション → リトライ。
2. **しきい値メンテナンス**: 成功したターンの後、以下の条件を満たす場合:

`contextTokens > contextWindow - reserveTokens`

各項目の説明:

- `contextWindow` はモデルのコンテキストウィンドウ
- `reserveTokens` はプロンプト + 次のモデル出力のために予約されるヘッドルーム

これらはPiランタイムのセマンティクスです（OpenClawはイベントを消費しますが、コンパクションのタイミングを決定するのはPiです）。

---

## コンパクション設定（`reserveTokens`、`keepRecentTokens`）

Piのコンパクション設定はPi設定内にあります:

```json5
{
  compaction: {
    enabled: true,
    reserveTokens: 16384,
    keepRecentTokens: 20000,
  },
}
```

OpenClawは組み込み実行に対して安全フロアも適用します:

- `compaction.reserveTokens < reserveTokensFloor` の場合、OpenClawが値を引き上げます。
- デフォルトのフロアは `20000` トークンです。
- `agents.defaults.compaction.reserveTokensFloor: 0` に設定するとフロアが無効化されます。
- 既に高い値が設定されている場合、OpenClawは変更しません。

理由: コンパクションが不可避になる前に、マルチターンの「ハウスキーピング」（メモリ書き込みなど）のために十分なヘッドルームを残すためです。

実装: `src/agents/pi-settings.ts` の `ensurePiCompactionReserveTokens()`
（`src/agents/pi-embedded-runner.ts` から呼び出されます）。

---

## ユーザーに表示されるサーフェス

コンパクションとセッション状態は以下で確認できます:

- `/status`（任意のチャットセッション内）
- `openclaw status`（CLI）
- `openclaw sessions` / `sessions --json`
- 詳細モード: `🧹 Auto-compaction complete` + コンパクションカウント

---

## サイレントハウスキーピング（`NO_REPLY`）

OpenClawは、ユーザーに中間出力を表示すべきでないバックグラウンドタスク用の「サイレント」ターンをサポートしています。

規約:

- アシスタントが出力を `NO_REPLY` で開始することで「ユーザーに返信を配信しない」ことを示します。
- OpenClawは配信レイヤーでこれを除去/抑制します。

`2026.1.10` 以降、OpenClawは部分チャンクが `NO_REPLY` で始まる場合に**下書き/タイピングストリーミング**も抑制するため、サイレント操作がターン途中で部分出力を漏らすことはありません。

---

## コンパクション前の「メモリフラッシュ」（実装済み）

目的: 自動コンパクションが発生する前に、サイレントなエージェントターンを実行して永続的な状態をディスクに書き込み（例: エージェントワークスペースの `memory/YYYY-MM-DD.md`）、コンパクションが重要なコンテキストを消去できないようにします。

OpenClawは**プレしきい値フラッシュ**アプローチを使用します:

1. セッションのコンテキスト使用量を監視。
2. 「ソフトしきい値」（Piのコンパクションしきい値より下）を超えた場合、エージェントに対してサイレントな「今すぐメモリを書き込む」ディレクティブを実行。
3. `NO_REPLY` を使用してユーザーには何も表示しない。

設定（`agents.defaults.compaction.memoryFlush`）:

- `enabled`（デフォルト: `true`）
- `softThresholdTokens`（デフォルト: `4000`）
- `prompt`（フラッシュターン用のユーザーメッセージ）
- `systemPrompt`（フラッシュターン用に追加されるシステムプロンプト）

注意事項:

- デフォルトのprompt/systemPromptには配信を抑制するための `NO_REPLY` ヒントが含まれています。
- フラッシュはコンパクションサイクルごとに1回実行されます（`sessions.json` で追跡）。
- フラッシュは組み込みPiセッションでのみ実行されます（CLIバックエンドではスキップされます）。
- セッションワークスペースが読み取り専用（`workspaceAccess: "ro"` または `"none"`）の場合、フラッシュはスキップされます。
- ワークスペースのファイルレイアウトと書き込みパターンについては [Memory](/concepts/memory) を参照してください。

Piは拡張APIで `session_before_compact` フックも公開していますが、OpenClawのフラッシュロジックは現在Gateway ゲートウェイ側にあります。

---

## トラブルシューティングチェックリスト

- セッションキーが間違っている？ [/concepts/session](/concepts/session) から始めて、`/status` で `sessionKey` を確認してください。
- ストアとトランスクリプトの不一致？ `openclaw status` からGateway ゲートウェイホストとストアパスを確認してください。
- コンパクションが頻繁に発生する？ 以下を確認:
  - モデルのコンテキストウィンドウ（小さすぎる場合）
  - コンパクション設定（`reserveTokens` がモデルウィンドウに対して高すぎると、より早くコンパクションが発生する可能性があります）
  - ツール結果の肥大化: セッションプルーニングを有効化/調整
- サイレントターンが漏れている？ 返信が `NO_REPLY`（正確なトークン）で始まっていること、およびストリーミング抑制修正を含むビルドを使用していることを確認してください。
