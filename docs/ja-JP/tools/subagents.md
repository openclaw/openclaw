---
summary: "サブエージェント: リクエスト元チャットに結果をアナウンスする分離されたエージェント実行のスポーン"
read_when:
  - エージェント経由のバックグラウンド・並列作業が必要な場合
  - sessions_spawn またはサブエージェントツールポリシーを変更する場合
  - スレッドバインドのサブエージェントセッションの実装またはトラブルシューティング
title: "サブエージェント"
---

# サブエージェント

サブエージェントは既存のエージェント実行からスポーンされるバックグラウンドエージェント実行です。独自のセッション（`agent:<agentId>:subagent:<uuid>`）で実行され、完了すると**アナウンス**によってリクエスト元のチャットチャンネルに結果を返します。

## スラッシュコマンド

`/subagents` を使用して**現在のセッション**のサブエージェント実行を検査または制御します:

- `/subagents list`
- `/subagents kill <id|#|all>`
- `/subagents log <id|#> [limit] [tools]`
- `/subagents info <id|#>`
- `/subagents send <id|#> <message>`
- `/subagents steer <id|#> <message>`
- `/subagents spawn <agentId> <task> [--model <model>] [--thinking <level>]`

スレッドバインドコントロール:

これらのコマンドは永続的なスレッドバインディングをサポートするチャンネルで機能します。以下の**スレッドサポートチャンネル**を参照してください。

- `/focus <subagent-label|session-key|session-id|session-label>`
- `/unfocus`
- `/agents`
- `/session idle <duration|off>`
- `/session max-age <duration|off>`

`/subagents info` は実行メタデータ（ステータス、タイムスタンプ、セッション id、トランスクリプトパス、クリーンアップ）を表示します。

### スポーンの動作

`/subagents spawn` は内部リレーではなくユーザーコマンドとしてバックグラウンドサブエージェントを起動し、実行完了時にリクエスト元のチャットに最終完了更新を 1 件送信します。

- スポーンコマンドはノンブロッキングで、実行 id を即座に返します。
- 完了時、サブエージェントはリクエスト元のチャットチャンネルにサマリー・結果メッセージをアナウンスします。
- 手動スポーンの場合、配信は弾力性があります:
  - OpenClaw は安定した冪等性キーで最初に直接の `agent` 配信を試みます。
  - 直接配信が失敗した場合、キュールーティングにフォールバックします。
  - キュールーティングがまだ利用可能でない場合、アナウンスは最終的な諦めの前に短い指数バックオフで再試行されます。
- 完了メッセージはシステムメッセージで以下を含みます:
  - `Result`（`assistant` 返信テキスト、またはアシスタント返信が空の場合は最新の `toolResult`）
  - `Status`（`completed successfully` / `failed` / `timed out`）
  - コンパクトなランタイム・トークン統計
- `--model` と `--thinking` はその特定の実行のデフォルトを上書きします。
- 完了後の詳細と出力の確認には `info`/`log` を使用してください。
- `/subagents spawn` はワンショットモード（`mode: "run"`）です。永続的なスレッドバインドセッションには、`thread: true` と `mode: "session"` で `sessions_spawn` を使用してください。
- ACP ハーネスセッション（Codex、Claude Code、Gemini CLI）には、`runtime: "acp"` で `sessions_spawn` を使用して [ACP エージェント](/tools/acp-agents) を参照してください。

主な目標:

- メインの実行をブロックせずに「リサーチ・長いタスク・遅いツール」の作業を並列化する。
- デフォルトでサブエージェントを分離する（セッション分離 + オプションのサンドボックス化）。
- ツールサーフェスの悪用を困難にする: サブエージェントはデフォルトでセッションツールを取得しません。
- オーケストレーターパターンのために設定可能なネスト深度をサポートする。

コストに関する注意: 各サブエージェントは**独自の**コンテキストとトークン使用量を持ちます。大量または繰り返しの
タスクには、サブエージェントには安価なモデルを設定し、メインエージェントには高品質なモデルを使用してください。
`agents.defaults.subagents.model` またはエージェントごとのオーバーライドで設定できます。

## ツール

`sessions_spawn` を使用します:

- サブエージェント実行を開始します（`deliver: false`、グローバルレーン: `subagent`）
- その後アナウンスステップを実行し、リクエスト元のチャットチャンネルにアナウンス返信を投稿します
- デフォルトモデル: `agents.defaults.subagents.model`（またはエージェントごとの `agents.list[].subagents.model`）が設定されていない限り、呼び出し元を継承します。明示的な `sessions_spawn.model` が常に優先されます。
- デフォルトのシンキング: `agents.defaults.subagents.thinking`（またはエージェントごとの `agents.list[].subagents.thinking`）が設定されていない限り、呼び出し元を継承します。明示的な `sessions_spawn.thinking` が常に優先されます。
- デフォルトの実行タイムアウト: `sessions_spawn.runTimeoutSeconds` が省略された場合、OpenClaw は `agents.defaults.subagents.runTimeoutSeconds` が設定されていればそれを使用します。設定されていない場合は `0`（タイムアウトなし）にフォールバックします。

ツールパラメーター:

- `task`（必須）
- `label?`（オプション）
- `agentId?`（オプション; 許可されている場合は別のエージェント id の下でスポーン）
- `model?`（オプション; サブエージェントモデルを上書き; 無効な値はスキップされ、サブエージェントはデフォルトモデルで実行されツール結果に警告が含まれます）
- `thinking?`（オプション; サブエージェント実行のシンキングレベルを上書き）
- `runTimeoutSeconds?`（設定されている場合は `agents.defaults.subagents.runTimeoutSeconds` にデフォルト、それ以外は `0`; 設定されている場合、N 秒後にサブエージェント実行を中止）
- `thread?`（デフォルト `false`; `true` の場合、このサブエージェントセッションのチャンネルスレッドバインディングをリクエスト）
- `mode?`（`run|session`）
  - デフォルトは `run`
  - `thread: true` で `mode` が省略された場合、デフォルトは `session` になります
  - `mode: "session"` には `thread: true` が必要
- `cleanup?`（`delete|keep`、デフォルト `keep`）

## スレッドバインドセッション

チャンネルのスレッドバインディングが有効な場合、サブエージェントはスレッドにバインドされ続けることができ、そのスレッド内のユーザーからのフォローアップメッセージが同じサブエージェントセッションにルーティングされます。

### スレッドサポートチャンネル

- Discord（現在サポートされている唯一のチャンネル）: 永続的なスレッドバインドサブエージェントセッション（`thread: true` で `sessions_spawn`）、手動スレッドコントロール（`/focus`、`/unfocus`、`/agents`、`/session idle`、`/session max-age`）、アダプターキー `channels.discord.threadBindings.enabled`、`channels.discord.threadBindings.idleHours`、`channels.discord.threadBindings.maxAgeHours`、`channels.discord.threadBindings.spawnSubagentSessions` をサポートします。

クイックフロー:

1. `thread: true`（およびオプションで `mode: "session"`）を使用して `sessions_spawn` でスポーンします。
2. OpenClaw はアクティブなチャンネルのそのセッションターゲットにスレッドを作成またはバインドします。
3. そのスレッド内の返信とフォローアップメッセージはバインドされたセッションにルーティングされます。
4. `/session idle` で非アクティブ自動アンフォーカスを確認・更新し、`/session max-age` でハードキャップを制御します。
5. `/unfocus` で手動でデタッチします。

手動コントロール:

- `/focus <target>` は現在のスレッド（または新しいスレッド）をサブエージェント・セッションターゲットにバインドします。
- `/unfocus` は現在のバインドされたスレッドのバインディングを削除します。
- `/agents` はアクティブな実行とバインディング状態（`thread:<id>` または `unbound`）を一覧表示します。
- `/session idle` と `/session max-age` はフォーカスされたバインドスレッドにのみ機能します。

設定スイッチ:

- グローバルデフォルト: `session.threadBindings.enabled`、`session.threadBindings.idleHours`、`session.threadBindings.maxAgeHours`
- チャンネルオーバーライドとスポーン自動バインドキーはアダプター固有です。上記の**スレッドサポートチャンネル**を参照してください。

詳細なアダプター情報については [設定リファレンス](/gateway/configuration-reference) と [スラッシュコマンド](/tools/slash-commands) を参照してください。

アローリスト:

- `agents.list[].subagents.allowAgents`: `agentId` 経由でターゲットにできるエージェント id のリスト（任意を許可するには `["*"]`）。デフォルト: リクエスト元エージェントのみ。

検出:

- `agents_list` を使用して `sessions_spawn` で現在許可されているエージェント id を確認します。

自動アーカイブ:

- サブエージェントセッションは `agents.defaults.subagents.archiveAfterMinutes`（デフォルト: 60）後に自動的にアーカイブされます。
- アーカイブは `sessions.delete` を使用し、トランスクリプトを `*.deleted.<timestamp>` に名前変更します（同じフォルダー）。
- `cleanup: "delete"` はアナウンス直後に即座にアーカイブします（名前変更によりトランスクリプトは保持されます）。
- 自動アーカイブはベストエフォートです。保留中のタイマーは gateway が再起動すると失われます。
- `runTimeoutSeconds` は自動アーカイブしません。実行を停止するだけです。セッションは自動アーカイブまで残ります。
- 自動アーカイブは深度 1 と深度 2 のセッションに等しく適用されます。

## ネストされたサブエージェント

デフォルトでは、サブエージェントは独自のサブエージェントをスポーンできません（`maxSpawnDepth: 1`）。`maxSpawnDepth: 2` を設定することで 1 レベルのネストを有効にできます。これにより**オーケストレーターパターン**が可能になります: メイン → オーケストレーターサブエージェント → ワーカーサブサブエージェント。

### 有効化方法

```json5
{
  agents: {
    defaults: {
      subagents: {
        maxSpawnDepth: 2, // サブエージェントが子をスポーンできるようにする（デフォルト: 1）
        maxChildrenPerAgent: 5, // エージェントセッションごとのアクティブな子の最大数（デフォルト: 5）
        maxConcurrent: 8, // グローバル同時実行レーンキャップ（デフォルト: 8）
        runTimeoutSeconds: 900, // 省略した場合の sessions_spawn のデフォルトタイムアウト（0 = タイムアウトなし）
      },
    },
  },
}
```

### 深度レベル

| 深度 | セッションキーの形状                         | 役割                                              | スポーン可能?                    |
| ---- | -------------------------------------------- | ------------------------------------------------- | -------------------------------- |
| 0    | `agent:<id>:main`                            | メインエージェント                                | 常に可能                         |
| 1    | `agent:<id>:subagent:<uuid>`                 | サブエージェント（深度 2 が許可される場合はオーケストレーター） | `maxSpawnDepth >= 2` の場合のみ |
| 2    | `agent:<id>:subagent:<uuid>:subagent:<uuid>` | サブサブエージェント（リーフワーカー）            | 不可                             |

### アナウンスチェーン

結果はチェーンを遡って流れます:

1. 深度 2 のワーカーが完了 → 親（深度 1 のオーケストレーター）にアナウンス
2. 深度 1 のオーケストレーターがアナウンスを受け取り、結果を統合して完了 → メインにアナウンス
3. メインエージェントがアナウンスを受け取り、ユーザーに配信

各レベルは直接の子からのアナウンスのみを確認します。

### 深度別ツールポリシー

- **深度 1（オーケストレーター、`maxSpawnDepth >= 2` の場合）**: 子を管理できるように `sessions_spawn`、`subagents`、`sessions_list`、`sessions_history` を取得します。他のセッション・システムツールは拒否されたままです。
- **深度 1（リーフ、`maxSpawnDepth == 1` の場合）**: セッションツールなし（現在のデフォルト動作）。
- **深度 2（リーフワーカー）**: セッションツールなし — `sessions_spawn` は深度 2 では常に拒否されます。さらなる子のスポーンは不可能です。

### エージェントごとのスポーン制限

各エージェントセッション（どの深度でも）は、一度に最大 `maxChildrenPerAgent`（デフォルト: 5）のアクティブな子を持てます。これにより、単一のオーケストレーターからの暴走的なファンアウトを防ぎます。

### カスケード停止

深度 1 のオーケストレーターを停止すると、すべての深度 2 の子が自動的に停止されます:

- メインチャットの `/stop` はすべての深度 1 エージェントを停止し、深度 2 の子にカスケードします。
- `/subagents kill <id>` は特定のサブエージェントを停止し、その子にカスケードします。
- `/subagents kill all` はリクエスト元のすべてのサブエージェントを停止し、カスケードします。

## 認証

サブエージェントの認証はセッションタイプではなく**エージェント id**によって解決されます:

- サブエージェントセッションキーは `agent:<agentId>:subagent:<uuid>` です。
- 認証ストアはそのエージェントの `agentDir` からロードされます。
- メインエージェントの認証プロファイルは**フォールバック**としてマージされます。競合時はエージェントプロファイルがメインプロファイルを上書きします。

注: マージは追加的なので、メインプロファイルは常にフォールバックとして利用可能です。エージェントごとの完全に分離された認証はまだサポートされていません。

## アナウンス

サブエージェントはアナウンスステップを通じて報告します:

- アナウンスステップはサブエージェントセッション内で実行されます（リクエスト元セッションではありません）。
- サブエージェントが正確に `ANNOUNCE_SKIP` と返信した場合、何も投稿されません。
- それ以外の場合、アナウンス返信はフォローアップの `agent` 呼び出し（`deliver=true`）を通じてリクエスト元のチャットチャンネルに投稿されます。
- アナウンス返信は、チャンネルアダプターで利用可能な場合にスレッド・トピックルーティングを保持します。
- アナウンスメッセージは安定したテンプレートに正規化されます:
  - `Status:` 実行結果から導出（`success`、`error`、`timeout`、または `unknown`）。
  - `Result:` アナウンスステップからのサマリーコンテンツ（不足している場合は `(not available)`）。
  - `Notes:` エラーの詳細とその他の有用なコンテキスト。
- `Status` はモデル出力から推測されません。ランタイム結果シグナルから来ます。

アナウンスペイロードには最後に統計行が含まれます（ラップされた場合でも）:

- ランタイム（例: `runtime 5m12s`）
- トークン使用状況（入力/出力/合計）
- モデル価格が設定されている場合の推定コスト（`models.providers.*.models[].cost`）
- `sessionKey`、`sessionId`、トランスクリプトパス（メインエージェントが `sessions_history` で履歴を取得したり、ディスク上のファイルを検査したりできるように）

## ツールポリシー（サブエージェントツール）

デフォルトでは、サブエージェントはセッションツールとシステムツールを除く**すべてのツール**を取得します:

- `sessions_list`
- `sessions_history`
- `sessions_send`
- `sessions_spawn`

`maxSpawnDepth >= 2` の場合、深度 1 のオーケストレーターサブエージェントは子を管理できるように追加で `sessions_spawn`、`subagents`、`sessions_list`、`sessions_history` を受け取ります。

設定でオーバーライド:

```json5
{
  agents: {
    defaults: {
      subagents: {
        maxConcurrent: 1,
      },
    },
  },
  tools: {
    subagents: {
      tools: {
        // deny が優先
        deny: ["gateway", "cron"],
        // allow が設定されている場合、allow のみになります（deny は引き続き優先）
        // allow: ["read", "exec", "process"]
      },
    },
  },
}
```

## 同時実行

サブエージェントは専用のインプロセスキューレーンを使用します:

- レーン名: `subagent`
- 同時実行数: `agents.defaults.subagents.maxConcurrent`（デフォルト `8`）

## 停止

- リクエスト元チャットで `/stop` を送信すると、リクエスト元セッションを中止し、そこからスポーンされたアクティブなサブエージェント実行を停止して、ネストされた子にカスケードします。
- `/subagents kill <id>` は特定のサブエージェントを停止し、その子にカスケードします。

## 制限事項

- サブエージェントのアナウンスは**ベストエフォート**です。gateway が再起動すると、保留中の「アナウンスバック」作業は失われます。
- サブエージェントは引き続き同じ gateway プロセスリソースを共有します。`maxConcurrent` はセーフティバルブとして扱ってください。
- `sessions_spawn` は常にノンブロッキングです: 即座に `{ status: "accepted", runId, childSessionKey }` を返します。
- サブエージェントコンテキストは `AGENTS.md` + `TOOLS.md` のみを注入します（`SOUL.md`、`IDENTITY.md`、`USER.md`、`HEARTBEAT.md`、`BOOTSTRAP.md` は注入しません）。
- 最大ネスト深度は 5 です（`maxSpawnDepth` の範囲: 1〜5）。ほとんどのユースケースには深度 2 が推奨されます。
- `maxChildrenPerAgent` はセッションごとのアクティブな子の数を制限します（デフォルト: 5、範囲: 1〜20）。
