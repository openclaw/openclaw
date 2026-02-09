---
summary: "詳細解説: セッションストア + トランスクリプト、ライフサイクル、および（自動）コンパクションの内部"
read_when:
  - セッション id、トランスクリプト JSONL、または sessions.json フィールドをデバッグする必要がある場合
  - 自動コンパクションの挙動を変更している、または「コンパクション前」のハウスキーピングを追加する場合
  - メモリフラッシュやサイレントなシステムターンを実装したい場合
title: "セッション管理の詳細解説"
---

# セッション管理 & コンパクション（詳細解説）

このドキュメントでは、OpenClaw がセッションをエンドツーエンドで管理する方法を説明します。

- **セッションルーティング**（受信メッセージがどのように `sessionKey` にマップされるか）
- **セッションストア**（`sessions.json`）と、その追跡内容
- **トランスクリプトの永続化**（`*.jsonl`）と、その構造
- **トランスクリプトの衛生管理**（実行前のプロバイダー固有の修正）
- **コンテキスト制限**（コンテキストウィンドウと追跡トークンの違い）
- **コンパクション**（手動 + 自動コンパクション）と、コンパクション前作業をフックする場所
- **サイレントなハウスキーピング**（例: ユーザーに表示される出力を生成すべきでないメモリ書き込み）

まずは高レベルの概要を確認したい場合は、以下から始めてください。

- [/concepts/session](/concepts/session)
- [/concepts/compaction](/concepts/compaction)
- [/concepts/session-pruning](/concepts/session-pruning)
- [/reference/transcript-hygiene](/reference/transcript-hygiene)

---

## 真実の情報源: Gateway

OpenClaw は、セッション状態を所有する単一の **Gateway プロセス** を中心に設計されています。

- UI（macOS アプリ、Web Control UI、TUI）は、セッション一覧やトークン数を Gateway に問い合わせるべきです。
- リモートモードでは、セッションファイルはリモートホスト上にあります。「ローカルの Mac のファイルを確認する」だけでは、Gateway が使用している内容は反映されません。

---

## 2 つの永続化レイヤー

OpenClaw は、セッションを 2 つのレイヤーで永続化します。

1. **セッションストア（`sessions.json`）**
   - キー/値マップ: `sessionKey -> SessionEntry`
   - 小さく、可変で、編集（またはエントリ削除）しても安全
   - セッションメタデータ（現在のセッション id、最終アクティビティ、トグル、トークンカウンターなど）を追跡

2. **トランスクリプト（`<sessionId>.jsonl`）**
   - ツリー構造を持つ追記専用トランスクリプト（各エントリは `id` + `parentId` を持つ）
   - 実際の会話 + ツール呼び出し + コンパクション要約を保存
   - 将来のターンに向けてモデルコンテキストを再構築するために使用

---

## ディスク上の保存場所

Gateway ホスト上で、エージェントごとに保存されます。

- ストア: `~/.openclaw/agents/<agentId>/sessions/sessions.json`
- トランスクリプト: `~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl`
  - Telegram のトピックセッション: `.../<sessionId>-topic-<threadId>.jsonl`

OpenClaw は、`src/config/sessions.ts` を介してこれらを解決します。

---

## セッションキー（`sessionKey`）

`sessionKey` は、「どの会話バケットに属しているか」（ルーティング + 分離）を識別します。

一般的なパターン:

- メイン/ダイレクトチャット（エージェントごと）: `agent:<agentId>:<mainKey>`（デフォルトは `main`）
- グループ: `agent:<agentId>:<channel>:group:<id>`
- ルーム/チャンネル（Discord/Slack）: `agent:<agentId>:<channel>:channel:<id>` または `...:room:<id>`
- Cron: `cron:<job.id>`
- Webhook: `hook:<uuid>`（上書きされない限り）

正式なルールは [/concepts/session](/concepts/session) に記載されています。

---

## セッション id（`sessionId`）

各 `sessionKey` は、現在の `sessionId`（会話を継続するトランスクリプトファイル）を指します。

親指のルール:

- **リセット**（`/new`、`/reset`）は、その `sessionKey` に対して新しい `sessionId` を作成します。
- **日次リセット**（デフォルトは Gateway ホストのローカル時間で午前 4:00）は、リセット境界後の次のメッセージで新しい `sessionId` を作成します。
- **アイドル期限切れ**（`session.reset.idleMinutes` またはレガシーの `session.idleMinutes`）は、アイドルウィンドウ後にメッセージが到着した際に新しい `sessionId` を作成します。日次とアイドルの両方が設定されている場合、先に期限切れした方が優先されます。 毎日+アイドルが設定されている場合、いずれかの方が最初の勝利に失効します。

実装詳細: 判定は `src/auto-reply/reply/session.ts` 内の `initSessionState()` で行われます。

---

## セッションストアのスキーマ（`sessions.json`）

ストアの値型は、`src/config/sessions.ts` 内の `SessionEntry` です。

主なフィールド（網羅的ではありません）:

- `sessionId`: 現在のトランスクリプト id（`sessionFile` が設定されていない限り、ファイル名はこれから導出）
- `updatedAt`: 最終アクティビティのタイムスタンプ
- `sessionFile`: 任意の明示的なトランスクリプトパス上書き
- `chatType`: `direct | group | room`（UI や送信ポリシーに有用）
- `provider`, `subject`, `room`, `space`, `displayName`: グループ/チャンネルのラベリング用メタデータ
- Toggles:
  - `thinkingLevel`, `verboseLevel`, `reasoningLevel`, `elevatedLevel`
  - `sendPolicy`（セッション単位の上書き）
- モデル選択:
  - `providerOverride`, `modelOverride`, `authProfileOverride`
- トークンカウンター（ベストエフォート / プロバイダー依存）:
  - `inputTokens`, `outputTokens`, `totalTokens`, `contextTokens`
- `compactionCount`: このセッションキーで自動コンパクションが完了した回数
- `memoryFlushAt`: 直近のコンパクション前メモリフラッシュのタイムスタンプ
- `memoryFlushCompactionCount`: 最後のフラッシュ実行時のコンパクション回数

ストアは編集しても安全ですが、権威は Gateway にあります。セッション実行中にエントリが書き換えられたり、再水和されたりする場合があります。

---

## トランスクリプト構造（`*.jsonl`）

トランスクリプトは、`@mariozechner/pi-coding-agent` の `SessionManager` によって管理されます。

ファイル形式は JSONL です。

- 1 行目: セッションヘッダー（`type: "session"`、`id`、`cwd`、`timestamp`、任意で `parentSession` を含む）
- 以降: `id` + `parentId`（ツリー）を持つセッションエントリ

主なエントリタイプ:

- `message`: ユーザー/アシスタント/toolResult メッセージ
- `custom_message`: モデルコンテキストに「入る」拡張注入メッセージ（UI から非表示にできる）
- `custom`: モデルコンテキストに「入らない」拡張状態
- `compaction`: `firstKeptEntryId` と `tokensBefore` を持つ永続化されたコンパクション要約
- `branch_summary`: ツリーブランチ移動時の永続化サマリー

OpenClaw は、意図的にトランスクリプトを「修正」しません。Gateway は `SessionManager` を使用して読み書きします。

---

## コンテキストウィンドウ vs 追跡トークン

2つの異なる概念が重要です:

1. **モデルのコンテキストウィンドウ**: モデルごとのハード上限（モデルに見えるトークン数）
2. **セッションストアのカウンター**: `sessions.json` に書き込まれるローリング統計（/status やダッシュボードで使用）

制限を調整する場合:

- コンテキストウィンドウはモデルカタログに由来し、設定で上書きできます。
- ストア内の `contextTokens` は、実行時の推定/レポート値です。厳密な保証として扱わないでください。

詳細は [/token-use](/reference/token-use) を参照してください。

---

## Compaction: What is it

コンパクションは、古い会話をトランスクリプト内の永続化された `compaction` エントリに要約し、最近のメッセージを保持します。

圧縮後、今後のターン表示:

- コンパクション要約
- `firstKeptEntryId` 以降のメッセージ

Compaction is **persistent** (unlike session pruning). [/concepts/session-pruning](/concepts/session-pruning) を参照してください。

---

## 自動コンパクションが発生するタイミング（Pi ランタイム）

組み込み Pi エージェントでは、自動コンパクションは次の 2 つの場合に発生します。

1. **オーバーフロー回復**: モデルがコンテキストオーバーフローエラーを返す → コンパクション → 再試行。
2. **しきい値メンテナンス**: 成功したターンの後、次を満たした場合:

`contextTokens > contextWindow - reserveTokens`

ここで:

- `contextWindow` はモデルのコンテキストウィンドウ
- `reserveTokens` は、プロンプト + 次のモデル出力のために予約されるヘッドルーム

これらは Pi ランタイムのセマンティクスです（OpenClaw はイベントを消費しますが、コンパクションの判断は Pi が行います）。

---

## コンパクション設定（`reserveTokens`, `keepRecentTokens`）

Pi のコンパクション設定は、Pi 設定にあります。

```json5
{
  compaction: {
    enabled: true,
    reserveTokens: 16384,
    keepRecentTokens: 20000,
  },
}
```

OpenClaw は、組み込み実行に対して安全下限も適用します。

- `compaction.reserveTokens < reserveTokensFloor` の場合、OpenClaw が引き上げます。
- デフォルトの下限は `20000` トークンです。
- 下限を無効化するには `agents.defaults.compaction.reserveTokensFloor: 0` を設定します。
- すでに高い場合、OpenClaw は変更しません。

理由: コンパクションが不可避になる前に、メモリ書き込みのような複数ターンの「ハウスキーピング」を行うための十分なヘッドルームを確保するためです。

実装: `src/agents/pi-settings.ts` 内の `ensurePiCompactionReserveTokens()`
（`src/agents/pi-embedded-runner.ts` から呼び出されます）。

---

## ユーザーに見えるサーフェス

コンパクションやセッション状態は、次から観測できます。

- `/status`（任意のチャットセッション内）
- `openclaw status`（CLI）
- `openclaw sessions` / `sessions --json`
- 詳細モード: `🧹 Auto-compaction complete` + コンパクション回数

---

## サイレントなハウスキーピング（`NO_REPLY`）

OpenClaw は、ユーザーに中間出力を見せるべきでないバックグラウンドタスク向けに「サイレント」ターンをサポートします。

コンベンション:

- アシスタントは、出力の先頭に `NO_REPLY` を付けて「ユーザーに返信を配信しない」ことを示します。
- OpenClawストリップ/配信レイヤーでこれを抑制します。

`2026.1.10` 以降では、部分チャンクが `NO_REPLY` で始まる場合、**下書き/タイピングのストリーミング** も抑制されます。これにより、サイレント操作がターン途中で部分出力を漏らしません。

---

## コンパクション前の「メモリフラッシュ」（実装済み）

目的: 自動コンパクションが発生する前に、サイレントなエージェントターンを実行して、耐久的な状態をディスクに書き込み（例: エージェントワークスペース内の `memory/YYYY-MM-DD.md`）、コンパクションで重要なコンテキストが消えないようにします。

OpenClaw は **しきい値前フラッシュ** アプローチを使用します。

1. セッションのコンテキスト使用量を監視。
2. 「ソフトしきい値」（Pi のコンパクションしきい値より低い）を超えたら、エージェントにサイレントな「今すぐメモリを書き込め」指示を実行。
3. `NO_REPLY` を使用して、ユーザーには何も表示しません。

設定（`agents.defaults.compaction.memoryFlush`）:

- `enabled`（デフォルト: `true`）
- `softThresholdTokens`（デフォルト: `4000`）
- `prompt`（フラッシュターン用のユーザーメッセージ）
- `systemPrompt`（フラッシュターンに追加されるシステムプロンプト）

注記:

- デフォルトのプロンプト/システムプロンプトには、配信を抑制するための `NO_REPLY` ヒントが含まれています。
- フラッシュは、コンパクションサイクルごとに 1 回実行されます（`sessions.json` で追跡）。
- フラッシュは、組み込み Pi セッションでのみ実行されます（CLI バックエンドではスキップ）。
- セッションワークスペースが読み取り専用の場合（`workspaceAccess: "ro"` または `"none"`）、フラッシュはスキップされます。
- ワークスペースのファイルレイアウトと書き込みパターンについては [Memory](/concepts/memory) を参照してください。

Pi は拡張 API に `session_before_compact` フックも公開していますが、OpenClaw のフラッシュロジックは現時点では Gateway 側にあります。

---

## トラブルシューティング チェックリスト

- セッションキーが間違っていますか？ セッションキーが誤っている？ [/concepts/session](/concepts/session) から始め、`/status` 内の `sessionKey` を確認してください。
- ストアとトランスクリプトが一致しませんか？ ストアとトランスクリプトの不整合？ Gateway ホストと、`openclaw status` から取得したストアパスを確認してください。
- 圧縮スパム? 確認:
  - モデルのコンテキストウィンドウ（小さすぎないか）
  - コンパクション設定（モデルウィンドウに対して `reserveTokens` が高すぎると、早期にコンパクションが発生する可能性があります）
  - tool-result の肥大化: セッションプルーニングを有効化/調整してください
- 漏れるサイレントターン? サイレントターンが漏れる？ 返信が `NO_REPLY`（正確なトークン）で始まっていること、かつストリーミング抑制修正を含むビルドであることを確認してください。
