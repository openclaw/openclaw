---
summary: "〜/.openclaw/openclaw.json のすべての設定オプションを例付きで説明します"
read_when:
  - 設定フィールドを追加または変更する場合
title: "設定"
x-i18n:
  source_path: gateway/configuration.md
  source_hash: e226e24422c05e7e
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:22:13Z
---

# 設定 🔧

OpenClaw は、`~/.openclaw/openclaw.json` から任意の **JSON5** 設定を読み込みます（コメントおよび末尾カンマを許可）。

ファイルが存在しない場合、OpenClaw は安全寄りのデフォルト（組み込み Pi エージェント + 送信者ごとのセッション + ワークスペース `~/.openclaw/workspace`）を使用します。通常、設定が必要になるのは次の場合です。

- ボットをトリガーできるユーザーを制限する（`channels.whatsapp.allowFrom`、`channels.telegram.allowFrom` など）
- グループの許可リストとメンション動作を制御する（`channels.whatsapp.groups`、`channels.telegram.groups`、`channels.discord.guilds`、`agents.list[].groupChat`）
- メッセージのプレフィックスをカスタマイズする（`messages`）
- エージェントのワークスペースを設定する（`agents.defaults.workspace` または `agents.list[].workspace`）
- 組み込みエージェントのデフォルト（`agents.defaults`）およびセッション動作（`session`）を調整する
- エージェントごとのアイデンティティを設定する（`agents.list[].identity`）

> **設定が初めてですか？** 詳細な説明付きの完全な例については、[Configuration Examples](/gateway/configuration-examples) ガイドをご確認ください。

## 厳格な設定検証

OpenClaw は、スキーマに完全一致する設定のみを受け付けます。  
未知のキー、不正な型、無効な値がある場合、安全のため Gateway（ゲートウェイ）は **起動を拒否** します。

検証に失敗した場合：

- Gateway は起動しません。
- 診断コマンドのみが許可されます（例：`openclaw doctor`、`openclaw logs`、`openclaw health`、`openclaw status`、`openclaw service`、`openclaw help`）。
- 正確な問題点を確認するには `openclaw doctor` を実行してください。
- マイグレーション／修復を適用するには `openclaw doctor --fix`（または `--yes`）を実行してください。

Doctor は、`--fix`/`--yes` に明示的に同意しない限り、変更を書き込みません。

## スキーマ + UI ヒント

Gateway は、UI エディター向けに設定の JSON Schema 表現を `config.schema` 経由で公開します。  
Control UI はこのスキーマからフォームを生成し、エスケープハッチとして **Raw JSON** エディターを提供します。

チャンネルプラグインや拡張は、設定用のスキーマと UI ヒントを登録できるため、ハードコードされたフォームに依存せず、アプリ間でスキーマ駆動の設定を維持できます。

ヒント（ラベル、グルーピング、機密フィールドなど）はスキーマと一緒に提供され、クライアントは設定知識をハードコードせずに、より良いフォームを描画できます。

## 適用 + 再起動（RPC）

`config.apply` を使用すると、設定全体を検証・書き込みし、1 ステップで Gateway を再起動できます。  
再起動センチネルを書き込み、Gateway 復帰後に最後にアクティブだったセッションへ ping を送信します。

警告：`config.apply` は **設定全体** を置き換えます。  
一部のキーのみを変更したい場合は、`config.patch` または `openclaw config set` を使用してください。  
`~/.openclaw/openclaw.json` のバックアップを保持してください。

パラメータ：

- `raw`（string）— 設定全体の JSON5 ペイロード
- `baseHash`（任意）— `config.get` から取得した設定ハッシュ（既存設定がある場合は必須）
- `sessionKey`（任意）— ウェイクアップ ping 用の最後のアクティブセッションキー
- `note`（任意）— 再起動センチネルに含めるメモ
- `restartDelayMs`（任意）— 再起動までの遅延（デフォルト 2000）

例（`gateway call` 経由）：

```bash
openclaw gateway call config.get --params '{}' # capture payload.hash
openclaw gateway call config.apply --params '{
  "raw": "{\\n  agents: { defaults: { workspace: \\"~/.openclaw/workspace\\" } }\\n}\\n",
  "baseHash": "<hash-from-config.get>",
  "sessionKey": "agent:main:whatsapp:dm:+15555550123",
  "restartDelayMs": 1000
}'
```

## 部分更新（RPC）

`config.patch` を使用すると、無関係なキーを上書きせずに、既存設定へ部分更新をマージできます。  
JSON マージパッチのセマンティクスを適用します。

- オブジェクトは再帰的にマージ
- `null` はキーを削除
- 配列は置換

`config.apply` と同様に、検証・書き込みを行い、再起動センチネルを保存し、Gateway の再起動をスケジュールします（`sessionKey` が指定された場合はウェイクアップも行います）。

パラメータ：

- `raw`（string）— 変更するキーのみを含む JSON5 ペイロード
- `baseHash`（必須）— `config.get` から取得した設定ハッシュ
- `sessionKey`（任意）— ウェイクアップ ping 用の最後のアクティブセッションキー
- `note`（任意）— 再起動センチネルに含めるメモ
- `restartDelayMs`（任意）— 再起動までの遅延（デフォルト 2000）

例：

```bash
openclaw gateway call config.get --params '{}' # capture payload.hash
openclaw gateway call config.patch --params '{
  "raw": "{\\n  channels: { telegram: { groups: { \\"*\\": { requireMention: false } } } }\\n}\\n",
  "baseHash": "<hash-from-config.get>",
  "sessionKey": "agent:main:whatsapp:dm:+15555550123",
  "restartDelayMs": 1000
}'
```

## 最小設定（推奨の開始点）

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },
}
```

次のコマンドで、デフォルトイメージを一度ビルドします。

```bash
scripts/sandbox-setup.sh
```

## セルフチャットモード（グループ制御に推奨）

グループ内で WhatsApp の @ メンションに反応しないようにし、特定のテキストトリガーのみに反応させる場合：

```json5
{
  agents: {
    defaults: { workspace: "~/.openclaw/workspace" },
    list: [
      {
        id: "main",
        groupChat: { mentionPatterns: ["@openclaw", "reisponde"] },
      },
    ],
  },
  channels: {
    whatsapp: {
      // Allowlist is DMs only; including your own number enables self-chat mode.
      allowFrom: ["+15555550123"],
      groups: { "*": { requireMention: true } },
    },
  },
}
```

## 設定インクルード（`$include`）

`$include` ディレクティブを使用して、設定を複数ファイルに分割できます。これは次の用途に便利です。

- 大規模な設定の整理（例：クライアントごとのエージェント定義）
- 環境間での共通設定の共有
- 機密設定の分離

### 基本的な使い方

```json5
// ~/.openclaw/openclaw.json
{
  gateway: { port: 18789 },

  // Include a single file (replaces the key's value)
  agents: { $include: "./agents.json5" },

  // Include multiple files (deep-merged in order)
  broadcast: {
    $include: ["./clients/mueller.json5", "./clients/schmidt.json5"],
  },
}
```

```json5
// ~/.openclaw/agents.json5
{
  defaults: { sandbox: { mode: "all", scope: "session" } },
  list: [{ id: "main", workspace: "~/.openclaw/workspace" }],
}
```

### マージ動作

- **単一ファイル**：`$include` を含むオブジェクトを置換
- **配列ファイル**：順序どおりにディープマージ（後のファイルが前のファイルを上書き）
- **兄弟キーあり**：インクルード後に兄弟キーをマージ（インクルード値を上書き）
- **兄弟キー + 配列／プリミティブ**：非対応（インクルード内容はオブジェクトである必要があります）

```json5
// Sibling keys override included values
{
  $include: "./base.json5", // { a: 1, b: 2 }
  b: 99, // Result: { a: 1, b: 99 }
}
```

### ネストされたインクルード

インクルードされたファイル自体も `$include` ディレクティブを含めることができます（最大 10 階層）。

```json5
// clients/mueller.json5
{
  agents: { $include: "./mueller/agents.json5" },
  broadcast: { $include: "./mueller/broadcast.json5" },
}
```

### パス解決

- **相対パス**：インクルード元ファイルを基準に解決
- **絶対パス**：そのまま使用
- **親ディレクトリ**：`../` 参照は期待どおりに動作

```json5
{ "$include": "./sub/config.json5" }      // relative
{ "$include": "/etc/openclaw/base.json5" } // absolute
{ "$include": "../shared/common.json5" }   // parent dir
```

### エラーハンドリング

- **ファイル未存在**：解決後のパスを含む明確なエラー
- **パースエラー**：どのインクルードファイルで失敗したかを表示
- **循環インクルード**：検出され、インクルードチェーンとともに報告

### 例：マルチクライアントの法務向け構成

```json5
// ~/.openclaw/openclaw.json
{
  gateway: { port: 18789, auth: { token: "secret" } },

  // Common agent defaults
  agents: {
    defaults: {
      sandbox: { mode: "all", scope: "session" },
    },
    // Merge agent lists from all clients
    list: { $include: ["./clients/mueller/agents.json5", "./clients/schmidt/agents.json5"] },
  },

  // Merge broadcast configs
  broadcast: {
    $include: ["./clients/mueller/broadcast.json5", "./clients/schmidt/broadcast.json5"],
  },

  channels: { whatsapp: { groupPolicy: "allowlist" } },
}
```

```json5
// ~/.openclaw/clients/mueller/agents.json5
[
  { id: "mueller-transcribe", workspace: "~/clients/mueller/transcribe" },
  { id: "mueller-docs", workspace: "~/clients/mueller/docs" },
]
```

```json5
// ~/.openclaw/clients/mueller/broadcast.json5
{
  "120363403215116621@g.us": ["mueller-transcribe", "mueller-docs"],
}
```

## 共通オプション

### 環境変数 + `.env`

OpenClaw は、親プロセス（シェル、launchd/systemd、CI など）から環境変数を読み込みます。

さらに、次を読み込みます。

- カレントワーキングディレクトリにある `.env`（存在する場合）
- `~/.openclaw/.env`（別名 `$OPENCLAW_STATE_DIR/.env`）にあるグローバルフォールバック `.env`

どちらの `.env` ファイルも、既存の環境変数を上書きしません。

設定内でインライン環境変数を指定することもできます。これらは、プロセス環境にキーが存在しない場合にのみ適用されます（同じく上書きしません）。

```json5
{
  env: {
    OPENROUTER_API_KEY: "sk-or-...",
    vars: {
      GROQ_API_KEY: "gsk-...",
    },
  },
}
```

優先順位とソースの詳細は [/environment](/help/environment) を参照してください。

### `env.shellEnv`（任意）

利便性のためのオプトイン機能です。有効で、かつ期待されるキーがまだ設定されていない場合、OpenClaw はログインシェルを実行し、欠落している期待キーのみを取り込みます（上書きはしません）。  
これは実質的にシェルプロファイルを source する動作です。

```json5
{
  env: {
    shellEnv: {
      enabled: true,
      timeoutMs: 15000,
    },
  },
}
```

環境変数での指定：

- `OPENCLAW_LOAD_SHELL_ENV=1`
- `OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000`

### 設定内での環境変数置換

任意の設定文字列値で、`${VAR_NAME}` 構文を使用して環境変数を直接参照できます。  
変数は、検証前の設定読み込み時に置換されます。

```json5
{
  models: {
    providers: {
      "vercel-gateway": {
        apiKey: "${VERCEL_GATEWAY_API_KEY}",
      },
    },
  },
  gateway: {
    auth: {
      token: "${OPENCLAW_GATEWAY_TOKEN}",
    },
  },
}
```

**ルール：**

- 大文字の環境変数名のみが一致します：`[A-Z_][A-Z0-9_]*`
- 未定義または空の環境変数は、設定読み込み時にエラーとなります
- `$${VAR}` でエスケープすると、リテラルの `${VAR}` を出力します
- `$include` と併用可能（インクルードされたファイルでも置換されます）

**インライン置換：**

```json5
{
  models: {
    providers: {
      custom: {
        baseUrl: "${CUSTOM_API_BASE}/v1", // → "https://api.example.com/v1"
      },
    },
  },
}
```

## 認証ストレージ（OAuth + API キー）

OpenClaw は、**エージェントごと** の認証プロファイル（OAuth + API キー）を次に保存します。

- `<agentDir>/auth-profiles.json`（デフォルト：`~/.openclaw/agents/<agentId>/agent/auth-profiles.json`）

関連項目：[/concepts/oauth](/concepts/oauth)

レガシー OAuth のインポート：

- `~/.openclaw/credentials/oauth.json`（または `$OPENCLAW_STATE_DIR/credentials/oauth.json`）

組み込み Pi エージェントは、次にランタイムキャッシュを保持します。

- `<agentDir>/auth.json`（自動管理。手動編集はしないでください）

レガシーエージェントディレクトリ（マルチエージェント以前）：

- `~/.openclaw/agent/*`（`openclaw doctor` により `~/.openclaw/agents/<defaultAgentId>/agent/*` へ移行）

上書き：

- OAuth ディレクトリ（レガシーインポートのみ）：`OPENCLAW_OAUTH_DIR`
- エージェントディレクトリ（デフォルトエージェントルートの上書き）：`OPENCLAW_AGENT_DIR`（推奨）、`PI_CODING_AGENT_DIR`（レガシー）

初回使用時に、OpenClaw は `oauth.json` のエントリーを `auth-profiles.json` にインポートします。

### `auth`

認証プロファイル用の任意メタデータです。**シークレットは保存しません**。  
プロファイル ID をプロバイダー + モード（および任意のメール）にマッピングし、フェイルオーバー時に使用されるプロバイダーのローテーション順を定義します。

```json5
{
  auth: {
    profiles: {
      "anthropic:me@example.com": { provider: "anthropic", mode: "oauth", email: "me@example.com" },
      "anthropic:work": { provider: "anthropic", mode: "api_key" },
    },
    order: {
      anthropic: ["anthropic:me@example.com", "anthropic:work"],
    },
  },
}
```

### `agents.list[].identity`

デフォルトおよび UX に使用される、任意のエージェントごとのアイデンティティです。これは macOS のオンボーディングアシスタントによって書き込まれます。

設定されている場合、OpenClaw は（明示的に設定していない場合のみ）次のデフォルトを導出します。

- アクティブエージェントの `identity.emoji` から `messages.ackReaction`（フォールバックは 👀）
- エージェントの `identity.name`/`identity.emoji` から `agents.list[].groupChat.mentionPatterns`（Telegram/Slack/Discord/Google Chat/iMessage/WhatsApp のグループで「@Samantha」が機能します）
- `identity.avatar` は、ワークスペース相対の画像パス、またはリモート URL／data URL を受け付けます。ローカルファイルはエージェントワークスペース内に存在する必要があります。

`identity.avatar` が受け付ける値：

- ワークスペース相対パス（エージェントワークスペース内に限定）
- `http(s)` URL
- `data:` URI

```json5
{
  agents: {
    list: [
      {
        id: "main",
        identity: {
          name: "Samantha",
          theme: "helpful sloth",
          emoji: "🦥",
          avatar: "avatars/samantha.png",
        },
      },
    ],
  },
}
```

### `wizard`

CLI ウィザード（`onboard`、`configure`、`doctor`）によって書き込まれるメタデータです。

```json5
{
  wizard: {
    lastRunAt: "2026-01-01T00:00:00.000Z",
    lastRunVersion: "2026.1.4",
    lastRunCommit: "abc1234",
    lastRunCommand: "configure",
    lastRunMode: "local",
  },
}
```

### `logging`

- デフォルトのログファイル：`/tmp/openclaw/openclaw-YYYY-MM-DD.log`
- 安定したパスが必要な場合は、`logging.file` を `/tmp/openclaw/openclaw.log` に設定してください。
- コンソール出力は次で個別に調整できます。
  - `logging.consoleLevel`（デフォルト：`info`、`--verbose` のとき `debug` に昇格）
  - `logging.consoleStyle`（`pretty` | `compact` | `json`）
- ツール要約は、シークレット漏洩を防ぐためにマスクできます。
  - `logging.redactSensitive`（`off` | `tools`、デフォルト：`tools`）
  - `logging.redactPatterns`（正規表現文字列の配列。デフォルトを上書き）

```json5
{
  logging: {
    level: "info",
    file: "/tmp/openclaw/openclaw.log",
    consoleLevel: "info",
    consoleStyle: "pretty",
    redactSensitive: "tools",
    redactPatterns: [
      // Example: override defaults with your own rules.
      "\\bTOKEN\\b\\s*[=:]\\s*([\"']?)([^\\s\"']+)\\1",
      "/\\bsk-[A-Za-z0-9_-]{8,}\\b/gi",
    ],
  },
}
```

_次へ：[Agent Runtime](/concepts/agent)_ 🦞
