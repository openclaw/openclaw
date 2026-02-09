---
summary: "openclaw コマンド、サブコマンド、およびオプションのための OpenClaw CLI リファレンス"
read_when:
  - CLI コマンドやオプションを追加または変更する場合
  - 新しいコマンド サーフェスを文書化する場合
title: "CLI リファレンス"
---

# CLI リファレンス

このページでは、現在の CLI の挙動について説明します。コマンドが変更された場合は、このドキュメントを更新してください。 コマンドが変更された場合は、このドキュメントを更新してください。

## コマンド ページ

- [`setup`](/cli/setup)
- [`onboard`](/cli/onboard)
- [`configure`](/cli/configure)
- [`config`](/cli/config)
- [`doctor`](/cli/doctor)
- [`dashboard`](/cli/dashboard)
- [`reset`](/cli/reset)
- [`uninstall`](/cli/uninstall)
- [`update`](/cli/update)
- [`message`](/cli/message)
- [`agent`](/cli/agent)
- [`agents`](/cli/agents)
- [`acp`](/cli/acp)
- [`status`](/cli/status)
- [`health`](/cli/health)
- [`sessions`](/cli/sessions)
- [`gateway`](/cli/gateway)
- [`logs`](/cli/logs)
- [`system`](/cli/system)
- [`models`](/cli/models)
- [`memory`](/cli/memory)
- [`nodes`](/cli/nodes)
- [`devices`](/cli/devices)
- [`node`](/cli/node)
- [`approvals`](/cli/approvals)
- [`sandbox`](/cli/sandbox)
- [`tui`](/cli/tui)
- [`browser`](/cli/browser)
- [`cron`](/cli/cron)
- [`dns`](/cli/dns)
- [`docs`](/cli/docs)
- [`hooks`](/cli/hooks)
- [`webhooks`](/cli/webhooks)
- [`pairing`](/cli/pairing)
- [`plugins`](/cli/plugins)（プラグイン コマンド）
- [`channels`](/cli/channels)
- [`security`](/cli/security)
- [`skills`](/cli/skills)
- [`voicecall`](/cli/voicecall)（プラグイン；インストールされている場合）

## グローバル フラグ

- `--dev`: 状態を `~/.openclaw-dev` 配下に分離し、デフォルト ポートをシフトします。
- `--profile <name>`: 状態を `~/.openclaw-<name>` 配下に分離します。
- `--no-color`: ANSI カラーを無効化します。
- `--update`: `openclaw update` の省略形（ソース インストールのみ）。
- `-V`, `--version`, `-v`: バージョンを表示して終了します。

## 出力スタイル

- ANSI カラーと進捗インジケーターは、TTY セッションでのみ描画されます。
- OSC-8 ハイパーリンクは、対応するターミナルではクリック可能なリンクとして表示されます。それ以外の場合は、プレーンな URL にフォールバックします。
- `--json`（および対応環境では `--plain`）は、クリーンな出力のためにスタイリングを無効化します。
- `--no-color` は ANSI スタイルを無効化します。`NO_COLOR=1` も考慮されます。
- 長時間実行されるコマンドでは、進捗インジケーターが表示されます（対応環境では OSC 9;4）。

## カラー パレット

OpenClaw は、CLI 出力に「lobster」パレットを使用します。

- `accent` (#FF5A2D): 見出し、ラベル、主要なハイライト。
- `accentBright` (#FF7A3D): コマンド名、強調。
- `accentDim` (#D14A22): 二次的なハイライト テキスト。
- `info` (#FF8A5B): 情報値。
- `success` (#2FBF71): 成功状態。
- `warn` (#FFB020): 警告、フォールバック、注意。
- `error` (#E23D2D): エラー、失敗。
- `muted` (#8B7F77): 非強調、メタデータ。

パレットの一次情報源: `src/terminal/palette.ts`（別名「lobster seam」）。

## コマンド ツリー

```
openclaw [--dev] [--profile <name>] <command>
  setup
  onboard
  configure
  config
    get
    set
    unset
  doctor
  security
    audit
  reset
  uninstall
  update
  channels
    list
    status
    logs
    add
    remove
    login
    logout
  skills
    list
    info
    check
  plugins
    list
    info
    install
    enable
    disable
    doctor
  memory
    status
    index
    search
  message
  agent
  agents
    list
    add
    delete
  acp
  status
  health
  sessions
  gateway
    call
    health
    status
    probe
    discover
    install
    uninstall
    start
    stop
    restart
    run
  logs
  system
    event
    heartbeat last|enable|disable
    presence
  models
    list
    status
    set
    set-image
    aliases list|add|remove
    fallbacks list|add|remove|clear
    image-fallbacks list|add|remove|clear
    scan
    auth add|setup-token|paste-token
    auth order get|set|clear
  sandbox
    list
    recreate
    explain
  cron
    status
    list
    add
    edit
    rm
    enable
    disable
    runs
    run
  nodes
  devices
  node
    run
    status
    install
    uninstall
    start
    stop
    restart
  approvals
    get
    set
    allowlist add|remove
  browser
    status
    start
    stop
    reset-profile
    tabs
    open
    focus
    close
    profiles
    create-profile
    delete-profile
    screenshot
    snapshot
    navigate
    resize
    click
    type
    press
    hover
    drag
    select
    upload
    fill
    dialog
    wait
    evaluate
    console
    pdf
  hooks
    list
    info
    check
    enable
    disable
    install
    update
  webhooks
    gmail setup|run
  pairing
    list
    approve
  docs
  dns
    setup
  tui
```

注記: プラグインは、追加のトップレベル コマンドを追加できます（例: `openclaw voicecall`）。

## セキュリティ

- `openclaw security audit` — 設定とローカル状態を監査し、一般的なセキュリティ上の落とし穴を検出します。
- `openclaw security audit --deep` — ベストエフォートでのライブ Gateway プローブ。
- `openclaw security audit --fix` — 安全なデフォルトを強化し、状態／設定に chmod を適用します。

## プラグイン

拡張機能とその設定を管理します。

- `openclaw plugins list` — プラグインを検出します（機械可読な出力には `--json` を使用）。
- `openclaw plugins info <id>` — プラグインの詳細を表示します。
- `openclaw plugins install <path|.tgz|npm-spec>` — プラグインをインストールします（または `plugins.load.paths` にプラグイン パスを追加します）。
- `openclaw plugins enable <id>` / `disable <id>` — `plugins.entries.<id>.enabled` を切り替えます。
- `openclaw plugins doctor` — プラグインのロード エラーを報告します。

ほとんどのプラグイン変更には、ゲートウェイの再起動が必要です。[/plugin](/tools/plugin) を参照してください。 [/plugin](/tools/plugin) を参照してください。

## メモリ

`MEMORY.md` + `memory/*.md` に対するベクトル検索:

- `openclaw memory status` — インデックス統計を表示します。
- `openclaw memory index` — メモリ ファイルを再インデックスします。
- `openclaw memory search "<query>"` — メモリに対するセマンティック検索。

## チャット スラッシュ コマンド

チャット メッセージは、テキストおよびネイティブの `/...` コマンドをサポートします。[/tools/slash-commands](/tools/slash-commands) を参照してください。 [/tools/slash-commands](/tools/slash-commands) を参照してください。

ハイライト:

- クイック診断には `/status`。
- 永続化された設定変更には `/config`。
- 実行時のみの設定上書き（メモリのみ、ディスク非書き込み；`commands.debug: true` が必要）には `/debug`。

## セットアップ + オンボーディング

### `setup`

設定とワークスペースを初期化します。

オプション:

- `--workspace <dir>`: エージェント ワークスペースのパス（デフォルト: `~/.openclaw/workspace`）。
- `--wizard`: オンボーディング ウィザードを実行します。
- `--non-interactive`: プロンプトなしでウィザードを実行します。
- `--mode <local|remote>`: ウィザード モード。
- `--remote-url <url>`: リモート Gateway の URL。
- `--remote-token <token>`: リモート Gateway トークン。

いずれかのウィザード フラグ（`--non-interactive`, `--mode`, `--remote-url`, `--remote-token`）が指定されている場合、ウィザードは自動実行されます。

### `onboard`

ゲートウェイ、ワークスペース、Skills をセットアップするための対話型ウィザードです。

オプション:

- `--workspace <dir>`
- `--reset`（ウィザード前に設定 + 資格情報 + セッション + ワークスペースをリセット）
- `--non-interactive`
- `--mode <local|remote>`
- `--flow <quickstart|advanced|manual>`（manual は advanced のエイリアス）
- `--auth-choice <setup-token|token|chutes|openai-codex|openai-api-key|openrouter-api-key|ai-gateway-api-key|moonshot-api-key|moonshot-api-key-cn|kimi-code-api-key|synthetic-api-key|venice-api-key|gemini-api-key|zai-api-key|apiKey|minimax-api|minimax-api-lightning|opencode-zen|skip>`
- `--token-provider <id>`（非対話型；`--auth-choice token` と併用）
- `--token <token>`（非対話型；`--auth-choice token` と併用）
- `--token-profile-id <id>`（非対話型；デフォルト: `<provider>:manual`）
- `--token-expires-in <duration>`（非対話型；例: `365d`, `12h`）
- `--anthropic-api-key <key>`
- `--openai-api-key <key>`
- `--openrouter-api-key <key>`
- `--ai-gateway-api-key <key>`
- `--moonshot-api-key <key>`
- `--kimi-code-api-key <key>`
- `--gemini-api-key <key>`
- `--zai-api-key <key>`
- `--minimax-api-key <key>`
- `--opencode-zen-api-key <key>`
- `--gateway-port <port>`
- `--gateway-bind <loopback|lan|tailnet|auto|custom>`
- `--gateway-auth <token|password>`
- `--gateway-token <token>`
- `--gateway-password <password>`
- `--remote-url <url>`
- `--remote-token <token>`
- `--tailscale <off|serve|funnel>`
- `--tailscale-reset-on-exit`
- `--install-daemon`
- `--no-install-daemon`（エイリアス: `--skip-daemon`）
- `--daemon-runtime <node|bun>`
- `--skip-channels`
- `--skip-skills`
- `--skip-health`
- `--skip-ui`
- `--node-manager <npm|pnpm|bun>`（pnpm 推奨；Gateway ランタイムでは bun は非推奨）
- `--json`

### `configure`

対話型設定ウィザード（モデル、チャンネル、Skills、ゲートウェイ）。

### `config`

非対話的な設定ヘルパー (get/set/unset)。 非対話型の設定ヘルパー（get/set/unset）。サブコマンドなしで `openclaw config` を実行すると、ウィザードが起動します。

サブコマンド:

- `config get <path>`: 設定値を表示します（ドット／ブラケット パス）。
- `config set <path> <value>`: 値を設定します（JSON5 または生文字列）。
- `config unset <path>`: 値を削除します。

### `doctor`

ヘルス チェックとクイック修復（設定 + ゲートウェイ + レガシー サービス）。

オプション:

- `--no-workspace-suggestions`: ワークスペース メモリ ヒントを無効化します。
- `--yes`: プロンプトなしでデフォルトを受け入れます（ヘッドレス）。
- `--non-interactive`: プロンプトをスキップし、安全なマイグレーションのみを適用します。
- `--deep`: 追加のゲートウェイ インストールについてシステム サービスをスキャンします。

## チャンネル ヘルパー

### `channels`

チャット チャンネル アカウントを管理します（WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost（プラグイン）/Signal/iMessage/MS Teams）。

サブコマンド:

- `channels list`: 設定済みチャンネルと認証プロファイルを表示します。
- `channels status`: ゲートウェイ到達性とチャンネル ヘルスを確認します（`--probe` は追加チェックを実行；ゲートウェイのヘルス プローブには `openclaw health` または `openclaw status --deep` を使用）。
- ヒント: `channels status` は、一般的な誤設定を検出できる場合に、修正案付きの警告を表示します（その後 `openclaw doctor` を案内します）。
- `channels logs`: ゲートウェイ ログ ファイルから最近のチャンネル ログを表示します。
- `channels add`: フラグ未指定時はウィザード形式のセットアップを実行します。フラグ指定時は非対話型モードに切り替わります。
- `channels remove`: 既定では無効です。プロンプトなしで設定エントリを削除するには `--delete` を指定します。
- `channels login`: 対話型のチャンネル ログイン（WhatsApp Web のみ）。
- `channels logout`: チャンネル セッションからログアウトします（対応している場合）。

共通オプション:

- `--channel <name>`: `whatsapp|telegram|discord|googlechat|slack|mattermost|signal|imessage|msteams`
- `--account <id>`: チャンネル アカウント ID（デフォルト: `default`）
- `--name <label>`: アカウントの表示名

`channels login` のオプション:

- `--channel <channel>`（デフォルト: `whatsapp`；`whatsapp`/`web` をサポート）
- `--account <id>`
- `--verbose`

`channels logout` のオプション:

- `--channel <channel>`（デフォルト: `whatsapp`）
- `--account <id>`

`channels list` のオプション:

- `--no-usage`: モデル プロバイダーの使用量／クォータ スナップショットをスキップします（OAuth/API 対応のみ）。
- `--json`: JSON を出力します（`--no-usage` が設定されていない限り使用量を含みます）。

`channels logs` のオプション:

- `--channel <name|all>`（デフォルト: `all`）
- `--lines <n>`（デフォルト: `200`）
- `--json`

詳細: [/concepts/oauth](/concepts/oauth)

例:

```bash
openclaw channels add --channel telegram --account alerts --name "Alerts Bot" --token $TELEGRAM_BOT_TOKEN
openclaw channels add --channel discord --account work --name "Work Bot" --token $DISCORD_BOT_TOKEN
openclaw channels remove --channel discord --account work --delete
openclaw channels status --probe
openclaw status --deep
```

### `skills`

利用可能な Skills の一覧と、準備状況の情報を表示します。

サブコマンド:

- `skills list`: Skills を一覧表示します（サブコマンド未指定時のデフォルト）。
- `skills info <name>`: 1 つの Skill の詳細を表示します。
- `skills check`: 準備完了と不足要件のサマリー。

オプション:

- `--eligible`: 準備完了の Skills のみを表示します。
- `--json`: JSON を出力します（スタイリングなし）。
- `-v`, `--verbose`: 不足要件の詳細を含めます。

ヒント: Skills の検索、インストール、同期には `npx clawhub` を使用してください。

### `pairing`

チャンネル間の DM ペアリング リクエストを承認します。

サブコマンド:

- `pairing list <channel> [--json]`
- `pairing approve <channel> <code> [--notify]`

### `webhooks gmail`

Gmail Pub/Sub フックのセットアップとランナーです。[/automation/gmail-pubsub](/automation/gmail-pubsub) を参照してください。 [/automation/gmail-pubsub](/automation/gmail-pubsub) を参照してください。

サブコマンド:

- `webhooks gmail setup`（`--account <email>` が必要；`--project`, `--topic`, `--subscription`, `--label`, `--hook-url`, `--hook-token`, `--push-token`, `--bind`, `--port`, `--path`, `--include-body`, `--max-bytes`, `--renew-minutes`, `--tailscale`, `--tailscale-path`, `--tailscale-target`, `--push-endpoint`, `--json` をサポート）
- `webhooks gmail run`（同一フラグに対するランタイム上書き）

### `dns setup`

広域探索用 DNS ヘルパー（CoreDNS + Tailscale）。[/gateway/discovery](/gateway/discovery) を参照してください。 [/gateway/discovery](/gateway/discovery) を参照してください。

オプション:

- `--apply`: CoreDNS 設定をインストール／更新します（sudo が必要；macOS のみ）。

## メッセージング + エージェント

### `message`

統合された送信メッセージングとチャンネル操作。

参照: [/cli/message](/cli/message)

サブコマンド:

- `message send|poll|react|reactions|read|edit|delete|pin|unpin|pins|permissions|search|timeout|kick|ban`
- `message thread <create|list|reply>`
- `message emoji <list|upload>`
- `message sticker <send|upload>`
- `message role <info|add|remove>`
- `message channel <info|list>`
- `message member info`
- `message voice status`
- `message event <list|create>`

例:

- `openclaw message send --target +15555550123 --message "Hi"`
- `openclaw message poll --channel discord --target channel:123 --poll-question "Snack?" --poll-option Pizza --poll-option Sushi`

### `agent`

Gateway（または埋め込みの `--local`）経由で、エージェントの 1 ターンを実行します。

必須:

- `--message <text>`

オプション:

- `--to <dest>`（セッション キーおよび任意の配信用）
- `--session-id <id>`
- `--thinking <off|minimal|low|medium|high|xhigh>`（GPT-5.2 + Codex モデルのみ）
- `--verbose <on|full|off>`
- `--channel <whatsapp|telegram|discord|slack|mattermost|signal|imessage|msteams>`
- `--local`
- `--deliver`
- `--json`
- `--timeout <seconds>`

### `agents`

分離されたエージェント（ワークスペース + 認証 + ルーティング）を管理します。

#### `agents list`

設定済みエージェントを一覧表示します。

オプション:

- `--json`
- `--bindings`

#### `agents add [name]`

新しいエージェントを追加します。 新しい分離エージェントを追加します。フラグ（または `--non-interactive`）が指定されていない場合は、ガイド付きウィザードを実行します。非対話型モードでは `--workspace` が必須です。

オプション:

- `--workspace <dir>`
- `--model <id>`
- `--agent-dir <dir>`
- `--bind <channel[:accountId]>`（繰り返し指定可）
- `--non-interactive`
- `--json`

バインド仕様は `channel[:accountId]` を使用します。 バインディング仕様には `channel[:accountId]` を使用します。WhatsApp で `accountId` が省略された場合、デフォルトのアカウント ID が使用されます。

#### `agents delete <id>`

エージェントを削除し、そのワークスペースと状態を整理します。

オプション:

- `--force`
- `--json`

### `acp`

IDE を Gateway に接続する ACP ブリッジを実行します。

完全なオプションと例については [`acp`](/cli/acp) を参照してください。

### `status`

リンクされたセッションのヘルスと最近の受信者を表示します。

オプション:

- `--json`
- `--all`（完全診断；読み取り専用、貼り付け可能）
- `--deep`（チャンネルをプローブ）
- `--usage`（モデル プロバイダーの使用量／クォータを表示）
- `--timeout <ms>`
- `--verbose`
- `--debug`（`--verbose` のエイリアス）

注記:

- 概要には、利用可能な場合に Gateway とノード ホスト サービスの状態が含まれます。

### 使用量トラッキング

OpenClaw は、OAuth/API 資格情報が利用可能な場合に、プロバイダーの使用量／クォータを表示できます。

サーフェス:

- `/status`（利用可能な場合、短い使用量行を追加）
- `openclaw status --usage`（プロバイダー別の詳細内訳を表示）
- macOS メニュー バー（Context 配下の Usage セクション）

注記:

- データは、プロバイダーの使用量エンドポイントから直接取得されます（推定値ではありません）。
- プロバイダー: Anthropic、GitHub Copilot、OpenAI Codex OAuth、さらに対応プラグイン有効時の Gemini CLI/Antigravity。
- 一致する資格情報が存在しない場合、使用量は非表示になります。
- 詳細: [Usage tracking](/concepts/usage-tracking) を参照してください。

### `health`

ランニングゲートウェイからヘルスを取得します。

オプション:

- `--json`
- `--timeout <ms>`
- `--verbose`

### `sessions`

保存されている会話セッションを一覧表示します。

オプション:

- `--json`
- `--verbose`
- `--store <path>`
- `--active <minutes>`

## リセット / アンインストール

### `reset`

ローカルの設定／状態をリセットします（CLI はインストールされたままです）。

オプション:

- `--scope <config|config+creds+sessions|full>`
- `--yes`
- `--non-interactive`
- `--dry-run`

注記:

- `--non-interactive` には `--scope` と `--yes` が必要です。

### `uninstall`

ゲートウェイ サービスとローカル データをアンインストールします（CLI は残ります）。

オプション:

- `--service`
- `--state`
- `--workspace`
- `--app`
- `--all`
- `--yes`
- `--non-interactive`
- `--dry-run`

注記:

- `--non-interactive` には `--yes` と明示的なスコープ（または `--all`）が必要です。

## ゲートウェイ

### `gateway`

WebSocket Gateway を実行します。

オプション:

- `--port <port>`
- `--bind <loopback|tailnet|lan|auto|custom>`
- `--token <token>`
- `--auth <token|password>`
- `--password <password>`
- `--tailscale <off|serve|funnel>`
- `--tailscale-reset-on-exit`
- `--allow-unconfigured`
- `--dev`
- `--reset`（開発用の設定 + 資格情報 + セッション + ワークスペースをリセット）
- `--force`（ポート上の既存リスナーを終了）
- `--verbose`
- `--claude-cli-logs`
- `--ws-log <auto|full|compact>`
- `--compact`（`--ws-log compact` のエイリアス）
- `--raw-stream`
- `--raw-stream-path <path>`

### `gateway service`

Gateway サービスを管理します（launchd/systemd/schtasks）。

サブコマンド:

- `gateway status`（デフォルトで Gateway RPC をプローブ）
- `gateway install`（サービスのインストール）
- `gateway uninstall`
- `gateway start`
- `gateway stop`
- `gateway restart`

注記:

- `gateway status` は、サービスで解決されたポート／設定を使用して、デフォルトで Gateway RPC をプローブします（`--url/--token/--password` で上書き可能）。
- `gateway status` は、スクリプト用に `--no-probe`, `--deep`, `--json` をサポートします。
- `gateway status` は、検出可能な場合にレガシーまたは追加のゲートウェイ サービスも表示します（`--deep` はシステム レベルのスキャンを追加）。プロファイル名付きの OpenClaw サービスは、第一級として扱われ、「extra」としてはフラグ付けされません。 プロファイル名の OpenClawサービスはファーストクラスとして扱われ、"extra"としてフラグは立てられません。
- `gateway status` は、CLI が使用する設定パスと、サービスが使用している可能性の高い設定（サービス環境）、および解決されたプローブ対象 URL を表示します。
- `gateway install|uninstall|start|stop|restart` は、スクリプト用に `--json` をサポートします（デフォルト出力は人間に優しい形式のままです）。
- `gateway install` は Node ランタイムがデフォルトです。bun は **非推奨** です（WhatsApp/Telegram の不具合）。
- `gateway install` のオプション: `--port`, `--runtime`, `--token`, `--force`, `--json`。

### `logs`

RPC 経由で Gateway のファイル ログを追跡表示します。

注記:

- TTY セッションでは、色付きで構造化された表示が描画されます。非 TTY ではプレーン テキストにフォールバックします。
- `--json` は、行区切りの JSON（1 行につき 1 ログ イベント）を出力します。

例:

```bash
openclaw logs --follow
openclaw logs --limit 200
openclaw logs --plain
openclaw logs --json
openclaw logs --no-color
```

### `gateway <subcommand>`

Gateway CLI ヘルパー（RPC サブコマンドには `--url`, `--token`, `--password`, `--timeout`, `--expect-final` を使用）。
`--url` を指定した場合、CLI は設定や環境資格情報を自動適用しません。
`--token` または `--password` を明示的に含めてください。明示的な資格情報がない場合はエラーとなります。
`--url` を渡すと、CLI は設定や環境の資格情報を自動的に適用しません。
明示的に `--token` または `--password` を含めます。 明示的な資格情報が見つかりませんでした。

サブコマンド:

- `gateway call <method> [--params <json>]`
- `gateway health`
- `gateway status`
- `gateway probe`
- `gateway discover`
- `gateway install|uninstall|start|stop|restart`
- `gateway run`

共通 RPC:

- `config.apply`（検証 + 設定書き込み + 再起動 + ウェイク）
- `config.patch`（部分更新をマージ + 再起動 + ウェイク）
- `update.run`（更新実行 + 再起動 + ウェイク）

ヒント: `config.set`/`config.apply`/`config.patch` を直接呼び出す場合、既存の設定があるときは
`config.get` からの `baseHash` を渡してください。

## モデル

フォールバックの挙動とスキャン戦略については [/concepts/models](/concepts/models) を参照してください。

推奨される Anthropic 認証（setup-token）:

```bash
claude setup-token
openclaw models auth setup-token --provider anthropic
openclaw models status
```

### `models`（ルート）

`openclaw models` は `models status` のエイリアスです。

ルート オプション:

- `--status-json`（`models status --json` のエイリアス）
- `--status-plain`（`models status --plain` のエイリアス）

### `models list`

オプション:

- `--all`
- `--local`
- `--provider <name>`
- `--json`
- `--plain`

### `models status`

オプション:

- `--json`
- `--plain`
- `--check`（終了コード: 1=期限切れ／未設定、2=期限切れ間近）
- `--probe`（設定済み認証プロファイルのライブ プローブ）
- `--probe-provider <name>`
- `--probe-profile <id>`（繰り返し指定またはカンマ区切り）
- `--probe-timeout <ms>`
- `--probe-concurrency <n>`
- `--probe-max-tokens <n>`

常に、認証ストアのプロファイルの認証概要とOAuth有効期限ステータスが含まれます。
`--probe` はライブリクエストを実行します（トークンとトリガーレート制限を消費する可能性があります）。

### `models set <model>`

`agents.defaults.model.primary` を設定します。

### `models set-image <model>`

`agents.defaults.imageModel.primary` を設定します。

### `models aliases list|add|remove`

オプション:

- `list`: `--json`, `--plain`
- `add <alias> <model>`
- `remove <alias>`

### `models fallbacks list|add|remove|clear`

オプション:

- `list`: `--json`, `--plain`
- `add <model>`
- `remove <model>`
- `clear`

### `models image-fallbacks list|add|remove|clear`

オプション:

- `list`: `--json`, `--plain`
- `add <model>`
- `remove <model>`
- `clear`

### `models scan`

オプション:

- `--min-params <b>`
- `--max-age-days <days>`
- `--provider <name>`
- `--max-candidates <n>`
- `--timeout <ms>`
- `--concurrency <n>`
- `--no-probe`
- `--yes`
- `--no-input`
- `--set-default`
- `--set-image`
- `--json`

### `models auth add|setup-token|paste-token`

オプション:

- `add`: 対話型認証ヘルパー
- `setup-token`: `--provider <name>`（デフォルト: `anthropic`）、`--yes`
- `paste-token`: `--provider <name>`, `--profile-id <id>`, `--expires-in <duration>`

### `models auth order get|set|clear`

オプション:

- `get`: `--provider <name>`, `--agent <id>`, `--json`
- `set`: `--provider <name>`, `--agent <id>`, `<profileIds...>`
- `clear`: `--provider <name>`, `--agent <id>`

## システム

### `system event`

システム イベントをキューに追加し、必要に応じてハートビートをトリガーします（Gateway RPC）。

必須:

- `--text <text>`

オプション:

- `--mode <now|next-heartbeat>`
- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

### `system heartbeat last|enable|disable`

ハートビート制御（Gateway RPC）。

オプション:

- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

### `system presence`

システム プレゼンス エントリを一覧表示します（Gateway RPC）。

オプション:

- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

## Cron

スケジュール ジョブを管理します（Gateway RPC）。[/automation/cron-jobs](/automation/cron-jobs) を参照してください。 [/automation/cron-jobs](/automation/cron-jobs) を参照してください。

サブコマンド:

- `cron status [--json]`
- `cron list [--all] [--json]`（デフォルトはテーブル出力；生データには `--json` を使用）
- `cron add`（エイリアス: `create`；`--name` と、`--at` | `--every` | `--cron` のいずれか 1 つ、さらに `--system-event` | `--message` のいずれか 1 つのペイロードが必須）
- `cron edit <id>`（フィールドをパッチ）
- `cron rm <id>`（エイリアス: `remove`, `delete`）
- `cron enable <id>`
- `cron disable <id>`
- `cron runs --id <id> [--limit <n>]`
- `cron run <id> [--force]`

すべての `cron` コマンドは、`--url`, `--token`, `--timeout`, `--expect-final` を受け付けます。

## ノード ホスト

`node` は **ヘッドレス ノード ホスト** を実行するか、バックグラウンド サービスとして管理します。
[`openclaw node`](/cli/node) を参照してください。
[`openclawノード`](/cli/node)を参照してください。

サブコマンド:

- `node run --host <gateway-host> --port 18789`
- `node status`
- `node install [--host <gateway-host>] [--port <port>] [--tls] [--tls-fingerprint <sha256>] [--node-id <id>] [--display-name <name>] [--runtime <node|bun>] [--force]`
- `node uninstall`
- `node stop`
- `node restart`

## ノード

`nodes` は Gateway と通信し、ペアリングされたノードを対象とします。[/nodes](/nodes) を参照してください。 [/nodes](/nodes) を参照してください。

共通オプション:

- `--url`, `--token`, `--timeout`, `--json`

サブコマンド:

- `nodes status [--connected] [--last-connected <duration>]`
- `nodes describe --node <id|name|ip>`
- `nodes list [--connected] [--last-connected <duration>]`
- `nodes pending`
- `nodes approve <requestId>`
- `nodes reject <requestId>`
- `nodes rename --node <id|name|ip> --name <displayName>`
- `nodes invoke --node <id|name|ip> --command <command> [--params <json>] [--invoke-timeout <ms>] [--idempotency-key <key>]`
- `nodes run --node <id|name|ip> [--cwd <path>] [--env KEY=VAL] [--command-timeout <ms>] [--needs-screen-recording] [--invoke-timeout <ms>] <command...>`（mac ノードまたはヘッドレス ノード ホスト）
- `nodes notify --node <id|name|ip> [--title <text>] [--body <text>] [--sound <name>] [--priority <passive|active|timeSensitive>] [--delivery <system|overlay|auto>] [--invoke-timeout <ms>]`（mac のみ）

カメラ:

- `nodes camera list --node <id|name|ip>`
- `nodes camera snap --node <id|name|ip> [--facing front|back|both] [--device-id <id>] [--max-width <px>] [--quality <0-1>] [--delay-ms <ms>] [--invoke-timeout <ms>]`
- `nodes camera clip --node <id|name|ip> [--facing front|back] [--device-id <id>] [--duration <ms|10s|1m>] [--no-audio] [--invoke-timeout <ms>]`

キャンバス + 画面:

- `nodes canvas snapshot --node <id|name|ip> [--format png|jpg|jpeg] [--max-width <px>] [--quality <0-1>] [--invoke-timeout <ms>]`
- `nodes canvas present --node <id|name|ip> [--target <urlOrPath>] [--x <px>] [--y <px>] [--width <px>] [--height <px>] [--invoke-timeout <ms>]`
- `nodes canvas hide --node <id|name|ip> [--invoke-timeout <ms>]`
- `nodes canvas navigate <url> --node <id|name|ip> [--invoke-timeout <ms>]`
- `nodes canvas eval [<js>] --node <id|name|ip> [--js <code>] [--invoke-timeout <ms>]`
- `nodes canvas a2ui push --node <id|name|ip> (--jsonl <path> | --text <text>) [--invoke-timeout <ms>]`
- `nodes canvas a2ui reset --node <id|name|ip> [--invoke-timeout <ms>]`
- `nodes screen record --node <id|name|ip> [--screen <index>] [--duration <ms|10s>] [--fps <n>] [--no-audio] [--out <path>] [--invoke-timeout <ms>]`

位置情報:

- `nodes location get --node <id|name|ip> [--max-age <ms>] [--accuracy <coarse|balanced|precise>] [--location-timeout <ms>] [--invoke-timeout <ms>]`

## ブラウザ

ブラウザ制御 CLI（専用の Chrome/Brave/Edge/Chromium）。[`openclaw browser`](/cli/browser) および [Browser ツール](/tools/browser) を参照してください。 [`openclaw browser`](/cli/browser) と [Browser tool](/tools/browser) を参照してください。

共通オプション:

- `--url`, `--token`, `--timeout`, `--json`
- `--browser-profile <name>`

管理:

- `browser status`
- `browser start`
- `browser stop`
- `browser reset-profile`
- `browser tabs`
- `browser open <url>`
- `browser focus <targetId>`
- `browser close [targetId]`
- `browser profiles`
- `browser create-profile --name <name> [--color <hex>] [--cdp-url <url>]`
- `browser delete-profile --name <name>`

検査:

- `browser screenshot [targetId] [--full-page] [--ref <ref>] [--element <selector>] [--type png|jpeg]`
- `browser snapshot [--format aria|ai] [--target-id <id>] [--limit <n>] [--interactive] [--compact] [--depth <n>] [--selector <sel>] [--out <path>]`

アクション:

- `browser navigate <url> [--target-id <id>]`
- `browser resize <width> <height> [--target-id <id>]`
- `browser click <ref> [--double] [--button <left|right|middle>] [--modifiers <csv>] [--target-id <id>]`
- `browser type <ref> <text> [--submit] [--slowly] [--target-id <id>]`
- `browser press <key> [--target-id <id>]`
- `browser hover <ref> [--target-id <id>]`
- `browser drag <startRef> <endRef> [--target-id <id>]`
- `browser select <ref> <values...> [--target-id <id>]`
- `browser upload <paths...> [--ref <ref>] [--input-ref <ref>] [--element <selector>] [--target-id <id>] [--timeout-ms <ms>]`
- `browser fill [--fields <json>] [--fields-file <path>] [--target-id <id>]`
- `browser dialog --accept|--dismiss [--prompt <text>] [--target-id <id>] [--timeout-ms <ms>]`
- `browser wait [--time <ms>] [--text <value>] [--text-gone <value>] [--target-id <id>]`
- `browser evaluate --fn <code> [--ref <ref>] [--target-id <id>]`
- `browser console [--level <error|warn|info>] [--target-id <id>]`
- `browser pdf [--target-id <id>]`

## ドキュメント検索

### `docs [query...]`

ライブ ドキュメント インデックスを検索します。

## TUI

### `tui`

Gateway に接続されたターミナル UI を開きます。

オプション:

- `--url <url>`
- `--token <token>`
- `--password <password>`
- `--session <key>`
- `--deliver`
- `--thinking <level>`
- `--message <text>`
- `--timeout-ms <ms>`（デフォルト: `agents.defaults.timeoutSeconds`）
- `--history-limit <n>`
