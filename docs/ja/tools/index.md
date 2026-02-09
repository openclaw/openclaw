---
summary: "従来の `openclaw-*` skills を置き換える、OpenClaw 向けエージェントツールのサーフェス（browser、canvas、nodes、message、cron）"
read_when:
  - エージェントツールを追加または変更する場合
  - "`openclaw-*` skills を廃止または変更する場合"
title: "ツール"
---

# ツール（OpenClaw）

OpenClaw は、browser、canvas、nodes、cron 向けの **ファーストクラスのエージェントツール** を公開しています。
これらは旧来の `openclaw-*` skills を置き換えるものです。ツールは型付きで、シェル実行は行わず、
エージェントはこれらに直接依存することが想定されています。
21. これらは古い `openclaw-*` スキルを置き換えるものです。ツールは型付きで、シェル実行は行わず、
エージェントはそれらに直接依存する必要があります。

## ツールの無効化

`openclaw.json` において、`tools.allow` / `tools.deny` を使ってツールをグローバルに許可／拒否できます
（拒否が優先されます）。これにより、許可されていないツールがモデルプロバイダーに送信されるのを防ぎます。 これにより、許可されていないツールがモデルプロバイダに送信されるのを防ぎます。

```json5
{
  tools: { deny: ["browser"] },
}
```

注記:

- マッチングは大文字・小文字を区別しません。
- `*` のワイルドカードがサポートされています（`"*"` はすべてのツールを意味します）。
- `tools.allow` が未知または未ロードのプラグインツール名のみを参照している場合、OpenClaw は警告をログに出力し、許可リストを無視してコアツールが利用可能な状態を維持します。

## ツールプロファイル（ベース許可リスト）

`tools.profile` は、`tools.allow`/`tools.deny` の前に **ベースツール許可リスト** を設定します。
エージェント単位の上書き: `agents.list[].tools.profile`。
エージェント毎のオーバーライド: `agents.list[].tools.profile` 。

プロファイル:

- `minimal`: `session_status` のみ
- `coding`: `group:fs`, `group:runtime`, `group:sessions`, `group:memory`, `image`
- `messaging`: `group:messaging`, `sessions_list`, `sessions_history`, `sessions_send`, `session_status`
- `full`: 制限なし（未設定と同等）

例（既定はメッセージングのみ、Slack + Discord ツールも許可）:

```json5
{
  tools: {
    profile: "messaging",
    allow: ["slack", "discord"],
  },
}
```

例（コーディングプロファイルだが、exec/process をすべて拒否）:

```json5
{
  tools: {
    profile: "coding",
    deny: ["group:runtime"],
  },
}
```

例（グローバルはコーディングプロファイル、サポートエージェントはメッセージングのみ）:

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

`tools.byProvider` を使用して、グローバル既定を変更せずに、特定のプロバイダー
（または単一の `provider/model`）向けにツールを **さらに制限** できます。
エージェント単位の上書き: `agents.list[].tools.byProvider`。
エージェント毎のオーバーライド: `agents.list[].tools.byProvider`

これはベースツールプロファイルの**after**と、許可/拒否リスト
の前に適用されるため、ツールセットのみを絞り込むことができます。
プロバイダのキーは `provider` (例: `google-antigubity`) または
`provider/model` (例: `openai/gpt-5.2`) のいずれかを受け付けます。

例（グローバルはコーディングプロファイルを維持しつつ、Google Antigravity では最小限のツール）:

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

例（不安定なエンドポイント向けのプロバイダー／モデル固有の許可リスト）:

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

例（単一プロバイダーに対するエージェント固有の上書き）:

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

## ツールグループ（ショートハンド）

ツールポリシー（グローバル、エージェント、サンドボックス）は、複数ツールに展開される `group:*` エントリをサポートします。
`tools.allow` / `tools.deny` で使用してください。
`tools.allow` / `tools.deny` でこれを使用します。

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

例（ファイルツール + browser のみ許可）:

```json5
{
  tools: {
    allow: ["group:fs", "browser"],
  },
}
```

## プラグイン + ツール

プラグインはコアセットを超えて**追加ツール** (とCLIコマンド) を登録できます。
プラグインは、コアセットを超える **追加ツール**（および CLI コマンド）を登録できます。
インストールと設定は [Plugins](/tools/plugin)、ツール使用ガイダンスがプロンプトにどのように注入されるかは [Skills](/tools/skills) を参照してください。
一部のプラグインは、ツールと並行して独自の skills を同梱しています（例: 音声通話プラグイン）。 いくつかのプラグインは、ツールと一緒に独自のスキル
を搭載しています(例えば、ボイスコールプラグイン)。

任意のプラグインツール:

- [Lobster](/tools/lobster): 再開可能な承認を備えた型付きワークフローランタイム（ゲートウェイ ホストに Lobster CLI が必要）。
- [LLM Task](/tools/llm-task): 構造化ワークフロー出力向けの JSON 専用 LLM ステップ（任意のスキーマ検証）。

## ツール一覧

### `apply_patch`

1つまたは複数のファイルに構造化パッチを適用します。 複数のハンクの編集に使用します。
1 つ以上のファイルに構造化パッチを適用します。複数ハンクの編集に使用します。
実験的: `tools.exec.applyPatch.enabled` で有効化（OpenAI モデルのみ）。

### `exec`

ワークスペースでシェルコマンドを実行します。

主要パラメーター:

- `command`（必須）
- `yieldMs`（タイムアウト後に自動バックグラウンド化、既定 10000）
- `background`（即時バックグラウンド）
- `timeout`（秒; 超過時にプロセスを終了、既定 1800）
- `elevated`（bool; 昇格モードが有効／許可されている場合にホストで実行; エージェントがサンドボックス化されている場合のみ挙動が変わる）
- `host`（`sandbox | gateway | node`）
- `security`（`deny | allowlist | full`）
- `ask`（`off | on-miss | always`）
- `node`（`host=node` 用のノード id/名前）
- 実際の TTY が必要ですか？ `pty: true` を設定してください。 実 TTY が必要な場合は `pty: true` を設定します。

注記:

- バックグラウンド化された場合、`sessionId` を含む `status: "running"` を返します。
- バックグラウンドセッションのポーリング／ログ取得／書き込み／終了／クリアには `process` を使用します。
- `process` が不許可の場合、`exec` は同期実行され、`yieldMs`/`background` は無視されます。
- `elevated` は `tools.elevated` と `agents.list[].tools.elevated` の上書き（両方が許可する必要あり）によってゲートされ、`host=gateway` + `security=full` のエイリアスです。
- `elevated` は、エージェントがサンドボックス化されている場合にのみ挙動を変更します（それ以外では no-op）。
- `host=node` は macOS コンパニオンアプリまたはヘッドレス ノード ホスト（`openclaw node run`）を対象にできます。
- ゲートウェイ／ノードの承認と許可リスト: [Exec approvals](/tools/exec-approvals)。

### `process`

バックグラウンド exec セッションを管理します。

主要アクション:

- `list`, `poll`, `log`, `write`, `kill`, `clear`, `remove`

注記:

- `poll` は完了時に新しい出力と終了ステータスを返します。
- `log` は行ベースの `offset`/`limit` をサポートします（`offset` を省略すると最後の N 行を取得）。
- `process` はエージェント単位でスコープされ、他のエージェントのセッションは表示されません。

### `web_search`

Brave Search API を使用して Web を検索します。

主要パラメーター:

- `query`（必須）
- `count`（1–10; 既定は `tools.web.search.maxResults`）

注記:

- Brave API キーが必要です（推奨: `openclaw configure --section web`、または `BRAVE_API_KEY` を設定）。
- `tools.web.search.enabled` で有効化します。
- 応答はキャッシュされます（既定 15 分）。
- セットアップは [Web tools](/tools/web) を参照してください。

### `web_fetch`

URL から可読コンテンツを取得して抽出します（HTML → markdown/text）。

主要パラメーター:

- `url`（必須）
- `extractMode`（`markdown` | `text`）
- `maxChars`（長いページを切り詰め）

注記:

- `tools.web.fetch.enabled` で有効化します。
- `maxChars` は `tools.web.fetch.maxCharsCap` により制限されます（既定 50000）。
- 応答はキャッシュされます（既定 15 分）。
- JS 依存の強いサイトでは browser ツールを推奨します。
- セットアップは [Web tools](/tools/web) を参照してください。
- 任意のアンチボット フォールバックは [Firecrawl](/tools/firecrawl) を参照してください。

### `browser`

OpenClaw 管理の専用 browser を制御します。

主要アクション:

- `status`, `start`, `stop`, `tabs`, `open`, `focus`, `close`
- `snapshot`（aria/ai）
- `screenshot`（画像ブロック + `MEDIA:<path>` を返す）
- `act`（UI 操作: click/type/press/hover/drag/select/fill/resize/wait/evaluate）
- `navigate`, `console`, `pdf`, `upload`, `dialog`

プロファイル管理:

- `profiles` — ステータス付きで全 browser プロファイルを一覧表示
- `create-profile` — 自動割り当てポートで新規プロファイルを作成（または `cdpUrl`）
- `delete-profile` — browser を停止し、ユーザーデータを削除し、設定から削除（ローカルのみ）
- `reset-profile` — プロファイルのポート上の孤立プロセスを kill（ローカルのみ）

共通パラメーター:

- `profile`（任意; 既定は `browser.defaultProfile`）
- `target`（`sandbox` | `host` | `node`）
- `node`（任意; 特定のノード id/名前を指定）
  注記:
- `browser.enabled=true` が必要です（既定は `true`; 無効化するには `false` を設定）。
- すべてのアクションは、マルチインスタンス対応のため任意の `profile` パラメーターを受け付けます。
- `profile` を省略した場合、`browser.defaultProfile` を使用します（既定は "chrome"）。
- プロファイル名: 小文字の英数字 + ハイフンのみ（最大 64 文字）。
- ポート範囲: 18800-18899（最大約 100 プロファイル）。
- リモート プロファイルはアタッチ専用（start/stop/reset 不可）。
- browser 対応ノードが接続されている場合、ツールは自動的にルーティングされることがあります（`target` を固定しない限り）。
- `snapshot` は Playwright がインストールされている場合、既定で `ai` になります。アクセシビリティツリーには `aria` を使用してください。
- `snapshot` は、`interactive`, `compact`, `depth`, `selector` のロールスナップショット オプションもサポートし、`e12` のような参照を返します。
- `act` には、`snapshot` からの `ref` が必要です（AI スナップショット由来の数値 `12`、またはロールスナップショット由来の `e12`）。まれな CSS セレクター要件には `evaluate` を使用してください。
- 既定では `act` → `wait` を避けてください。信頼できる UI 状態を待てない例外的な場合のみ使用します。
- `upload` は、アーム後に自動クリックするために任意で `ref` を渡せます。
- `upload` は、`inputRef`（aria 参照）または `element`（CSS セレクター）もサポートし、`<input type="file">` を直接設定できます。

### `canvas`

ノード Canvas を操作します（present、eval、snapshot、A2UI）。

主要アクション:

- `present`, `hide`, `navigate`, `eval`
- `snapshot`（画像ブロック + `MEDIA:<path>` を返す）
- `a2ui_push`, `a2ui_reset`

注記:

- 内部的にゲートウェイの `node.invoke` を使用します。
- `node` が指定されていない場合、ツールが既定を選択します（単一の接続ノード、またはローカル mac ノード）。
- A2UI は v0.8 のみ対応（`createSurface` なし）。CLI は v0.9 の JSONL を行エラーとして拒否します。
- クイックスモーク: `openclaw nodes canvas a2ui push --node <id> --text "Hello from A2UI"`。

### `nodes`

ペアリングされたノードを検出・指定し、通知を送信し、カメラ／画面をキャプチャします。

主要アクション:

- `status`, `describe`
- `pending`, `approve`, `reject`（ペアリング）
- `notify`（macOS `system.notify`）
- `run`（macOS `system.run`）
- `camera_snap`, `camera_clip`, `screen_record`
- `location_get`

注記:

- カメラ／画面コマンドには、ノードアプリがフォアグラウンドである必要があります。
- 画像は画像ブロック + `MEDIA:<path>` を返します。
- 動画は `FILE:<path>`（mp4）を返します。
- 位置情報は JSON ペイロード（lat/lon/accuracy/timestamp）を返します。
- `run` のパラメーター: `command` argv 配列; 任意の `cwd`, `env`（`KEY=VAL`）, `commandTimeoutMs`, `invokeTimeoutMs`, `needsScreenRecording`。

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

設定された画像モデルで画像を解析します。

主要パラメーター:

- `image`（必須のパスまたは URL）
- `prompt`（任意; 既定は "Describe the image."）
- `model`（任意の上書き）
- `maxBytesMb`（任意のサイズ上限）

注記:

- `agents.defaults.imageModel` が設定されている場合（プライマリまたはフォールバック）、または既定モデル + 設定済み認証から暗黙の画像モデルを推定できる場合にのみ利用可能です（ベストエフォートのペアリング）。
- メインのチャットモデルとは独立して、画像モデルを直接使用します。

### `message`

Discord/Google Chat/Slack/Telegram/WhatsApp/Signal/iMessage/MS Teams 全体でメッセージ送信およびチャンネル操作を行います。

主要アクション:

- `send`（テキスト + 任意のメディア; MS Teams は Adaptive Cards 向けに `card` もサポート）
- `poll`（WhatsApp/Discord/MS Teams の投票）
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

注記:

- `send` は WhatsApp を Gateway（ゲートウェイ）経由でルーティングします。他のチャンネルは直接接続です。
- `poll` は WhatsApp と MS Teams に Gateway（ゲートウェイ）を使用します。Discord の投票は直接接続です。
- メッセージツール呼び出しがアクティブなチャットセッションにバインドされている場合、送信はそのセッションの宛先に制約され、コンテキスト横断の漏えいを防ぎます。

### `cron`

Gateway（ゲートウェイ）の cron ジョブとウェイクアップを管理します。

主要アクション:

- `status`, `list`
- `add`, `update`, `remove`, `run`, `runs`
- `wake`（システムイベントをキューに入れ、任意で即時ハートビート）

注記:

- `add` は完全な cron ジョブオブジェクトを期待します（`cron.add` RPC と同一スキーマ）。
- `update` は `{ jobId, patch }` を使用します（互換性のため `id` も受け付けます）。

### `gateway`

実行中の Gateway（ゲートウェイ）プロセスをインプレースで再起動または更新を適用します。

主要アクション:

- `restart`（認可 + インプロセス再起動のため `SIGUSR1` を送信; `openclaw gateway` はインプレース再起動）
- `config.get` / `config.schema`
- `config.apply`（検証 + 設定書き込み + 再起動 + ウェイク）
- `config.patch`（部分更新のマージ + 再起動 + ウェイク）
- `update.run`（更新実行 + 再起動 + ウェイク）

注記:

- 進行中の返信を中断しないよう、`delayMs`（既定 2000）を使用してください。
- `restart` は既定で無効です。`commands.restart: true` で有効化してください。

### `sessions_list` / `sessions_history` / `sessions_send` / `sessions_spawn` / `session_status`

セッション一覧、トランスクリプト履歴の確認、または別セッションへの送信を行います。

主要パラメーター:

- `sessions_list`: `kinds?`, `limit?`, `activeMinutes?`, `messageLimit?`（0 = なし）
- `sessions_history`: `sessionKey`（または `sessionId`）, `limit?`, `includeTools?`
- `sessions_send`: `sessionKey`（または `sessionId`）, `message`, `timeoutSeconds?`（0 = fire-and-forget）
- `sessions_spawn`: `task`, `label?`, `agentId?`, `model?`, `runTimeoutSeconds?`, `cleanup?`
- `session_status`: `sessionKey?`（既定は current; `sessionId` を受け付けます）, `model?`（`default` で上書きをクリア）

注記:

- `main` は正規のダイレクトチャットキーです。グローバル／不明なものは非表示になります。
- `messageLimit > 0` は各セッションの最新 N 件のメッセージを取得します（ツールメッセージはフィルタリング）。
- `timeoutSeconds > 0` の場合、`sessions_send` は最終完了まで待機します。
- 配信／アナウンスは完了後に行われ、ベストエフォートです。`status: "ok"` はエージェント実行の完了を確認するもので、アナウンスの配信完了を保証するものではありません。
- `sessions_spawn` はサブエージェント実行を開始し、要求元チャットへアナウンス返信を投稿します。
- `sessions_spawn` は非ブロッキングで、直ちに `status: "accepted"` を返します。
- `sessions_send` は返信のピンポンを実行します（停止するには `REPLY_SKIP` に返信; 最大ターンは `session.agentToAgent.maxPingPongTurns`、0–5）。
- ピンポン後、対象エージェントは **アナウンスステップ** を実行します。アナウンスを抑止するには `ANNOUNCE_SKIP` に返信してください。

### `agents_list`

現在のセッションが `sessions_spawn` で対象にできるエージェント id を一覧表示します。

注記:

- 結果はエージェント単位の許可リスト（`agents.list[].subagents.allowAgents`）に制限されます。
- `["*"]` が設定されている場合、ツールは設定済みのすべてのエージェントを含め、`allowAny: true` をマークします。

## パラメーター（共通）

Gateway（ゲートウェイ）バックエンドのツール（`canvas`, `nodes`, `cron`）:

- `gatewayUrl`（既定 `ws://127.0.0.1:18789`）
- `gatewayToken`（認証が有効な場合）
- `timeoutMs`

注意: `gatewayUrl` が設定されている場合、明示的に `gatewayToken` を含めます。 ツールは config
またはオーバーライドの環境資格情報を継承しません。明示的な資格情報が不足していることはエラーです。

browser ツール:

- `profile`（任意; 既定は `browser.defaultProfile`）
- `target`（`sandbox` | `host` | `node`）
- `node`（任意; 特定のノード id/名前を固定）

## 推奨されるエージェントフロー

browser 自動化:

1. `browser` → `status` / `start`
2. `snapshot`（ai または aria）
3. `act`（click/type/press）
4. 視覚的な確認が必要な場合は `screenshot`

Canvas レンダリング:

1. `canvas` → `present`
2. `a2ui_push`（任意）
3. `snapshot`

ノードのターゲティング:

1. `nodes` → `status`
2. 選択したノードで `describe`
3. `notify` / `run` / `camera_snap` / `screen_record`

## 安全性

- 直接の `system.run` は避けてください。明示的なユーザー同意がある場合のみ `nodes` → `run` を使用します。
- カメラ／画面キャプチャについてはユーザーの同意を尊重してください。
- メディアコマンドを呼び出す前に、`status/describe` を使用して権限を確認してください。

## エージェントへのツール提示方法

ツールは 2 つの並行チャネルで公開されます:

1. **システムプロンプトテキスト**: 人が読める一覧とガイダンス。
2. **ツールスキーマ**: モデル API に送信される構造化された関数定義。

つまり、エージェントは「ツールが存在するもの」と「呼び方」の両方を見ることができます。 つまり、エージェントは「どのツールが存在するか」と「どのように呼び出すか」の両方を把握します。ツールが
システムプロンプトまたはスキーマに表示されない場合、モデルはそれを呼び出すことができません。
