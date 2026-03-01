---
summary: "OpenClaw のエージェントツールサーフェス（ブラウザ、キャンバス、ノード、メッセージ、cron）。レガシーの `openclaw-*` スキルを置き換えます"
read_when:
  - エージェントツールの追加または変更
  - `openclaw-*` スキルの廃止または変更
title: "ツール"
---

# ツール (OpenClaw)

OpenClaw はブラウザ、キャンバス、ノード、cron 向けの**ファーストクラスのエージェントツール**を提供しています。
これらは古い `openclaw-*` スキルを置き換えるものです。ツールは型付きで、シェル実行を必要とせず、
エージェントは直接これらに依存できます。

## ツールの無効化

`openclaw.json` の `tools.allow` / `tools.deny` でツールをグローバルに許可・拒否できます
（deny が優先されます）。これにより、許可されていないツールがモデルプロバイダーに送信されなくなります。

```json5
{
  tools: { deny: ["browser"] },
}
```

注意事項:

- マッチングは大文字・小文字を区別しません。
- `*` ワイルドカードがサポートされています（`"*"` はすべてのツールを意味します）。
- `tools.allow` が未知またはロードされていないプラグインツール名のみを参照している場合、OpenClaw は警告をログに記録してアローリストを無視し、コアツールを利用可能な状態に保ちます。

## ツールプロファイル（ベースアローリスト）

`tools.profile` は `tools.allow`/`tools.deny` の前に**ベースのツールアローリスト**を設定します。
エージェントごとのオーバーライド: `agents.list[].tools.profile`。

プロファイル:

- `minimal`: `session_status` のみ
- `coding`: `group:fs`, `group:runtime`, `group:sessions`, `group:memory`, `image`
- `messaging`: `group:messaging`, `sessions_list`, `sessions_history`, `sessions_send`, `session_status`
- `full`: 制限なし（未設定と同じ）

例（デフォルトでメッセージングのみ、Slack と Discord のツールも許可）:

```json5
{
  tools: {
    profile: "messaging",
    allow: ["slack", "discord"],
  },
}
```

例（コーディングプロファイル、ただし exec/process はすべて拒否）:

```json5
{
  tools: {
    profile: "coding",
    deny: ["group:runtime"],
  },
}
```

例（グローバルコーディングプロファイル、メッセージングのみのサポートエージェント）:

```json5
{
  tools: { profile: "coding" },
  agents: {
    list: [
      {
        id: "support",
        tools: { profile: "messaging", allow: ["slack"] },
      },
    ],
  },
}
```

## プロバイダー固有のツールポリシー

`tools.byProvider` を使用して、グローバルのデフォルトを変更せずに特定のプロバイダー
（または単一の `provider/model`）のツールを**さらに制限**できます。
エージェントごとのオーバーライド: `agents.list[].tools.byProvider`。

これはベースのツールプロファイルの**後**、許可・拒否リストの**前**に適用されるため、
ツールセットを絞り込む方向にのみ機能します。
プロバイダーキーには `provider`（例: `google-antigravity`）または
`provider/model`（例: `openai/gpt-5.2`）のどちらも使用できます。

例（グローバルコーディングプロファイルを維持しつつ、Google Antigravity にはミニマルツールのみ）:

```json5
{
  tools: {
    profile: "coding",
    byProvider: {
      "google-antigravity": { profile: "minimal" },
    },
  },
}
```

例（不安定なエンドポイント向けの provider/model 固有アローリスト）:

```json5
{
  tools: {
    allow: ["group:fs", "group:runtime", "sessions_list"],
    byProvider: {
      "openai/gpt-5.2": { allow: ["group:fs", "sessions_list"] },
    },
  },
}
```

例（単一プロバイダーに対するエージェント固有のオーバーライド）:

```json5
{
  agents: {
    list: [
      {
        id: "support",
        tools: {
          byProvider: {
            "google-antigravity": { allow: ["message", "sessions_list"] },
          },
        },
      },
    ],
  },
}
```

## ツールグループ（省略表記）

ツールポリシー（グローバル、エージェント、サンドボックス）は、複数のツールに展開される `group:*` エントリをサポートしています。
`tools.allow` / `tools.deny` で使用してください。

利用可能なグループ:

- `group:runtime`: `exec`, `bash`, `process`
- `group:fs`: `read`, `write`, `edit`, `apply_patch`
- `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory`: `memory_search`, `memory_get`
- `group:web`: `web_search`, `web_fetch`
- `group:ui`: `browser`, `canvas`
- `group:automation`: `cron`, `gateway`
- `group:messaging`: `message`
- `group:nodes`: `nodes`
- `group:openclaw`: すべての組み込み OpenClaw ツール（プロバイダープラグインを除く）

例（ファイルツールとブラウザのみ許可）:

```json5
{
  tools: {
    allow: ["group:fs", "browser"],
  },
}
```

## プラグインとツール

プラグインはコアセットを超えた**追加ツール**（および CLI コマンド）を登録できます。
インストールと設定については [プラグイン](/tools/plugin) を、ツール使用ガイダンスがプロンプトに
どのように注入されるかについては [スキル](/tools/skills) を参照してください。
一部のプラグインはツールと合わせて独自のスキルを提供しています（例: voice-call プラグイン）。

オプションのプラグインツール:

- [Lobster](/tools/lobster): 再開可能な承認機能を持つ型付きワークフローランタイム（Gateway ホストに Lobster CLI が必要）。
- [LLM Task](/tools/llm-task): 構造化されたワークフロー出力向けの JSON のみの LLM ステップ（オプションのスキーマ検証付き）。
- [Diffs](/tools/diffs): テキストや統合パッチの変更前後を表示する読み取り専用の差分ビューアおよび PNG レンダラー。

## ツール一覧

### `apply_patch`

1 つまたは複数のファイルに構造化されたパッチを適用します。マルチハンク編集に使用します。
実験的: `tools.exec.applyPatch.enabled` で有効化します（OpenAI モデルのみ）。
`tools.exec.applyPatch.workspaceOnly` はデフォルトで `true`（ワークスペース内のみ）です。ワークスペースディレクトリ外への書き込み・削除を意図的に許可する場合のみ `false` に設定してください。

### `exec`

ワークスペース内でシェルコマンドを実行します。

主なパラメーター:

- `command`（必須）
- `yieldMs`（タイムアウト後にバックグラウンドへ自動移行、デフォルト 10000）
- `background`（即時バックグラウンド）
- `timeout`（秒数; 超過した場合にプロセスを強制終了、デフォルト 1800）
- `elevated`（bool; 昇格モードが有効・許可されている場合にホストで実行; エージェントがサンドボックス化されている場合のみ動作が変わります）
- `host`（`sandbox | gateway | node`）
- `security`（`deny | allowlist | full`）
- `ask`（`off | on-miss | always`）
- `node`（`host=node` の場合のノード id/name）
- 本物の TTY が必要な場合は `pty: true` を設定してください。

注意事項:

- バックグラウンド実行時は `sessionId` とともに `status: "running"` を返します。
- `process` を使用してバックグラウンドセッションのポーリング・ログ・書き込み・強制終了・クリアを行います。
- `process` が許可されていない場合、`exec` は同期的に実行され、`yieldMs`/`background` は無視されます。
- `elevated` は `tools.elevated` および `agents.list[].tools.elevated` オーバーライド（両方が許可する必要があります）によりゲートされており、`host=gateway` + `security=full` のエイリアスです。
- `elevated` はエージェントがサンドボックス化されている場合にのみ動作が変わります（それ以外では無操作です）。
- `host=node` は macOS コンパニオンアプリまたはヘッドレスノードホスト（`openclaw node run`）をターゲットにできます。
- gateway/node の承認とアローリスト: [Exec approvals](/tools/exec-approvals)。

### `process`

バックグラウンドの exec セッションを管理します。

主なアクション:

- `list`, `poll`, `log`, `write`, `kill`, `clear`, `remove`

注意事項:

- `poll` は新しい出力と完了時の終了ステータスを返します。
- `log` は行ベースの `offset`/`limit` をサポートします（`offset` を省略すると最後の N 行を取得します）。
- `process` はエージェントごとにスコープされます。他のエージェントのセッションは表示されません。

### `loop-detection`（ツールコールループのガードレール）

OpenClaw は最近のツールコール履歴を追跡し、進捗のない繰り返しループを検出するとブロックまたは警告します。
`tools.loopDetection.enabled: true` で有効化します（デフォルトは `false`）。

```json5
{
  tools: {
    loopDetection: {
      enabled: true,
      warningThreshold: 10,
      criticalThreshold: 20,
      globalCircuitBreakerThreshold: 30,
      historySize: 30,
      detectors: {
        genericRepeat: true,
        knownPollNoProgress: true,
        pingPong: true,
      },
    },
  },
}
```

- `genericRepeat`: 同じツールと同じパラメーターの繰り返し呼び出しパターン。
- `knownPollNoProgress`: 同一の出力を持つポーリング系ツールの繰り返し。
- `pingPong`: 進捗のない `A/B/A/B` の交互パターン。
- エージェントごとのオーバーライド: `agents.list[].tools.loopDetection`。

### `web_search`

Brave Search API を使用してウェブを検索します。

主なパラメーター:

- `query`（必須）
- `count`（1〜10; デフォルトは `tools.web.search.maxResults`）

注意事項:

- Brave API キーが必要です（推奨: `openclaw configure --section web`、または `BRAVE_API_KEY` を設定）。
- `tools.web.search.enabled` で有効化します。
- レスポンスはキャッシュされます（デフォルト 15 分）。
- セットアップについては [Web ツール](/tools/web) を参照してください。

### `web_fetch`

URL から読み取り可能なコンテンツを取得・抽出します（HTML → markdown/テキスト）。

主なパラメーター:

- `url`（必須）
- `extractMode`（`markdown` | `text`）
- `maxChars`（長いページを切り詰める）

注意事項:

- `tools.web.fetch.enabled` で有効化します。
- `maxChars` は `tools.web.fetch.maxCharsCap`（デフォルト 50000）で上限が設定されます。
- レスポンスはキャッシュされます（デフォルト 15 分）。
- JavaScript が多いサイトにはブラウザツールを使用してください。
- セットアップについては [Web ツール](/tools/web) を参照してください。
- オプションのアンチボットフォールバックについては [Firecrawl](/tools/firecrawl) を参照してください。

### `browser`

OpenClaw が管理する専用ブラウザを操作します。

主なアクション:

- `status`, `start`, `stop`, `tabs`, `open`, `focus`, `close`
- `snapshot`（aria/ai）
- `screenshot`（画像ブロック + `MEDIA:<path>` を返す）
- `act`（UI アクション: click/type/press/hover/drag/select/fill/resize/wait/evaluate）
- `navigate`, `console`, `pdf`, `upload`, `dialog`

プロファイル管理:

- `profiles` — すべてのブラウザプロファイルをステータスとともに一覧表示
- `create-profile` — 自動割り当てポート（または `cdpUrl`）で新しいプロファイルを作成
- `delete-profile` — ブラウザを停止し、ユーザーデータを削除して設定から削除（ローカルのみ）
- `reset-profile` — プロファイルのポート上の孤立プロセスを強制終了（ローカルのみ）

共通パラメーター:

- `profile`（オプション; デフォルトは `browser.defaultProfile`）
- `target`（`sandbox` | `host` | `node`）
- `node`（オプション; 特定のノード id/name を指定）
  注意事項:
- `browser.enabled=true` が必要です（デフォルトは `true`; 無効化するには `false` を設定）。
- すべてのアクションがマルチインスタンスサポートのためにオプションの `profile` パラメーターを受け付けます。
- `profile` が省略された場合、`browser.defaultProfile`（デフォルトは "chrome"）を使用します。
- プロファイル名: 小文字英数字とハイフンのみ（最大 64 文字）。
- ポート範囲: 18800〜18899（最大約 100 プロファイル）。
- リモートプロファイルはアタッチのみ（start/stop/reset 不可）。
- ブラウザ対応ノードが接続されている場合、ツールは自動的にそのノードにルーティングする場合があります（`target` を固定しない限り）。
- Playwright がインストールされている場合、`snapshot` はデフォルトで `ai` を使用します。アクセシビリティツリーには `aria` を使用してください。
- `snapshot` はロールスナップショットオプション（`interactive`, `compact`, `depth`, `selector`）もサポートし、`e12` のような参照を返します。
- `act` には `snapshot` からの `ref` が必要です（AI スナップショットからは数値 `12`、ロールスナップショットからは `e12`）。CSS セレクターが必要な場合は `evaluate` を使用してください。
- デフォルトでは `act` → `wait` を避けてください。信頼できる UI 状態が待機できない例外的なケースにのみ使用してください。
- `upload` はアーミング後に自動クリックするために `ref` をオプションで渡せます。
- `upload` は `<input type="file">` を直接設定するために `inputRef`（aria 参照）または `element`（CSS セレクター）もサポートします。

### `canvas`

ノードのキャンバスを操作します（present、eval、snapshot、A2UI）。

主なアクション:

- `present`, `hide`, `navigate`, `eval`
- `snapshot`（画像ブロック + `MEDIA:<path>` を返す）
- `a2ui_push`, `a2ui_reset`

注意事項:

- 内部的に gateway の `node.invoke` を使用します。
- `node` が指定されていない場合、ツールはデフォルト（単一の接続ノードまたはローカル mac ノード）を選択します。
- A2UI は v0.8 のみ（`createSurface` なし）; CLI は v0.9 JSONL を行エラーで拒否します。
- クイックスモーク: `openclaw nodes canvas a2ui push --node <id> --text "Hello from A2UI"`。

### `nodes`

ペアリングされたノードを検出してターゲットにします。通知の送信やカメラ・画面のキャプチャを行います。

主なアクション:

- `status`, `describe`
- `pending`, `approve`, `reject`（ペアリング）
- `notify`（macOS `system.notify`）
- `run`（macOS `system.run`）
- `camera_list`, `camera_snap`, `camera_clip`, `screen_record`
- `location_get`, `notifications_list`, `notifications_action`
- `device_status`, `device_info`, `device_permissions`, `device_health`

注意事項:

- カメラ/画面コマンドにはノードアプリがフォアグラウンドである必要があります。
- 画像は画像ブロック + `MEDIA:<path>` を返します。
- 動画は `FILE:<path>`（mp4）を返します。
- 位置情報は JSON ペイロード（lat/lon/accuracy/timestamp）を返します。
- `run` のパラメーター: `command` argv 配列; オプションの `cwd`, `env`（`KEY=VAL`）, `commandTimeoutMs`, `invokeTimeoutMs`, `needsScreenRecording`。

例（`run`）:

```json
{
  "action": "run",
  "node": "office-mac",
  "command": ["echo", "Hello"],
  "env": ["FOO=bar"],
  "commandTimeoutMs": 12000,
  "invokeTimeoutMs": 45000,
  "needsScreenRecording": false
}
```

### `image`

設定されたイメージモデルで画像を解析します。

主なパラメーター:

- `image`（必須パスまたは URL）
- `prompt`（オプション; デフォルトは "Describe the image."）
- `model`（オプションのオーバーライド）
- `maxBytesMb`（オプションのサイズ上限）

注意事項:

- `agents.defaults.imageModel` が設定されている場合（プライマリまたはフォールバック）、またはデフォルトモデルと設定済みの認証からイメージモデルを暗黙的に推論できる場合にのみ利用可能です（ベストエフォートのペアリング）。
- メインのチャットモデルとは独立して、イメージモデルを直接使用します。

### `message`

Discord/Google Chat/Slack/Telegram/WhatsApp/Signal/iMessage/MS Teams 間でメッセージとチャンネルアクションを送信します。

主なアクション:

- `send`（テキスト + オプションメディア; MS Teams は Adaptive Cards 向けに `card` もサポート）
- `poll`（WhatsApp/Discord/MS Teams のポール）
- `react` / `reactions` / `read` / `edit` / `delete`
- `pin` / `unpin` / `list-pins`
- `permissions`
- `thread-create` / `thread-list` / `thread-reply`
- `search`
- `sticker`
- `member-info` / `role-info`
- `emoji-list` / `emoji-upload` / `sticker-upload`
- `role-add` / `role-remove`
- `channel-info` / `channel-list`
- `voice-status`
- `event-list` / `event-create`
- `timeout` / `kick` / `ban`

注意事項:

- `send` は WhatsApp を Gateway 経由でルーティングします。他のチャンネルは直接送信します。
- `poll` は WhatsApp と MS Teams に Gateway を使用します。Discord のポールは直接送信します。
- メッセージツールコールがアクティブなチャットセッションにバインドされている場合、送信はクロスコンテキストの漏洩を避けるためにそのセッションのターゲットに制限されます。

### `cron`

Gateway の cron ジョブとウェイクアップを管理します。

主なアクション:

- `status`, `list`
- `add`, `update`, `remove`, `run`, `runs`
- `wake`（システムイベントのエンキュー + オプションの即時ハートビート）

注意事項:

- `add` はフルの cron ジョブオブジェクトを期待します（`cron.add` RPC と同じスキーマ）。
- `update` は `{ jobId, patch }` を使用します（互換性のために `id` も受け付けます）。

### `gateway`

実行中の Gateway プロセスを再起動またはインプレースで更新を適用します。

主なアクション:

- `restart`（認可 + インプロセス再起動のために `SIGUSR1` を送信; `openclaw gateway` をインプレースで再起動）
- `config.get` / `config.schema`
- `config.apply`（設定の検証・書き込み・再起動・ウェイク）
- `config.patch`（部分的な更新のマージ・再起動・ウェイク）
- `update.run`（更新の実行・再起動・ウェイク）

注意事項:

- インフライトの返信を中断しないために `delayMs`（デフォルト 2000）を使用してください。
- `restart` はデフォルトで有効です。無効化するには `commands.restart: false` を設定してください。

### `sessions_list` / `sessions_history` / `sessions_send` / `sessions_spawn` / `session_status`

セッションの一覧表示、トランスクリプト履歴の検査、または別のセッションへの送信を行います。

主なパラメーター:

- `sessions_list`: `kinds?`, `limit?`, `activeMinutes?`, `messageLimit?`（0 = なし）
- `sessions_history`: `sessionKey`（または `sessionId`）, `limit?`, `includeTools?`
- `sessions_send`: `sessionKey`（または `sessionId`）, `message`, `timeoutSeconds?`（0 = ファイアアンドフォーゲット）
- `sessions_spawn`: `task`, `label?`, `runtime?`, `agentId?`, `model?`, `thinking?`, `cwd?`, `runTimeoutSeconds?`, `thread?`, `mode?`, `cleanup?`
- `session_status`: `sessionKey?`（デフォルトは現在のセッション; `sessionId` も受け付けます）, `model?`（`default` でオーバーライドをクリア）

注意事項:

- `main` は正規のダイレクトチャットキーです。グローバル/不明なものは非表示になります。
- `messageLimit > 0` はセッションごとに最後の N メッセージを取得します（ツールメッセージはフィルタリングされます）。
- セッションのターゲティングは `tools.sessions.visibility`（デフォルト `tree`: 現在のセッション + 生成されたサブエージェントセッション）によって制御されます。複数のユーザーに共有エージェントを実行する場合は、クロスセッションの閲覧を防ぐために `tools.sessions.visibility: "self"` の設定を検討してください。
- `sessions_send` は `timeoutSeconds > 0` の場合に最終完了を待機します。
- 配信・アナウンスは完了後にベストエフォートで行われます。`status: "ok"` はエージェント実行が終了したことを確認するものであり、アナウンスが配信されたことを確認するものではありません。
- `sessions_spawn` は `runtime: "subagent" | "acp"`（デフォルトは `subagent`）をサポートします。ACP ランタイムの動作については [ACP エージェント](/tools/acp-agents) を参照してください。
- `sessions_spawn` はサブエージェント実行を開始し、完了後にリクエスト元のチャットにアナウンス返信を投稿します。
  - ワンショットモード（`mode: "run"`）と永続スレッドバインドモード（`thread: true` で `mode: "session"`）をサポートします。
  - `thread: true` で `mode` が省略された場合、mode はデフォルトで `session` になります。
  - `mode: "session"` は `thread: true` が必要です。
  - `runTimeoutSeconds` が省略された場合、OpenClaw は `agents.defaults.subagents.runTimeoutSeconds` が設定されていればそれを使用します。設定されていない場合はタイムアウトはデフォルトで `0`（タイムアウトなし）になります。
  - Discord のスレッドバインドフローは `session.threadBindings.*` と `channels.discord.threadBindings.*` に依存します。
  - 返信形式には `Status`、`Result`、コンパクトな統計情報が含まれます。
  - `Result` はアシスタントの完了テキストです。不足している場合は、最新の `toolResult` がフォールバックとして使用されます。
- 手動完了モードのスポーンは最初に直接送信し、キューフォールバックと一時的な障害への再試行を行います（`status: "ok"` は実行が終了したことを意味し、アナウンスが配信されたことを意味しません）。
- `sessions_spawn` はノンブロッキングで、即座に `status: "accepted"` を返します。
- `sessions_send` は返信のピンポンを実行します（`REPLY_SKIP` で停止; 最大ターン数は `session.agentToAgent.maxPingPongTurns`、0〜5）。
- ピンポンの後、ターゲットエージェントは**アナウンスステップ**を実行します。`ANNOUNCE_SKIP` でアナウンスを抑制できます。
- サンドボックスクランプ: 現在のセッションがサンドボックス化されており、`agents.defaults.sandbox.sessionToolsVisibility: "spawned"` の場合、OpenClaw は `tools.sessions.visibility` を `tree` にクランプします。

### `agents_list`

現在のセッションが `sessions_spawn` でターゲットにできるエージェント id を一覧表示します。

注意事項:

- 結果はエージェントごとのアローリスト（`agents.list[].subagents.allowAgents`）に制限されます。
- `["*"]` が設定されている場合、ツールはすべての設定済みエージェントを含み、`allowAny: true` とマークします。

## パラメーター（共通）

Gateway バックエンドのツール（`canvas`, `nodes`, `cron`）:

- `gatewayUrl`（デフォルト `ws://127.0.0.1:18789`）
- `gatewayToken`（認証が有効な場合）
- `timeoutMs`

注: `gatewayUrl` が設定されている場合は、`gatewayToken` を明示的に含めてください。ツールはオーバーライドのために設定や環境の認証情報を継承しません。明示的な認証情報が欠落している場合はエラーになります。

ブラウザツール:

- `profile`（オプション; デフォルトは `browser.defaultProfile`）
- `target`（`sandbox` | `host` | `node`）
- `node`（オプション; 特定のノード id/name を指定）

## 推奨されるエージェントフロー

ブラウザオートメーション:

1. `browser` → `status` / `start`
2. `snapshot`（ai または aria）
3. `act`（click/type/press）
4. 視覚的な確認が必要な場合は `screenshot`

キャンバスレンダリング:

1. `canvas` → `present`
2. `a2ui_push`（オプション）
3. `snapshot`

ノードターゲティング:

1. `nodes` → `status`
2. 選択したノードで `describe`
3. `notify` / `run` / `camera_snap` / `screen_record`

## 安全性

- 直接の `system.run` を避けてください。`nodes` → `run` はユーザーの明示的な同意がある場合にのみ使用してください。
- カメラ・画面キャプチャに対するユーザーの同意を尊重してください。
- メディアコマンドを実行する前に `status/describe` でパーミッションを確認してください。

## ツールがエージェントに提示される仕組み

ツールは 2 つの並行チャンネルで公開されます:

1. **システムプロンプトのテキスト**: 人間が読める一覧とガイダンス。
2. **ツールスキーマ**: モデル API に送信される構造化された関数定義。

これにより、エージェントは「どのツールが存在するか」と「どのように呼び出すか」の両方を確認できます。ツールがシステムプロンプトやスキーマに表示されない場合、モデルはそれを呼び出せません。
