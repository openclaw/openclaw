---
summary: "〜/.openclaw/openclaw.json のすべての設定オプションを例付きで説明します"
read_when:
  - 設定フィールドを追加または変更する場合
title: "設定"
---

# 設定 🔧

OpenClaw は、`~/.openclaw/openclaw.json` から任意の **JSON5** 設定を読み込みます（コメントおよび末尾カンマを許可）。

ファイルが見つからない場合、OpenClawは安全なデフォルトを使用します(埋め込みPiエージェント+送信者ごとのセッション+ワークスペース`~/.openclaw/workspace`)。 通常は以下の設定のみが必要です:

- ボットをトリガーできるユーザーを制限する（`channels.whatsapp.allowFrom`、`channels.telegram.allowFrom` など）
- グループの許可リストとメンション動作を制御する（`channels.whatsapp.groups`、`channels.telegram.groups`、`channels.discord.guilds`、`agents.list[].groupChat`）
- メッセージのプレフィックスをカスタマイズする（`messages`）
- エージェントのワークスペースを設定する（`agents.defaults.workspace` または `agents.list[].workspace`）
- 組み込みエージェントのデフォルト（`agents.defaults`）およびセッション動作（`session`）を調整する
- エージェントごとのアイデンティティを設定する（`agents.list[].identity`）

> **設定が初めてですか？** 詳細な説明付きの完全な例については、[Configuration Examples](/gateway/configuration-examples) ガイドをご確認ください。

## 厳格な設定検証

OpenClawはスキーマと完全に一致する設定のみを受け付けます。
不明なキー、不正な型、または不正な値により、ゲートウェイは安全のために起動を拒否します。

検証に失敗した場合：

- Gateway は起動しません。
- 診断コマンドのみが許可されます（例：`openclaw doctor`、`openclaw logs`、`openclaw health`、`openclaw status`、`openclaw service`、`openclaw help`）。
- 正確な問題点を確認するには `openclaw doctor` を実行してください。
- マイグレーション／修復を適用するには `openclaw doctor --fix`（または `--yes`）を実行してください。

Doctor は、`--fix`/`--yes` に明示的に同意しない限り、変更を書き込みません。

## スキーマ + UI ヒント

ゲートウェイは、UI エディターの `config.schema` を介して設定の JSON スキーマ表現を公開します。
Control UI はこのスキーマからフォームをレンダリングし、**Raw JSON** エディタをエスケープハッチとして使用します。

チャンネルプラグインや拡張は、設定用のスキーマと UI ヒントを登録できるため、ハードコードされたフォームに依存せず、アプリ間でスキーマ駆動の設定を維持できます。

ヒント（ラベル、グルーピング、機密フィールドなど）はスキーマと一緒に提供され、クライアントは設定知識をハードコードせずに、より良いフォームを描画できます。

## 適用 + 再起動（RPC）

config.applyを使用すると、完全な設定を検証+書き込み、ゲートウェイを一度に再起動できます。
これは、再起動のセンチネルを書き込み、ゲートウェイが戻ってきた後の最後のアクティブセッションを ping させます。

警告: `config.apply` は **config** 全体を置き換えます。 24. いくつかのキーだけを変更したい場合は、`config.patch` または `openclaw config set` を使用してください。 `~/.openclaw/openclaw.json` のバックアップを保持します。

Params:

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

`config.patch` を使用すると、
関連のないキーをクローブせずに既存の設定に部分的な更新をマージできます。 JSON マージパッチセマンティクスを適用します:

- オブジェクトは再帰的にマージ
- `null` はキーを削除
- `config.apply` と同様に、検証・書き込みを行い、再起動センチネルを保存し、Gateway の再起動をスケジュールします（`sessionKey` が指定された場合はウェイクアップも行います）。

Params:

- `raw`（string）— 変更するキーのみを含む JSON5 ペイロード
- `baseHash`（必須）— `config.get` から取得した設定ハッシュ
- `sessionKey`（任意）— ウェイクアップ ping 用の最後のアクティブセッションキー
- `note`（任意）— 再起動センチネルに含めるメモ
- `restartDelayMs`（任意）— 再起動までの遅延（デフォルト 2000）

gateway/configuration.md

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

`$include`ディレクティブを使用して、設定を複数のファイルに分割します。 これは以下の場合に便利です:

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

### 統合の動作

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

### ネストされたものを含む

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

### Env vars + `.env`

OpenClaw は、親プロセス（シェル、launchd/systemd、CI など）から環境変数を読み込みます。

さらに、次を読み込みます。

- カレントワーキングディレクトリにある `.env`（存在する場合）
- `~/.openclaw/.env`（別名 `$OPENCLAW_STATE_DIR/.env`）にあるグローバルフォールバック `.env`

どちらの `.env` ファイルも、既存の環境変数を上書きしません。

また、configにインラインenv varsを指定することもできます。 これらは、
プロセス env がキーを欠落している場合にのみ適用されます (オーバーライドされていないルールと同じ)。

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

オプトインの利便性: 有効になっていて、期待されるキーのどれも設定されていない場合 OpenClawはログインシェルを実行し、期待されていないキーのみをインポートします(上書きはありません)。
これにより、シェルプロファイルが効果的に生成されます。

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

Env var equalent:

- `OPENCLAW_LOAD_SHELL_ENV=1`
- `OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000`

### 設定内での環境変数置換

`${VAR_NAME}` 構文を使用して、任意の設定文字列値で環境変数を直接参照できます。 変数は、検証前の設定読み込み時に置き換えられます。

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
- env varsが見つからないか空の場合、config loadでエラーが発生します。
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

### 認証ストレージ（OAuth + API キー）

OpenClaw は、**エージェントごと** の認証プロファイル（OAuth + API キー）を次に保存します。

- `<agentDir>/auth-profiles.json`（デフォルト：`~/.openclaw/agents/<agentId>/agent/auth-profiles.json`）

関連項目：[/concepts/oauth](/concepts/oauth)

レガシー OAuth のインポート：

- `~/.openclaw/credentials/oauth.json`（または `$OPENCLAW_STATE_DIR/credentials/oauth.json`）

組み込み Pi エージェントは、次にランタイムキャッシュを保持します。

- `<agentDir>/auth.json`（自動管理。手動編集はしないでください）

レガシーエージェントディレクトリ（マルチエージェント以前）：

- `~/.openclaw/agent/*`（`openclaw doctor` により `~/.openclaw/agents/<defaultAgentId>/agent/*` へ移行）

オーバーライド:

- OAuth ディレクトリ（レガシーインポートのみ）：`OPENCLAW_OAUTH_DIR`
- エージェントディレクトリ（デフォルトエージェントルートの上書き）：`OPENCLAW_AGENT_DIR`（推奨）、`PI_CODING_AGENT_DIR`（レガシー）

初回使用時に、OpenClaw は `oauth.json` のエントリーを `auth-profiles.json` にインポートします。

### `auth`

認証プロファイルのオプションのメタデータ。 これは **秘密を保存しません** 。
プロファイル ID をプロバイダー + モード (およびオプションのメール) にマッピングし、フェイルオーバーに使用されるプロバイダー
ローテーション注文を定義します。

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

デフォルトとUXに使用されるエージェントごとのオプションのID。 これはmacOSオンボーディングアシスタントによって書かれています。

設定されている場合、OpenClaw は（明示的に設定していない場合のみ）次のデフォルトを導出します。

- アクティブエージェントの `identity.emoji` から `messages.ackReaction`（フォールバックは 👀）
- エージェントの `identity.name`/`identity.emoji` から `agents.list[].groupChat.mentionPatterns`（Telegram/Slack/Discord/Google Chat/iMessage/WhatsApp のグループで「@Samantha」が機能します）
- `identity.avatar` はワークスペース相対的な画像パスまたはリモート URL/データ URL を受け付けます。 ローカルファイルはエージェントワークスペース内にある必要があります。

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
- ツール要約は、秘密の漏洩を避けるために編集することができます:
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

### `channels.whatsapp.dmPolicy`

WhatsAppダイレクトチャット (DMs) の処理方法を制御します。

- `"ペアリング"` (デフォルト): 未知の送信者はペアリングコードを取得します。所有者は承認する必要があります
- `"allowlist"`: `channels.whatsapp.allowFrom`（またはペアでallowstore）
- `"open"`: すべてのインバウンドDMを許可する (`channels.whatsapp.allowFrom` に `"*"`を含める)
- `"disabled"`: すべてのインバウンドDMを無視する

ペアリングコードは1時間後に失効します。ボットは新しいリクエストが作成されたときにのみペアリングコードを送信します。 保留中のDMペアリングリクエストはデフォルトで**3チャンネル**で上限されます。

ペアリング承認：

- `openclaw pairing list whatsapp`
- 25. `openclaw pairing approve whatsapp <code>`

### `channels.whatsapp.allowFrom`

WhatsAppの自動返信を引き起こす可能性のあるE.164電話番号の許可リスト(**DMのみ**)。
空と `channels.whatsapp.dmPolicy="ペアリング"`の場合、未知の送信者はペアリングコードを受け取ります。
グループの場合は、`channels.whatsapp.groupPolicy` + `channels.whatsapp.groupAllowFrom` を使用します。

```json5
26. {
  channels: {
    whatsapp: {
      dmPolicy: "pairing", // pairing | allowlist | open | disabled
      allowFrom: ["+15555550123", "+447700900123"],
      textChunkLimit: 4000, // optional outbound chunk size (chars)
      chunkMode: "length", // optional chunking mode (length | newline)
      mediaMaxMb: 50, // optional inbound media cap (MB)
    },
  },
}
```

### `channels.whatsapp.sendReceipts`

受信したWhatsAppメッセージが既読としてマークされているかどうかを制御します(青ティック)。 デフォルト: `true`

セルフチャットモードは、有効になっていても開封通知をスキップします。

アカウント毎のオーバーライド: `channels.whatsapp.accounts。<id>.sendReadeipts`

```json5
{
  channels: {
    whatsapp: { sendReadReceipts: false },
  },
}
```

### `channels.whatsapp.accounts` (multi-account)

1 つのゲートウェイで複数の WhatsApp アカウントを実行します:

```json5
27. {
  channels: {
    whatsapp: {
      accounts: {
        default: {}, // optional; keeps the default id stable
        personal: {},
        biz: {
          // Optional override. Default: ~/.openclaw/credentials/whatsapp/biz
          // authDir: "~/.openclaw/credentials/whatsapp/biz",
        },
      },
    },
  },
}
```

gpt-5.2-chat-latest

- アウトバウンドコマンドは、デフォルトで `default` を使用します。それ以外の場合は、最初に設定されたアカウント ID (ソート済み) を使用します。
- レガシーシングルアカウントのBaileys認証ディレクトリは`openclaw doctor`によって`whatsapp/default`に移行されます。

### `channels.telegram.accounts` / `channels.discord.accounts` / `channels.googlechat.accounts` / `channels.slack.accounts` / `channels.mattermost.accounts` / `channels.signal.accounts` / `channels.imessage.accounts`

チャンネルごとに複数のアカウントを実行します（各アカウントには独自の`accountId`とオプションの`name`があります）：

```json5
28. {
  channels: {
    telegram: {
      accounts: {
        default: {
          name: "Primary bot",
          botToken: "123456:ABC...",
        },
        alerts: {
          name: "Alerts bot",
          botToken: "987654:XYZ...",
        },
      },
    },
  },
}
```

パラメータ：

- `default` は `accountId` が省略された場合に使用されます (CLI + routing)。
- Env トークンは **default** アカウントにのみ適用されます。
- ベースチャネル設定 (グループポリシー、メンションゲートなど) アカウントごとに上書きされない限り、すべてのアカウントに適用されます。
- `bindings[].match.accountId` を使用して、それぞれのアカウントを異なるagents.defaultsにルーティングします。

### グループチャットメンションゲート(`agents.list[].groupChat` + `messages.groupChat` )

グループメッセージはデフォルトで**メンションを必要とします** (メタデータメンションまたは正規表現パターンのいずれか)。 WhatsApp、Telegram、Discord、Googleチャット、iMessageグループチャットに適用されます。

認証プロファイル用の任意メタデータです。**シークレットは保存しません**。  
プロファイル ID をプロバイダー + モード（および任意のメール）にマッピングし、フェイルオーバー時に使用されるプロバイダーのローテーション順を定義します。

- **メタデータの言及**: ネイティブプラットフォーム @-メンション(例: WhatsAppタップto-メンション)。 WhatsAppのセルフチャットモードで無視されます (`channels.whatsapp.allowFrom`を参照してください)。
- **テキストパターン**: `agents.list[].groupChat.mentionPatterns` に定義されている正規表現パターン。 セルフチャットモードに関係なく常にチェックします。
- メンションゲートは、メンション検出が可能な場合にのみ適用されます (ネイティブメンションまたは少なくとも1つの `mentionPattern` )。

```json5
29. {
  messages: {
    groupChat: { historyLimit: 50 },
  },
  agents: {
    list: [{ id: "main", groupChat: { mentionPatterns: ["@openclaw", "openclaw"] } }],
  },
}
```

`messages.groupChat.historyLimit` はグループ履歴コンテキストのグローバルデフォルトを設定します。 チャンネルは `channel で上書きできます。<channel>.historyLimit`（または `channels.<channel>マルチアカウントの.accounts.*.historyLimit`)。 `0` を設定すると履歴の折り返しが無効になります。

#### DM履歴の制限

DM の会話は、エージェントが管理するセッションベースの履歴を使用します。 DM セッションごとに保持されるユーザーのターン数を制限できます。

```json5
30. {
  channels: {
    telegram: {
      dmHistoryLimit: 30, // limit DM sessions to 30 user turns
      dms: {
        "123456789": { historyLimit: 50 }, // per-user override (user ID)
      },
    },
  },
}
```

解決順序:

1. DMごとのオーバーライド: `channel.<provider>.dms[userId].historyLimit`
2. プロバイダのデフォルト: `channel.<provider>.dmHistoryLimit`
3. 制限なし（すべての履歴を保持）

サポートされているプロバイダ: `telegram` 、 `whatsapp` 、 `discord` 、 `slack` 、 `signal` 、 `imessage` 、 `msteams` 。

エージェント毎のオーバーライド（`[]`でも設定時に優先されます）：

```json5
31. {
  agents: {
    list: [
      { id: "work", groupChat: { mentionPatterns: ["@workbot", "\\+15555550123"] } },
      { id: "personal", groupChat: { mentionPatterns: ["@homebot", "\\+15555550999"] } },
    ],
  },
}
```

メンションゲートのデフォルトはチャネルごとにライブ配信されます (`channels.whatsapp.groups`, `channels.telegram.groups`, `channels.imessage.groups`, `channels.discord.guilds`). `*.groups` が設定されている場合は、グループの許可リストとしても機能します。すべてのグループを許可する `"*"` を含めます。

特定のテキストトリガーに **のみ** と応答するには（ネイティブの @-メンションを無視）：

```json5
32. {
  channels: {
    whatsapp: {
      // Include your own number to enable self-chat mode (ignore native @-mentions).
      allowFrom: ["+15555550123"],
      groups: { "*": { requireMention: true } },
    },
  },
  agents: {
    list: [
      {
        id: "main",
        groupChat: {
          // Only these text patterns will trigger responses
          mentionPatterns: ["reisponde", "@openclaw"],
        },
      },
    ],
  },
}
```

### グループポリシー (チャネルごと)

`channels.*.groupPolicy` を使用して、グループ/ルームのメッセージが全く受け入れられるかどうかを制御します。

```json5
33. {
  channels: {
    whatsapp: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15551234567"],
    },
    telegram: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["tg:123456789", "@alice"],
    },
    signal: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15551234567"],
    },
    imessage: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["chat_id:123"],
    },
    msteams: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["user@org.com"],
    },
    discord: {
      groupPolicy: "allowlist",
      guilds: {
        GUILD_ID: {
          channels: { help: { allow: true } },
        },
      },
    },
    slack: {
      groupPolicy: "allowlist",
      channels: { "#general": { allow: true } },
    },
  },
}
```

上書き：

- `"open"`: groups bypass allowlists; mention-gating still applyes.
- `"disabled"`: すべてのグループ/ルームメッセージをブロックします。
- `"allowlist"`: 許可リストに一致するグループ/ルームのみを許可します。
- `channels.defaults.groupPolicy` はプロバイダの `groupPolicy` が設定されていない場合にデフォルトを設定します。
- WhatsApp/Telegram/Signal/iMessage/Microsoft Teams は `groupAllowFrom` を使用します(fallback: 明示的な `allowFrom`)。
- Discord/Slack use channel allowlist (`channels.discord.guilds.*.channels`, `channels.slack.channels`).
- グループ DM (Discord/Slack) はまだ `dm.groupEnabled` + `dm.groupChannels` で制御されています。
- デフォルトは `groupPolicy: "allowlist"` (`channels.defaults.groupPolicy` で上書きされない限り) です。許可リストが設定されていない場合、グループメッセージはブロックされます。

### マルチエージェントルーティング (`agents.list` + `bindings`)

1 つの Gateway 内で複数の孤立したエージェント (ワークスペース、`agentDir`、セッション) を実行します。
受信メッセージはバインディングを介してエージェントにルーティングされます。

- `agents.list[]`: エージェントごとに上書きします。
  - `id`: stable agent id (required).
  - `default`: 任意; 複数が設定されている場合、最初の勝利と警告が記録されます。
    何も設定されていない場合は、リストの**最初のエントリ**はデフォルトのエージェントです。
  - `name`: エージェントの表示名。
  - `workspace`: default `~/.openclaw/workspace-<agentId>` (`main`の場合、`agents.defaults.workspace`に戻ります)。
  - デフォルトおよび UX に使用される、任意のエージェントごとのアイデンティティです。これは macOS のオンボーディングアシスタントによって書き込まれます。
  - `model`: エージェント毎のデフォルトのモデルでは、そのエージェントの `agents.defaults.model` を上書きします。
    - string form: `"provider/model"`, overrides only `agents.defaults.model.primary`
    - object form: `{ primary, fallbacks }` (フォールバックが `agents.defaults.model.fallbacks` をオーバーライドします; `[]` はエージェントのグローバルフォールバックを無効にします)
  - `identity.avatar` は、ワークスペース相対の画像パス、またはリモート URL／data URL を受け付けます。ローカルファイルはエージェントワークスペース内に存在する必要があります。
  - `groupChat`: エージェントごとのメンションゲート(`mentionPatterns`)。
  - `sandbox`: エージェントごとの sandbox 設定 (`agents.defaults.sandbox` を上書きします)。
    - `mode`: `"off"` | `"non-main"` | `"all"`
    - `workspaceAccess`: `"none"` | `"ro"` | `"rw"`
    - `scope`: `"session"` | `"agent"` | `"shared"`
    - `workspaceRoot`: カスタムサンドボックスワークスペースルート
    - `docker`: per-agent docker overrides (e.g. `image`, `network`, `env`, `setupCommand`, limits; `scope: "shared"`)
    - `browser`: エージェントごとのサンドボックス化されたブラウザーのオーバーライド (`scope: "shared"`の場合は無視されます)
    - `prune`: エージェントごとに sandbox 剪定オーバーライド (`scope: "shared"`の場合は無視されます)
  - `subagents`: エージェント毎のサブエージェントのデフォルト。
    - `allowAgents`: allowlist of agent ids for `sessions_spawn` from this agent (`["*"]` = allow any; default: only same agent)
  - `tools`: エージェント毎のツール制限 (Sandbox ツールポリシーの前に適用)
    - `profile`: 基本ツールプロファイル (allow/denyの前に適用)
    - `allow`: 許可されているツール名の配列
    - `deny`: 拒否されたツール名の配列 (deny wins)
- `agents.defaults`: 共有エージェントのデフォルト (モデル、ワークスペース、サンドボックスなど)。
- `bindings[]`: `agentId` にインバウンドメッセージをルーティングします。
  - `match.channel` (必須)
  - `match.accountId` (省略可能; `*` = 任意のアカウント; 省略された = デフォルトのアカウント)
  - `match.peer` (optional; `{ kind: dm|group|channel, id }`)
  - `match.guildId` / `match.teamId` (オプション; channel-specific)

決定的な一致順序:

1. `match.peer`
2. `match.guildId`
3. `match.teamId`
4. `match.accountId` (正確にはピア/ギルド/チームなし)
5. `match.accountId: "*"` (チャネル全体、ピア/ギルド/チームなし)
6. デフォルトエージェント (`agents.list[].default`, else first list entry, else `"main"`)

各マッチ階層の中で、`bindings`の最初のマッチング項目が勝利します。

#### エージェント別アクセスプロファイル（マルチエージェント）

各エージェントは、独自のサンドボックス+ツールポリシーを運ぶことができます。 これを使用して、1 つのゲートウェイにアクセス
レベルをミックスします。

- **フルアクセス** (パーソナルエージェント)
- **読み取り専用** ツール + ワークスペース
- **ファイルシステムにアクセスできません** (メッセージ/セッションツールのみ)

[マルチエージェントのサンドボックスとツール](/tools/multi-agent-sandbox-tools) を参照してください。その他の例と
。

フルアクセス(サンドボックスなし):

```json5
{
  agents: {
    list: [
      {
        id: "personal",
        workspace: "~/.openclaw/workspace-personal",
        sandbox: { mode: "off" },
      },
    ],
  },
}
```

読み取り専用ツール + 読み取り専用ワークスペース:

```json5
34. {
  agents: {
    list: [
      {
        id: "family",
        workspace: "~/.openclaw/workspace-family",
        sandbox: {
          mode: "all",
          scope: "agent",
          workspaceAccess: "ro",
        },
        tools: {
          allow: [
            "read",
            "sessions_list",
            "sessions_history",
            "sessions_send",
            "sessions_spawn",
            "session_status",
          ],
          deny: ["write", "edit", "apply_patch", "exec", "process", "browser"],
        },
      },
    ],
  },
}
```

ファイルシステムへのアクセスがありません (メッセージング/セッションツールが有効化されています):

```json5
35. {
  agents: {
    list: [
      {
        id: "public",
        workspace: "~/.openclaw/workspace-public",
        sandbox: {
          mode: "all",
          scope: "agent",
          workspaceAccess: "none",
        },
        tools: {
          allow: [
            "sessions_list",
            "sessions_history",
            "sessions_send",
            "sessions_spawn",
            "session_status",
            "whatsapp",
            "telegram",
            "slack",
            "discord",
            "gateway",
          ],
          deny: [
            "read",
            "write",
            "edit",
            "apply_patch",
            "exec",
            "process",
            "browser",
            "canvas",
            "nodes",
            "cron",
            "gateway",
            "image",
          ],
        },
      },
    ],
  },
}
```

例: 2つの WhatsApp アカウント → 2つのエージェント

```json5
36. {
  agents: {
    list: [
      { id: "home", default: true, workspace: "~/.openclaw/workspace-home" },
      { id: "work", workspace: "~/.openclaw/workspace-work" },
    ],
  },
  bindings: [
    { agentId: "home", match: { channel: "whatsapp", accountId: "personal" } },
    { agentId: "work", match: { channel: "whatsapp", accountId: "biz" } },
  ],
  channels: {
    whatsapp: {
      accounts: {
        personal: {},
        biz: {},
      },
    },
  },
}
```

### `tools.agentToAgent` (任意)

エージェントからエージェントへのメッセージングはオプトインです:

```json5
{
  tools: {
    agentToAgent: {
      enabled: false,
      allow: ["home", "work"],
    },
  },
}
```

### `messages.queue`

エージェントの実行がすでにアクティブなときに受信メッセージがどのように動作するかを制御します。

```json5
37. {
  messages: {
    queue: {
      mode: "collect", // steer | followup | collect | steer-backlog (steer+backlog ok) | interrupt (queue=steer legacy)
      debounceMs: 1000,
      cap: 20,
      drop: "summarize", // old | new | summarize
      byChannel: {
        whatsapp: "collect",
        telegram: "collect",
        discord: "collect",
        imessage: "collect",
        webchat: "collect",
      },
    },
  },
}
```

### `messages.inbound`

**同じ送信者**からの迅速な受信メッセージをデバウンスすることで、複数の
メッセージが単一のエージェントターンになります。 38. デバウンスはチャンネル＋会話ごとにスコープされ、返信のスレッド化／ID には最新のメッセージが使用されます。

```json5
39. {
  messages: {
    inbound: {
      debounceMs: 2000, // 0 disables
      byChannel: {
        whatsapp: 5000,
        slack: 1500,
        discord: 1500,
      },
    },
  },
}
```

注記：

- **テキストのみ** のメッセージをデバウンスします; メディア/添付ファイルはすぐにフラッシュします。
- 制御コマンド (例: `/queue`, `/new`) は単独のままになるようにデバウンスをバイパスします。

### `commands` (チャットコマンドの処理)

コネクタ間でチャットコマンドを有効にする方法を設定します。

```json5
40. {
  commands: {
    native: "auto", // register native commands when supported (auto)
    text: true, // parse slash commands in chat messages
    bash: false, // allow ! (alias: /bash) (host-only; requires tools.elevated allowlists)
    bashForegroundMs: 2000, // bash foreground window (0 backgrounds immediately)
    config: false, // allow /config (writes to disk)
    debug: false, // allow /debug (runtime-only overrides)
    restart: false, // allow /restart + gateway restart tool
    useAccessGroups: true, // enforce access-group allowlists/policies for commands
  },
}
```

注記：

- テキストコマンドは、**スタンドアロン** メッセージとして送信し、先頭の `/` (プレーンテキストエイリアスなし) を使用する必要があります。
- `commands.text: false` はチャットメッセージの解析を無効にします。
- `commands.native: "auto"` (デフォルト) はDiscord/Telegramのネイティブコマンドをオンにし、Slackをオフにします。サポートされていないチャンネルはテキストのみのままです。
- `commands.native: true|false` を設定すると、チャンネルごとに強制的に設定したり、`channels.discord.commands.native` 、 `channels.telegram.commands.native` 、 `channels.slack.commands.native` (bool または `"auto"`) でオーバーライドしたりできます。 `false` は起動時にDiscord/Telegramで登録されているコマンドをクリアします。SlackのコマンドはSlackアプリで管理されます。
- `channels.telegram.customCommands` は追加のTelegramボットメニューエントリを追加します。 名前は正規化されます; ネイティブコマンドとの競合は無視されます。
- `commands.bash: true` で `! <cmd>`はホストシェルコマンドを実行します(`/bash <cmd>`もエイリアスとして動作します)。 `tools.elevated.enabled` が必要で、`tools.elevated.allowFrom.<channel>` 配下に置きます。
- `commands.bashForegroundMs` は、バックグラウンドの前にバッシュが待機する時間を制御します。 bash ジョブが実行されている間、新しい `! <cmd>` リクエストは拒否されます (一度に 1 つ)。
- `config.patch` を使用すると、無関係なキーを上書きせずに、既存設定へ部分更新をマージできます。  
  JSON マージパッチのセマンティクスを適用します。
- `channel.<provider>.configWrites`は、そのチャンネルによって開始された設定変更をゲートします (デフォルト: true)。 これは `/config set|unset` に加えて、プロバイダ固有の自動移行 (Telegram スーパー グループ ID の変更、Slack チャンネル ID の変更) に適用されます。
- `commands.debug: true` は `/debug` を有効にします (ランタイムのみの上書き)。
- `commands.restart: true` は `/restart` とゲートウェイツールの再起動アクションを有効にします。
- `commands.useAccessGroups: false` を使用すると、アクセス許可グループ/ポリシーを回避できます。
- スラッシュコマンドとディレクティブは **authorized 送信者** に対してのみ使用されます。 Authorization は
  channel allowlists/pairing plus `commands.useAccessGroups` に由来します。

### `web` (WhatsApp Web channel runtime)

WhatsAppはゲートウェイのウェブチャンネル(ベイリースウェブ)を通じて実行されます。 リンクされたセッションが存在すると自動的に開始します。
デフォルトではオフにするには、 `web.enabled: false` を設定します。

```json5
1. {
  web: {
    enabled: true,
    heartbeatSeconds: 60,
    reconnect: {
      initialMs: 2000,
      maxMs: 120000,
      factor: 1.4,
      jitter: 0.2,
      maxAttempts: 0,
    },
  },
}
```

### `channels.telegram` (botのトランスポート)

OpenClawは、`channels.telegram`設定セクションが存在する場合にのみTelegramを起動します。 ボットトークンは `channels.telegram.botToken` (または `channels.telegram.tokenFile` )から解決され、`TELEGRAM_BOT_TOKEN` はデフォルトアカウントのフォールバックとして使用されます。
自動起動を無効にするには、`channels.telegram.enabled: false` を設定してください。
複数アカウントのサポートは `channels.telegram.accounts` のもとで行われます（上記のマルチアカウントセクションを参照）。 Envトークンはデフォルトのアカウントにのみ適用されます。
`channels.telegram.configWrites: false` を設定して、Telegramが起動する設定への書き込みをブロックします(スーパーグループ ID の移行と `/config set|unset` を含みます)。

```json5
2. {
  channels: {
    telegram: {
      enabled: true,
      botToken: "your-bot-token",
      dmPolicy: "pairing", // pairing | allowlist | open | disabled
      allowFrom: ["tg:123456789"], // optional; "open" requires ["*"]
      groups: {
        "*": { requireMention: true },
        "-1001234567890": {
          allowFrom: ["@admin"],
          systemPrompt: "Keep answers brief.",
          topics: {
            "99": {
              requireMention: false,
              skills: ["search"],
              systemPrompt: "Stay on topic.",
            },
          },
        },
      },
      customCommands: [
        { command: "backup", description: "Git backup" },
        { command: "generate", description: "Create an image" },
      ],
      historyLimit: 50, // include last N group messages as context (0 disables)
      replyToMode: "first", // off | first | all
      linkPreview: true, // toggle outbound link previews
      streamMode: "partial", // off | partial | block (draft streaming; separate from block streaming)
      draftChunk: {
        // optional; only for streamMode=block
        minChars: 200,
        maxChars: 800,
        breakPreference: "paragraph", // paragraph | newline | sentence
      },
      actions: { reactions: true, sendMessage: true }, // tool action gates (false disables)
      reactionNotifications: "own", // off | own | all
      mediaMaxMb: 5,
      retry: {
        // outbound retry policy
        attempts: 3,
        minDelayMs: 400,
        maxDelayMs: 30000,
        jitter: 0.1,
      },
      network: {
        // transport overrides
        autoSelectFamily: false,
      },
      proxy: "socks5://localhost:9050",
      webhookUrl: "https://example.com/telegram-webhook", // requires webhookSecret
      webhookSecret: "secret",
      webhookPath: "/telegram-webhook",
    },
  },
}
```

下書きストリーミングノート:

- Telegram `sendMessageDraft` (実際のメッセージではなくバブルの下書き) を使用します。
- **プライベートチャットのトピック** (DMでmessage_thread_id; botはトピックを有効にしています) が必要です。
- `/reasoning stream` は下書きに推論をストリームし、最終的な答えを送ります。
  3. 再試行ポリシーのデフォルトと挙動は、[Retry policy](/concepts/retry) に記載されています。

### `channels.discord` (botのトランスポート)

ボットトークンとオプションのゲートを設定してDiscordボットを設定します。
`channels.discord.accounts` のマルチアカウントサポートは有効です（上記のマルチアカウントセクションを参照）。 Envトークンはデフォルトのアカウントにのみ適用されます。

```json5
4. {
  channels: {
    discord: {
      enabled: true,
      token: "your-bot-token",
      mediaMaxMb: 8, // clamp inbound media size
      allowBots: false, // allow bot-authored messages
      actions: {
        // tool action gates (false disables)
        reactions: true,
        stickers: true,
        polls: true,
        permissions: true,
        messages: true,
        threads: true,
        pins: true,
        search: true,
        memberInfo: true,
        roleInfo: true,
        roles: false,
        channelInfo: true,
        voiceStatus: true,
        events: true,
        moderation: false,
      },
      replyToMode: "off", // off | first | all
      dm: {
        enabled: true, // disable all DMs when false
        policy: "pairing", // pairing | allowlist | open | disabled
        allowFrom: ["1234567890", "steipete"], // optional DM allowlist ("open" requires ["*"])
        groupEnabled: false, // enable group DMs
        groupChannels: ["openclaw-dm"], // optional group DM allowlist
      },
      guilds: {
        "123456789012345678": {
          // guild id (preferred) or slug
          slug: "friends-of-openclaw",
          requireMention: false, // per-guild default
          reactionNotifications: "own", // off | own | all | allowlist
          users: ["987654321098765432"], // optional per-guild user allowlist
          channels: {
            general: { allow: true },
            help: {
              allow: true,
              requireMention: true,
              users: ["987654321098765432"],
              skills: ["docs"],
              systemPrompt: "Short answers only.",
            },
          },
        },
      },
      historyLimit: 20, // include last N guild messages as context
      textChunkLimit: 2000, // optional outbound text chunk size (chars)
      chunkMode: "length", // optional chunking mode (length | newline)
      maxLinesPerMessage: 17, // soft max lines per message (Discord UI clipping)
      retry: {
        // outbound retry policy
        attempts: 3,
        minDelayMs: 500,
        maxDelayMs: 30000,
        jitter: 0.1,
      },
    },
  },
}
```

OpenClawは、`channels.discord`設定セクションが存在する場合にのみDiscordを開始します。 トークンは`channels.discord.token`から解決され、`DISCORD_BOT_TOKEN`をデフォルトのアカウントのフォールバックにします（`channels.discord.enabled`が`false`でない限り）。 cron/CLI コマンドの配信ターゲットを指定する場合は、`user:<id>` または `channel:<id>` (guild channel) を使用します。
ギルドスラグは小文字でスペースは`-`に置き換えられます。チャンネルキーはスラッグされたチャンネル名(先頭は`#`)を使用しません。 ギルドIDをキーとして設定し、曖昧さの名前を変更しないようにします。
Bot-authored messages はデフォルトでは無視されます。 `channels.discord.allowBots` を有効にします（自己返信ループを防ぐため、独自のメッセージはまだフィルタされています）。
リアクション通知モード:

- `off`: リアクションイベントなし。
- `own`: ボット自身のメッセージへのリアクション（デフォルト）。
- `all`: すべてのメッセージへのすべてのリアクション。
- `allowlist`: `guilds.<id>.users` からのリアクションのみ（空リストで無効）。
  アウトバウンドテキストは `channels.discord.textChunkLimit` (デフォルトは2000)。 `channels.discord.chunkMode="newline"を設定すると、長さが分割される前に空白の行 (段落境界) に分割されます。 Discordクライアントは非常に背の高いメッセージをクリップできます。そのため、`channels.discord.maxLinesPerMessage\` (デフォルト17) は2000文字以下であっても長い複数行の返信を分割します。
  5. 再試行ポリシーのデフォルトと挙動は、[Retry policy](/concepts/retry) に記載されています。

### `channels.googlechat` (Chat API webhook)

Google チャットはアプリレベルの認証(サービスアカウント)を使用してHTTPウェブフック上で実行されます。
マルチアカウントのサポートは `channels.googlechat.accounts` の下で行われます(上記のマルチアカウントのセクションを参照してください)。 Env var は既定のアカウントにのみ適用されます。

```json5
6. {
  channels: {
    googlechat: {
      enabled: true,
      serviceAccountFile: "/path/to/service-account.json",
      audienceType: "app-url", // app-url | project-number
      audience: "https://gateway.example.com/googlechat",
      webhookPath: "/googlechat",
      botUser: "users/1234567890", // optional; improves mention detection
      dm: {
        enabled: true,
        policy: "pairing", // pairing | allowlist | open | disabled
        allowFrom: ["users/1234567890"], // optional; "open" requires ["*"]
      },
      groupPolicy: "allowlist",
      groups: {
        "spaces/AAAA": { allow: true, requireMention: true },
      },
      actions: { reactions: true },
      typingIndicator: "message",
      mediaMaxMb: 20,
    },
  },
}
```

パラメータ：

- Service account JSON can be inline (`serviceAccount`) or file based (`serviceAccountFile`).
- デフォルトアカウントのEnvフォールバック：`GOOGLE_CHAT_SERVICE_ACCOUNT` または `GOOGLE_CHAT_SERVCOUNT_FILE` 。
- `audienceType` + `audience` はチャットアプリのwebhook認証設定と一致する必要があります。
- デリバリターゲットを設定する場合は、`spaces/<spaceId>` または `users/<userId|email>` を使用します。

### `channels.slack` (ソケットモード)

Slackはソケットモードで実行され、Botトークンとappトークンの両方が必要です:

```json5
7. {
  channels: {
    slack: {
      enabled: true,
      botToken: "xoxb-...",
      appToken: "xapp-...",
      dm: {
        enabled: true,
        policy: "pairing", // pairing | allowlist | open | disabled
        allowFrom: ["U123", "U456", "*"], // optional; "open" requires ["*"]
        groupEnabled: false,
        groupChannels: ["G123"],
      },
      channels: {
        C123: { allow: true, requireMention: true, allowBots: false },
        "#general": {
          allow: true,
          requireMention: true,
          allowBots: false,
          users: ["U123"],
          skills: ["docs"],
          systemPrompt: "Short answers only.",
        },
      },
      historyLimit: 50, // include last N channel/group messages as context (0 disables)
      allowBots: false,
      reactionNotifications: "own", // off | own | all | allowlist
      reactionAllowlist: ["U123"],
      replyToMode: "off", // off | first | all
      thread: {
        historyScope: "thread", // thread | channel
        inheritParent: false,
      },
      actions: {
        reactions: true,
        messages: true,
        pins: true,
        memberInfo: true,
        emojiList: true,
      },
      slashCommand: {
        enabled: true,
        name: "openclaw",
        sessionPrefix: "slack:slash",
        ephemeral: true,
      },
      textChunkLimit: 4000,
      chunkMode: "length",
      mediaMaxMb: 20,
    },
  },
}
```

マルチアカウントのサポートは `channels.slack.accounts` の下で行われます。(上記のマルチアカウントのセクションを参照してください)。 Envトークンはデフォルトのアカウントにのみ適用されます。

OpenClawはプロバイダが有効になっていて、両方のトークンが(設定または`SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN`を介して)設定されているときにSlackを起動します。 cron/CLI コマンドの配信ターゲットを指定する場合は、`user:<id>` または `channel:<id>` を使用します。
`channels.slack.configWrites: false` を設定して、Slackで開始された設定への書き込みをブロックします(チャンネル ID の移行と `/config set|unset` を含みます)。

Bot-authored messages はデフォルトでは無視されます。 `channels.slack.allowBots` または `channels.slack.channels.slack.channel<id>.allowBots` で有効化できます。

リアクション通知モード:

- `off`: リアクションイベントなし。
- `own`: ボット自身のメッセージへのリアクション（デフォルト）。
- `all`: すべてのメッセージへのすべてのリアクション。
- `allowlist`: reactions from `channels.slack.reactionAllowlist` on all messages (empty list disables).

スレッドセッション分離:

- `channels.slack.thread.historyScope` は、スレッドごとの履歴(`thread`, default)かチャンネル間で共有されるかどうかを制御します。
- `channels.slack.thread.legitParent` は、新しいスレッドセッションが親チャンネルトランスクリプトを継承するかどうかを制御します (デフォルト: false)。

Slack アクショングループ (gate `slack` tools actions):

| アクショングループ  | デフォルト   | Notes             |
| ---------- | ------- | ----------------- |
| reactions  | enabled | React + リアクションリスト |
| messages   | enabled | 読み取り/送信/編集/削除     |
| pins       | enabled | ピン/解除/一覧          |
| memberInfo | enabled | メンバー情報            |
| emojiList  | enabled | カスタム絵文字一覧         |

### `channels.mattermost` (botトークン)

Mattermost はプラグインとして提供されており、コアインストールには同梱されていません。
最初にインストールします: `openclaw/mattermost` (または git checkoutから `./extensions/mattermost` )。

MattermostにはBotトークンとサーバーのベース URLが必要です:

```json5
8. {
  channels: {
    mattermost: {
      enabled: true,
      botToken: "mm-token",
      baseUrl: "https://chat.example.com",
      dmPolicy: "pairing",
      chatmode: "oncall", // oncall | onmessage | onchar
      oncharPrefixes: [">", "!"],
      textChunkLimit: 4000,
      chunkMode: "length",
    },
  },
}
```

OpenClawはアカウントが設定されて有効になっている場合、Mattermostを開始します。 トークン + ベース URL は `channels.mattermost.botToken` + `channels.mattermost.baseUrl` または `MATTERMOST_BOT_TOKEN` + `MATTERMOST_URL` から解決されます (`channels.mattermost.enabled` が`false`でない限り)。

チャットモード:

- `oncall` (default): @メンションされたときにのみチャネルメッセージに応答します。
- `onmessage`: すべてのチャンネルメッセージに応答します。
- `onchar`: メッセージがトリガープレフィックスで始まるときに応答します (`channels.mattermost.oncharPrefixes`, default `[">", "!"]`)。

アクセス制御:

- デフォルトのDM: `channels.matter.dmPolicy="ペアリング"` (未知の送信者はペアリングコードを取得します)。
- 公開 DM: `channels.mattermost.dmPolicy="open"` に加えて `channels.mattermost.allowFrom=["*"]`。
- Groups: `channels.mattermost.groupPolicy="allowlist"` by default (mention-gated). 送信者を制限するには、 `channels.mattermost.groupAllowFrom` を使用してください。

複数アカウントのサポートは `channels.mattermost.accounts` の下で行われます (上記のマルチアカウントのセクションを参照してください)。 Env var は既定のアカウントにのみ適用されます。
配送ターゲットを指定するときは、`channel:<id>` または `user:<id>` (または `@username`) を使用します。裸の id はチャンネル ID として扱われます。

### `channels.signal` (signal-cli)

シグナルリアクションはシステムイベントを発生させることができます (共有リアクションツール):

```json5
9. {
  channels: {
    signal: {
      reactionNotifications: "own", // off | own | all | allowlist
      reactionAllowlist: ["+15551234567", "uuid:123e4567-e89b-12d3-a456-426614174000"],
      historyLimit: 50, // include last N group messages as context (0 disables)
    },
  },
}
```

リアクション通知モード:

- `off`: リアクションイベントなし。
- `own`: ボット自身のメッセージへのリアクション（デフォルト）。
- `all`: すべてのメッセージへのすべてのリアクション。
- `allowlist`: reactions from `channels.signal.reactionAllowlist` on all messages (empty list disables).

### `channels.imessage` (imsg CLI)

OpenClawは`imsg rpc` (stdio上でJSON-RPC) を生成します。 デーモンやポートは必要ありません。

```json5
10. {
  channels: {
    imessage: {
      enabled: true,
      cliPath: "imsg",
      dbPath: "~/Library/Messages/chat.db",
      remoteHost: "user@gateway-host", // SCP for remote attachments when using SSH wrapper
      dmPolicy: "pairing", // pairing | allowlist | open | disabled
      allowFrom: ["+15555550123", "user@example.com", "chat_id:123"],
      historyLimit: 50, // include last N group messages as context (0 disables)
      includeAttachments: false,
      mediaMaxMb: 16,
      service: "auto",
      region: "US",
    },
  },
}
```

複数アカウントのサポートは `channels.imessage.accounts` の下で行われます (上記のマルチアカウントのセクションを参照してください)。

環境変数での指定：

- メッセージDBへのフルディスクアクセスが必要です。
- 最初の送信はメッセージの自動化権限を求めます。
- `chat_id:<id>` ターゲットを設定します。 チャット一覧を表示するには `imsg chats --limit 20` を使用します。
- `channels.imessage.cliPath`はラッパースクリプトを指すことができます(例えば `ssh`は`imsg rpc`を実行する別のMacを指す)。パスワードプロンプトを避けるためにSSHキーを使用します。
- リモートの SSH ラッパーの場合は、`includeAttachments` が有効になっている場合、SCP 経由で添付ファイルをフェッチするために `channels.imessage.remoteHost` を設定します。

ツール要約は、シークレット漏洩を防ぐためにマスクできます。

```bash
#!/usr/bin/env bash
exec ssh -T gateway-host imsg "$@"
```

### `agents.defaults.workspace`

エージェントがファイル操作で使用する **単一のグローバルワークスペースディレクトリ** を設定します。

デフォルト: `~/.openclaw/workspace`.

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
}
```

11. `agents.defaults.sandbox` が有効な場合、非メインのセッションは `agents.defaults.sandbox.workspaceRoot` 配下にある各スコープごとのワークスペースで、この設定を上書きできます。

### `agents.defaults.repoRoot`

システムプロンプトのランタイムラインに表示するオプションのリポジトリルート。 未設定の場合、OpenClaw
はワークスペース (および現在の
作業ディレクトリ) から `.git` ディレクトリを検出しようとします。 使用するにはパスが存在する必要があります。

```json5
{
  agents: { defaults: { repoRoot: "~/Projects/openclaw" } },
}
```

### `agents.defaults.skipBootstrap`

ワークスペースのブートストラップファイル (`AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, `BOOTSTRAP.md`) の自動作成を無効にします。

ワークスペース・ファイルがリポジトリから生成される、事前シードされたデプロイメントに使用します。

```json5
{
  agents: { defaults: { skipBootstrap: true } },
}
```

### `agents.defaults.bootstrapMaxChars`

12. 切り詰めが行われる前に、システムプロンプトへ注入される各ワークスペースのブートストラップファイルの最大文字数。 デフォルト: `20000`.

ファイルがこの制限を超えると、OpenClawは警告をログに記録し、マーカーと共に切り捨てられた
の頭/尾を注入します。

```json5
{
  agents: { defaults: { bootstrapMaxChars: 20000 } },
}
```

### `agents.defaults.userTimezone`

**システムプロンプトコンテキスト** のユーザーのタイムゾーンを設定します (
メッセージエンベロープのタイムスタンプではありません)。 未設定の場合、OpenClawは実行時にホストタイムゾーンを使用します。

```json5
{
  agents: { defaults: { userTimezone: "America/Chicago" } },
}
```

### `agents.defaults.timeFormat`

システムプロンプトの現在の日付と時刻のセクションに表示される**時刻フォーマット**を制御します。
デフォルト: `auto` (OS 設定)

```json5
{
  agents: { defaults: { timeFormat: "auto" } }, // auto | 12 | 24
}
```

### `メッセージ`

inbound/outboundプレフィックスと任意のackリアクションをコントロールします。
キュー、セッション、ストリーミングコンテキストについては、 [Messages](/concepts/messages) を参照してください。

```json5
{
  messages: {
    responsePrefix: "🦞", // or "auto"
    ackReaction: "👀",
    ackReactionScope: "group-mentions",
    removeAckAfterReply: false,
  },
}
```

`responsePrefix` は、すでに存在しない限り、チャンネルを横断する **すべてのアウトバウンド返信** (ツールサマリ、
ストリーミング、最終返信をブロック) に適用されます。

上書きは、チャンネルごとおよびアカウントごとに設定できます:

- `channels.<channel>.responsePrefix`
- `channels.<channel>.accounts.<id>.responsePrefix`

解決順（最も具体的なものが優先）：

1. `channels.<channel>.accounts.<id>.responsePrefix`
2. `channels.<channel>.responsePrefix`
3. `messages.responsePrefix`

セマンティクス:

- `undefined` は次のレベルに落ちます。
- `""` はプレフィックスを明示的に無効にし、カスケードを停止します。
- `"auto"`はルーティングされたエージェントに対して`[{identity.name}]`を派生します。

オーバーライドは、拡張機能を含むすべてのチャンネル、およびすべてのアウトバウンド返信の種類に適用されます。

`messages.responsePrefix` が設定されていない場合、デフォルトではプレフィックスは適用されません。 13. WhatsApp の自己チャット返信は例外です。設定されている場合は既定で `[{identity.name}]` を使用し、そうでない場合は `[openclaw]` となります。これにより、同一端末内の会話の可読性が保たれます。
ルーティングされたエージェントの`[{identity.name}]`を導出するには、`"auto"`に設定します。

#### テンプレート変数

`responsePrefix` 文字列には、動的に解決するテンプレート変数を含めることができます。

| 変数                | 説明         | マージ動作                               |
| ----------------- | ---------- | ----------------------------------- |
| `{model}`         | 短いモデル名     | `claude-opus-4-6`, `gpt-4o`         |
| `{modelFull}`     | フルモデル識別子   | `anthropic/claude-opus-4-6`         |
| `{provider}`      | プロバイダー名    | `anthropic`, `openai`               |
| `{thinkingLevel}` | 現在の思考レベル   | `high`, `low`, `off`                |
| `{identity.name}` | エージェントの身元名 | (\`"auto"モードと同じ) |

変数は大文字小文字を区別しません (`{MODEL}` = `{model}`)。 `{think}` は `{thinkingLevel} ` のエイリアスです。
未解決の変数はリテラルテキストとして残ります。

```json5
{
  messages: {
    responsePrefix: "[{model} | think:{thinkingLevel}]",
  },
}
```

出力例: `[claude-opus-4-6 | think:high] ここが私の返事です...`

WhatsAppインバウンドプレフィックスは、 `channels.whatsapp.messagePrefix` を介して設定されています(非推奨:
`message.messagePrefix` )。 14. 既定は **変更されません**：`channels.whatsapp.allowFrom` が空の場合は `"[openclaw]"`、それ以外の場合は `""`（プレフィックスなし）です。 15. `"[openclaw]"` を使用している場合、ルーティングされたエージェントに `identity.name` が設定されていれば、OpenClaw は代わりに `[{identity.name}]` を使用します。

16. `ackReaction` は、リアクションをサポートするチャンネル（Slack/Discord/Telegram/Google Chat）で、受信メッセージの受領を示すためにベストエフォートで絵文字リアクションを送信します。 デフォルトでは、
    アクティブエージェントの `identity.emoji` が設定されています。設定されていない場合は `"👀"` です。 無効にするには `""` に設定します。

`ackReactionScope` はリアクションが発生したときに制御します。

- `group-mentions` (デフォルト): グループ/ルームでメンションが必要な場合のみ **and** Botがメンションされています
- `group-all`: すべてのグループ/ルームメッセージ
- `direct`: ダイレクトメッセージのみ
- `all`: すべてのメッセージ

`removeAckAfterReply`は、返信を
（Slack/Discord/Telegram/Google チャットのみ）した後、ボットのリアクションを削除します。 デフォルト: `false`

#### `messages.tts`

発信返信のテキスト読み上げを有効にします。 17. 有効にすると、OpenClaw は ElevenLabs または OpenAI を使用して音声を生成し、返信に添付します。 TelegramはOpus
音声ノートを使用します。他のチャンネルはMP3オーディオを送信します。

```json5
18. {
  messages: {
    tts: {
      auto: "always", // off | always | inbound | tagged
      mode: "final", // final | all (include tool/block replies)
      provider: "elevenlabs",
      summaryModel: "openai/gpt-4.1-mini",
      modelOverrides: {
        enabled: true,
      },
      maxTextLength: 4000,
      timeoutMs: 30000,
      prefsPath: "~/.openclaw/settings/tts.json",
      elevenlabs: {
        apiKey: "elevenlabs_api_key",
        baseUrl: "https://api.elevenlabs.io",
        voiceId: "voice_id",
        modelId: "eleven_multilingual_v2",
        seed: 42,
        applyTextNormalization: "auto",
        languageCode: "en",
        voiceSettings: {
          stability: 0.5,
          similarityBoost: 0.75,
          style: 0.0,
          useSpeakerBoost: true,
          speed: 1.0,
        },
      },
      openai: {
        apiKey: "openai_api_key",
        model: "gpt-4o-mini-tts",
        voice: "alloy",
      },
    },
  },
}
```

利便性のためのオプトイン機能です。有効で、かつ期待されるキーがまだ設定されていない場合、OpenClaw はログインシェルを実行し、欠落している期待キーのみを取り込みます（上書きはしません）。  
これは実質的にシェルプロファイルを source する動作です。

- `messages.tts.auto` は、auto‐TTS(`off`、`always`、`inbound`、`tagged`)を制御します。
- `/tts off|always|inbound|tagged` はセッションごとの自動モードを設定します (設定を上書きします)。
- `messages.tts.enabled` はレガシーです。医師は `messages.tts.auto` に移行します。
- `prefsPath` はローカルのオーバーライドを格納します(provider/limit/summarize)。
- `maxTextLength`はTTS入力のハードキャップです。要約は収まるように省略されます。
- `summaryModel` は `agents.defaults.model.primary` を上書きします。
  - `provider/model` または `agents.defaults.models` のエイリアスを受け付けます。
- `modelOverrides` は、 `[[tts:...]]` タグのようなモデル駆動のオーバーライドを有効にします(デフォルト)。
- `/tts limit` と `/tts summary` はユーザ毎のサマリー設定を制御します。
- `apiKey` の値は `ELEVENLABS_API_KEY`/`XI_API_KEY` と `OPENAI_API_KEY` に戻ります。
- `elevenlabs.baseUrl` はElevenLabs APIベースのURLを上書きします。
- `elevenlabs.voiceSettings` は `stability`/`similarityBoost`/`style` (0..1),
  `useSpeakerBoost`, そして `speed` (0.5..2.0) をサポートしています。

### `talk`

デフォルトはトークモード(macOS/iOS/Android)です。 音声IDはオフにすると「ELEVENLABS_VOICE_ID」または「SAG_VOICE_ID」に戻ります。
`apiKey` は設定を解除したときに `ELEVENLABS_API_KEY` (またはゲートウェイのシェルプロファイル) に戻ります。
`voiceAliases` を使用すると、トークディレクティブはフレンドリーな名前を使用することができます(例: `"voice":"Clawd"`)。

```json5
19. {
  talk: {
    voiceId: "elevenlabs_voice_id",
    voiceAliases: {
      Clawd: "EXAVITQu4vr4xnSDxMaL",
      Roger: "CwhRBWXzGAHq8TQ4Fs17",
    },
    modelId: "eleven_v3",
    outputFormat: "mp3_44100_128",
    apiKey: "elevenlabs_api_key",
    interruptOnSpeech: true,
  },
}
```

### `agents.defaults`

埋め込まれたエージェントランタイムを制御します (モデル/思考/verbose/timeout)。
`agents.defaults.models` は設定されたモデルカタログを定義します (`/model` の許容リストとして機能します)。
`agents.defaults.model.primary` はデフォルトのモデルを設定します。`agents.defaults.model.fallbacks` はグローバルフェイルオーバーです。
`agents.defaults.imageModel` はオプションで、メインモデルに画像入力がない場合にのみ使用されます。
各 `agents.defaults.models` エントリには以下のものがあります。

- `alias` (オプションのモデルショートカット、例えば`/opus`)。
- `params` (オプションのプロバイダ固有の API パラメータがモデル要求に渡されます)。

`params` はストリーミング実行にも適用されます(埋め込みエージェント + 圧縮)。 現在サポートされているキーは`temperature`、`maxTokens`です。 これらはコールタイムオプションとマージされます。呼び出し元の値が勝利します。 `temperature` は高度なノブです。モデルのデフォルトがわかっていて、変更が必要ない限り、設定を解除してください。

未定義または空の環境変数は、設定読み込み時にエラーとなります

```json5
20. {
  agents: {
    defaults: {
      models: {
        "anthropic/claude-sonnet-4-5-20250929": {
          params: { temperature: 0.6 },
        },
        "openai/gpt-5.2": {
          params: { maxTokens: 8192 },
        },
      },
    },
  },
}
```

Z.AI GLM-4.x モデルは自動的に思考モードを有効にします。

- `--thinking off` または
- `agents.defaults.models["zai/<model>"].params.thinking` を自分で定義します。

OpenClawはまた、いくつかの組み込みエイリアス短縮を出荷します。 デフォルトは、モデル
が `agents.defaults.models`に既に存在する場合にのみ適用されます。

- `opus` -> `anthropic/claude-opus-4-6`
- `sonnet` -> `anthropic/claude-sonnet-4-5`
- `gpt` -> `openai/gpt-5.2`
- `gpt-mini` -> `openai/gpt-5-mini`
- `gemini` -> `google/gemini-3-pro-preview`
- `gemini-flash` -> `google/gemini-3-flash-preview`

自分で同じエイリアス名(大文字と小文字を区別しない)を設定すると、その値は勝利します (デフォルトでは上書きされません)。

例: Opus 4.6 primary with MiniMax M2.1 fallback (hosted MiniMax):

```json5
21. {
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": { alias: "opus" },
        "minimax/MiniMax-M2.1": { alias: "minimax" },
      },
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["minimax/MiniMax-M2.1"],
      },
    },
  },
}
```

MiniMax auth: `MINIMAX_API_KEY` (env) を設定するか、`models.providers.minimax` を設定します。

#### `agents.defaults.cliBackends` (CLI フォールバック)

テキストのみのフォールバックラン(ツールコールなし)のためのオプションの CLI バックエンド。 これらは、API プロバイダが失敗した場合の
バックアップパスとして有用です。
ファイルパスを受け入れる`imageArg` を設定すると、イメージパススルーがサポートされます。

利便性のためのオプトイン機能です。有効で、かつ期待されるキーがまだ設定されていない場合、OpenClaw はログインシェルを実行し、欠落している期待キーのみを取り込みます（上書きはしません）。  
これは実質的にシェルプロファイルを source する動作です。

- CLI バックエンドは **text-first** です。ツールは常に無効です。
- セッションは `sessionArg` が設定されている場合にサポートされます。セッションIDはバックエンドごとに持続します。
- `claude-cli`の場合、デフォルトは配線されています。 PATH が最小の
  (launchd/systemd) の場合、コマンドパスを上書きします。

2026-02-08T09:22:13Z

```json5
22. {
  agents: {
    defaults: {
      cliBackends: {
        "claude-cli": {
          command: "/opt/homebrew/bin/claude",
        },
        "my-cli": {
          command: "my-cli",
          args: ["--json"],
          output: "json",
          modelArg: "--model",
          sessionArg: "--session",
          sessionMode: "existing",
          systemPromptArg: "--system",
          systemPromptWhen: "first",
          imageArg: "--image",
          imageMode: "repeat",
        },
      },
    },
  },
}
```

```json5
23. {
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-6": { alias: "Opus" },
        "anthropic/claude-sonnet-4-1": { alias: "Sonnet" },
        "openrouter/deepseek/deepseek-r1:free": {},
        "zai/glm-4.7": {
          alias: "GLM",
          params: {
            thinking: {
              type: "enabled",
              clear_thinking: false,
            },
          },
        },
      },
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: [
          "openrouter/deepseek/deepseek-r1:free",
          "openrouter/meta-llama/llama-3.3-70b-instruct:free",
        ],
      },
      imageModel: {
        primary: "openrouter/qwen/qwen-2.5-vl-72b-instruct:free",
        fallbacks: ["openrouter/google/gemini-2.0-flash-vision:free"],
      },
      thinkingDefault: "low",
      verboseDefault: "off",
      elevatedDefault: "on",
      timeoutSeconds: 600,
      mediaMaxMb: 5,
      heartbeat: {
        every: "30m",
        target: "last",
      },
      maxConcurrent: 3,
      subagents: {
        model: "minimax/MiniMax-M2.1",
        maxConcurrent: 1,
        archiveAfterMinutes: 60,
      },
      exec: {
        backgroundMs: 10000,
        timeoutSec: 1800,
        cleanupMs: 1800000,
      },
      contextTokens: 200000,
    },
  },
}
```

#### `agents.defaults.contextPruning` (tool-result pruning)

`agents.defaults.contextPruning` は、リクエストが LLM に送信される直前のメモリ内コンテキストから **古いツールの結果** を削除します。
ディスク上のセッション履歴を**変更**しません\*\* (`*.jsonl`はまだ完了しています)。

これは、時間の経過とともに大きなツール出力を蓄積するチャットエージェントのトークン使用を減らすことを目的としています。

ハイレベル:

- ユーザー/アシスタントメッセージをタッチしないでください。
- 最後の `keepLastAssistants` アシスタントメッセージを保護します。削除後のツール結果はありません。
- ブートストラップのプレフィックスを保護します (最初のユーザーメッセージが削除される前には何もありません)。
- モード:
  - `adaptive`: 推定されたコンテキスト比が `softTrimRatio` を横切ったときに、ソフトトリムが特大のツール結果を表示します(ヘッド/テールを維持します)。
    24. 推定コンテキスト比率が `hardClearRatio` を超え、かつ剪定可能なツール結果の量（`minPrunableToolChars`）が十分にある場合、最も古い対象ツール結果をハードクリアします。
  - `アグレッシブ`: カットオフの前に適切なツール結果を常に`hardClear.placeholder`に置き換えます(比率チェックはありません)。

ソフト対ハード剪定（LLMに送信されるコンテキスト内の変更）：

- **ソフトトリム**: _oversized_ ツール結果のみ。 開始位置と終了位置を維持し、中央に `...` を挿入します。
  - 以前: `toolResult("…非常に長い出力…")`
  - After: `toolResult("HEAD…\n...\n…TAIL\n\n[Tool result trimed: …]")`
- **Hard-clear**: ツール全体の結果をプレースホルダに置き換えます。
  - 以前: `toolResult("…非常に長い出力…")`
  - After: `toolResult("format@@0")`

ノート/現在の制限：

- **画像ブロックを含むツールの結果はスキップされます** (トリミングや削除はありません)
- 推定される「コンテキスト比」は、正確なトークンではなく**文字** (近似) に基づいています。
- セッションに `keepLastAssistants` アシスタントメッセージが含まれていない場合は、剪定はスキップされます。
- `アグレッシブ`モードでは、`hardClear.enabled`は無視されます（適格なツール結果は常に`hardClear.placeholder`に置き換えられます）。

デフォルト (アダプティブ):

```json5
{
  agents: { defaults: { contextPruning: { mode: "adaptive" } },
}
```

無効にするには:

```json5
{
  agents: { defaults: { contextPruning: { mode: "off" } },
}
```

デフォルト(`mode`が`adaptive"`または`"アグレッシブ"`の場合):

- `keepLastAssistants`: `3`
- `softTrimRatio`: `0.3` (アダプティブのみ)
- `hardClearRatio`: `0.5` (アダプティブのみ)
- `minPrunableToolChars`: `50000` (アダプティブのみ)
- `softTrim`: `{ maxChars: 4000, headChars: 1500, tailChars: 1500 }` (アダプティブのみ)
- `hardClear`: `{ enabled: true, placeholder: "[Old tool result content cleared]" }`

例 (攻撃的、最小値):

```json5
{
  agents: { defaults: { contextPruning: { mode: "agrossive" } },
}
```

例 (アダプティブチューニング):

```json5
25. {
  agents: {
    defaults: {
      contextPruning: {
        mode: "adaptive",
        keepLastAssistants: 3,
        softTrimRatio: 0.3,
        hardClearRatio: 0.5,
        minPrunableToolChars: 50000,
        softTrim: { maxChars: 4000, headChars: 1500, tailChars: 1500 },
        hardClear: { enabled: true, placeholder: "[Old tool result content cleared]" },
        // Optional: restrict pruning to specific tools (deny wins; supports "*" wildcards)
        tools: { deny: ["browser", "canvas"] },
      },
    },
  },
}
```

挙動の詳細は [/concepts/session-pruning](/concepts/session-pruning) を参照してください。

#### `agents.defaults.compaction` (headroom + memory flushを予約)

`agents.defaults.compaction.mode` は圧縮要約戦略を選択します。 デフォルトは `default` です。`safeguard` を設定すると、非常に長い歴史のためにまとめられた要約が有効になります。 [/concepts/compaction](/concepts/compaction) を参照してください。

`agents.defaults.compaction.reserveTokensFloor` は、Pi compaction の最小値 `reserveTokens`
を強制します(デフォルト: `20000`)。 床を無効にするには、`0` に設定します。

`agents.defaults.compaction.memoryFlush` は、
自動圧縮する前に**サイレント** のagenticticターンを実行します。モデルにディスクに耐久性のあるメモリーを格納するように指示します (例:
`memory/YYYY-MM-DD.md` )。 これは、セッション・トークンが圧縮限度を下回る
柔らかいしきい値を推定すると発生します。

従来のデフォルト:

- `memoryFlush.enabled`: `true`
- `memoryFlush.softThresholdTokens`: `4000`
- `memoryFlush.prompt` / `memoryFlush.systemPrompt`: `NO_REPLY`の組み込みデフォルト
- 注意: セッション ワークスペースが読み取り専用の
  (`agents.defaults.sandbox.workspaceAccess: "ro"` or `"none"`)の場合、メモリ フラッシュはスキップされます。

任意の設定文字列値で、`${VAR_NAME}` 構文を使用して環境変数を直接参照できます。  
変数は、検証前の設定読み込み時に置換されます。

```json5
26. {
  agents: {
    defaults: {
      compaction: {
        mode: "safeguard",
        reserveTokensFloor: 24000,
        memoryFlush: {
          enabled: true,
          softThresholdTokens: 6000,
          systemPrompt: "Session nearing compaction. Store durable memories now.",
          prompt: "Write any lasting notes to memory/YYYY-MM-DD.md; reply with NO_REPLY if nothing to store.",
        },
      },
    },
  },
}
```

ブロックストリーミング:

- `agents.defaults.blockStreamingDefault`: `"on"`/`"off"`（デフォルトはオフ）。

- チャンネルのオーバーライド: `*.blockStreaming` (とアカウントごとのバリアント) は、ストリーミングのオン/オフをブロックすることを強制します。
  Telegram以外のチャンネルでは、ブロックの返信を有効にするには明示的な`*.blockStreaming: true`が必要です。

- `agents.defaults.blockStreamingBreak`: `"text_end"` または `"message_end"` (デフォルト: text_end)。

- `agents.defaults.blockStreamingChunk`: ストリーミングされたブロックのソフトチャンキング。 デフォルトは
  800–1200 文字です。段落区切り（`\n\n`）、次に改行、次に文章を好みます。
  2026-02-08T09:22:13Z

  ```json5
  {
    agents: { defaults: { blockStreamingChunk: { minChars: 800, maxChars: 1200 } } },
  }
  ```

- `agents.defaults.blockStreamingCoalesce`: 送信前にストリーミングされたブロックをマージします。
  デフォルトは `{ idleMs: 1000 }` で、`blockStreamingChunk`
  から `minChars` を継承し、`maxChars` はチャンネルテキストの上限に上限を設定します。 シグナル/Slack/Discord/Googleチャットのデフォルト
  は、オーバーライドしない限り、`minChars: 1500`になります。
  27. チャンネルごとの上書き設定：`channels.whatsapp.blockStreamingCoalesce`、`channels.telegram.blockStreamingCoalesce`、
  `channels.discord.blockStreamingCoalesce`、`channels.slack.blockStreamingCoalesce`、`channels.mattermost.blockStreamingCoalesce`、
  `channels.signal.blockStreamingCoalesce`、`channels.imessage.blockStreamingCoalesce`、`channels.msteams.blockStreamingCoalesce`、
  `channels.googlechat.blockStreamingCoalesce`
  （およびアカウントごとのバリアント）。

- `agents.defaults.humanDelay`: 最初のブロックの後にランダムに一時停止します。
  モード: `off` (デフォルト)、`natural` (800-2500ms)、`custom` (`minMs`/`maxMs`を使用)。
  エージェント毎のオーバーライド: `agents.list[].humanDelay` 。
  2026-02-08T09:22:13Z

  ```json5
  {
    agents: { defaults: { humanDelay: { mode: "natural" } },
  }
  ```

  動作 + チャンキングの詳細については、[/concepts/streaming](/concepts/streaming) を参照してください。

入力インジケーター:

- `agents.defaults.typingMode`: `"never" | "instant" | "thinking" | "message"` 。 デフォルトは
  `instant` で直接チャット/メンション、未メンションのグループチャットの `message` です。
- `session.typingMode`: セッションごとのオーバーライド。
- `agents.defaults.typingIntervalSeconds`: タイピング信号がリフレッシュされる頻度(デフォルト: 6s)。
- `session.typingIntervalSeconds`: リフレッシュ間隔のセッションごとのオーバーライド。
  挙動の詳細は [/concepts/typing-indicators](/concepts/typing-indicators) を参照してください。

`agents.defaults.model.primary` は `provider/model` として設定する必要があります。（例: `anthropic/claude-opus-4-6`）
エイリアスは`agents.defaults.models.*.alias`（例：`Opus`）から来ています。
プロバイダを省略した場合、OpenClawは現在一時的な
非推奨のフォールバックとして`anthropic`を想定しています。
Z.AI モデルは `zai/<model>` (例: `zai/glm-4.7`) として利用でき、環境で
`ZAI_API_KEY` (またはレガシーの `Z_AI_API_KEY` )が必要です。

`agents.defaults.heartbeat` は定期的なハートビートの実行を構成します。

- `every`: duration string (`ms`, `s`, `m`, `h`); デフォルトの単位分。 デフォルト:
  `30m` 。 `0m` を無効にします。
- `model`: ハートビートラン(`provider/model`)のオプションのオーバーライドモデル。
- `includeReasoning`: `true`のとき、ハートビートは利用可能なとき `Reasoning`メッセージを別々に送信します（`/reasoning on`と同じ形です）。 デフォルト: `false`
- `session`: ハートビートがどのセッションを実行するかを制御するオプションのセッションキー。 デフォルト: `main` 。
- `to`: オプションの受信者オーバーライド（チャンネル固有のID、例えばWhatsAppのE.164、TelegramのチャットID）。
- `target`: オプションのデリバリチャンネル (`last`, `whatsapp`, `telegram`, `discord`, `slack`, `msteams`, `signal`, `imessage`, `none`). デフォルト: `last`
- `prompt`: ハートビートボディのオプションオーバーライド(デフォルト: `存在する場合はHEARTBEAT.md を読む(ワークスペースコンテキスト)。 Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`). オーバーライドはverbatimに送られます。ファイルを読みたい場合は、`Read HEARTBEAT.md`行を含みます。
- `ackMaxChars`: 配送前に `HEARTBEAT_OK` の後に許可された最大文字数（デフォルト：300）。

エージェントごとのハートビート:

- 特定のエージェントのハートビート設定を有効または上書きするには、`agents.list[].heartbeat` を設定します。
- エージェントのエントリで `heartbeat` が定義されている場合、**これらのエージェントのみ**がハートビートを実行します。デフォルトでは、
  はエージェントの共有ベースラインとなります。

ハートビートはフルエージェントターンを実行します。 短い間隔では、より多くのトークンを燃やします。`every` の
に留意して、`HEARTBEAT.md` を小さくして、より安い`model` を選んでください。

`tools.exec` はバックグラウンド実行のデフォルトを設定します。

- `backgroundMs`: 自動背景までの時間 (ms, default 10000)
- `timeoutSec`: このランタイムの後に自動キルをする (秒、デフォルト1800)
- `cleanupMs`: 終了したセッションをメモリに保存する期間 (ms, default 1800000)
- `notifyOnExit`: enqueue a system event + request heartbeat backgrounded exec exits (default true)
- `applyPatch.enabled`: 実験的な `apply_patch` を有効にします (OpenAI/OpenAI Codex のみ、デフォルトは false)
- `applyPatch.allowModels`: optional allowlist of model ids(例: `gpt-5.2` or `openai/gpt-5.2`)
  Note: `applyPatch` は `tools.exec` の下にあります。

`tools.web` はウェブ検索+fetch toolsを設定します。

- `tools.web.search.enabled` (デフォルト: キーが存在する場合は true )
- `tools.web.search.apiKey` (`openclaw-configure --section web`を介して設定するか、`BRAVE_API_KEY` envarを使用することを推奨)
- `tools.web.search.maxResults` (1–10, default 5)
- `tools.web.search.timeoutSeconds`（デフォルト 30）
- `tools.web.search.cacheTtlMinutes`（デフォルト 15）
- `tools.web.fetch.enabled` (デフォルトは true)
- `tools.web.fetch.maxChars`（デフォルト 50000）
- `tools.web.fetch.maxCharsCap` (デフォルト50000; clumps maxChars from config/tool calls)
- `tools.web.fetch.timeoutSeconds`（デフォルト 30）
- `tools.web.fetch.cacheTtlMinutes`（デフォルト 15）
- `tools.web.fetch.userAgent`（任意の上書き）。
- `tools.web.fetch.readability` (デフォルトは true; 基本的な HTML クリーンアップの使用を無効にする)
- `tools.web.fetch.firecrawl.enabled` (API キーが設定されている場合はデフォルトでtrue)
- `tools.web.fetch.firecrawl.apiKey` (オプション; デフォルトは `FIRECRAWL_API_KEY`)
- `tools.web.fetch.firecrawl.baseUrl` (デフォルト [https://api.firecrawl.dev](https://api.firecrawl.dev))
- `tools.web.fetch.firecrawl.onlyMainContent` (デフォルトは true)
- `tools.web.fetch.firecrawl.maxAgeMs`（任意）
- `tools.web.fetch.firecrawl.timeoutSeconds`（任意）

`tools.media` はインバウンドメディア理解を設定します（画像/オーディオ/ビデオ）。

- `tools.media.models`: 共有モデルリスト (capability-tagged; per-cap listsの後に使用)。
- `tools.media.concurrency`: 最大同時実行機能 (デフォルト2)。
- `tools.media.image` / `tools.media.audio` / `tools.media.video`:
  - `enabled`: opt-out switch (モデルが設定されている場合はデフォルトでは true)。
  - `prompt`: オプションのプロンプトのオーバーライド（画像/ビデオは `maxChars` ヒントを自動的に追加）。
  - `maxChars`: 最大出力文字数（画像/ビデオの場合はデフォルト500、オーディオの場合はオフ）。
  - `maxBytes`: 送信するメディアの最大サイズ（デフォルト：画像10MB、音声20MB、動画50MB）。
  - `timeoutSeconds`: リクエストタイムアウト (デフォルト: 画像60、音声60、動画120)。
  - `language`: 音声ヒントのオプション。
  - `attachments`: attachment policy (`mode`, `maxAttachments`, `prefer`).
  - `scope`: オプション gating (first match wins) with `match.channel` , `match.chatType` , または `match.keyPrefix` .
  - `models`: ordered list of model entries; failure or oversize media fall back to the next entry.
- それぞれの `models[]` エントリ:
  - プロバイダエントリ(`type: "provider"`または省略):
    - `provider`: API プロバイダー id (`openai`, `anthropic`, `google`/`gemini`, `groq`, etc).
    - `model`: モデル id オーバーライド（画像には必須。デフォルトは `gpt-4o-mini-transscribe`/`wisper-large v3-turbo`、ビデオに `gemini-3-flash-preview`）。
    - `profile` / `preferredProfile`: authプロファイルの選択。
  - CLI エントリ (`type: "cli"`):
    - `command`: 実行する実行ファイル。
    - `args`: templated args (support `{{MediaPath}}`, `{{Prompt}}`, `{{MaxChars}}`など).
  - `capabilities`: オプションのリスト(`image`, `audio`, `video`)を共有エントリにゲートします。 省略時のデフォルト: `openai`/`anthropic`/`minimax` → 画像、`google` → image+audio+video、`groq` → audio。
  - `prompt` 、 `maxChars` 、 `maxBytes` 、 `timeoutSeconds` 、 `language` はエントリごとに上書きすることができます。

モデルが設定されていない場合 (または `enabled: false` )、理解はスキップされます。モデルは元の添付ファイルを受け取ります。

プロバイダ認証は標準モデルの認証順序に従います(認証プロファイル、`OPENAI_API_KEY`/`GROQ_API_KEY`/`GEMINI_API_KEY`、`models.providers.*.apiKey`など)。

e226e24422c05e7e

```json5
28. {
  tools: {
    media: {
      audio: {
        enabled: true,
        maxBytes: 20971520,
        scope: {
          default: "deny",
          rules: [{ action: "allow", match: { chatType: "direct" } }],
        },
        models: [
          { provider: "openai", model: "gpt-4o-mini-transcribe" },
          { type: "cli", command: "whisper", args: ["--model", "base", "{{MediaPath}}"] },
        ],
      },
      video: {
        enabled: true,
        maxBytes: 52428800,
        models: [{ provider: "google", model: "gemini-3-flash-preview" }],
      },
    },
  },
}
```

`agents.defaults.subagents` はサブエージェントのデフォルトを設定します。

- `model`: spawn されたサブエージェントのデフォルトモデル (string or `{ primary, fallbacks }`). 省略された場合、サブエージェントはエージェントごとまたは呼び出しごとに上書きされない限り、呼び出し元のモデルを継承します。
- `maxConcurrent`: max concurrent sub-agent runs (default 1)
- `archiveAfterMinutes`: サブエージェントセッションをN分後に自動アーカイブします（デフォルトでは60分、`0`を無効にします）
- サブエージェント毎のツールポリシー: `tools.subagents.tools.allow` / `tools.subagents.tools.deny` (deny wins)

`tools.profile` は `tools.allow`/`tools.deny`の前に **base tools allowlist** を設定します。

- `minimal`: `session_status` のみ
- `coding`: `group:fs`, `group:runtime`, `group:sessions`, `group:memory`, `image`
- `messaging`: `group:messaging`, `sessions_list`, `sessions_history`, `sessions_send`, `session_status`
- `full`: 制限なし（未設定と同等）

エージェント毎のオーバーライド: `agents.list[].tools.profile` 。

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

`tools.byProvider` を使用すると、特定のプロバイダー (または単一の `provider/model` ) に対して、 **さらなる制限** ツールを使用できます。
エージェント毎のオーバーライド: `agents.list[].tools.byProvider`

注文: ベースプロファイル → プロバイダプロファイル → ポリシーの許可/拒否。
プロバイダのキーは `provider` (例: `google-antigubity`) または `provider/model`
(例: `openai/gpt-5.2`) のいずれかを受け付けます。

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

例 (provider/model-specific allowlist):

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

`tools.allow` / `tools.deny` はグローバルツールのallow/denyポリシーを設定します（deny wins）。
マッチングは大文字と小文字を区別せず、`*` ワイルドカード（`"*"`はすべてのツールを意味します）をサポートしています。
これは、Docker Sandbox が **off** の場合でも適用されます。

例 (ブラウザ/キャンバスをどこでも無効にできます):

```json5
{
  tools: { deny: ["browser", "canvas"] },
}
```

ツールグループ (略) は **global** と **per-agent** ツールポリシーで動作します。

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

`tools.elevated` controls righted (host) exec access:

- `enabled`: 昇格モードを許可する (デフォルトは true)
- `allowFrom`: per-channel allowlist (empty = disabled)
  - `whatsapp`: E.164 numbers
  - `telegram`: チャット IDまたはユーザー名
  - `discord`: ユーザー IDまたはユーザー名 (省略した場合は `channels.discord.dm.allowFrom` に戻ります)
  - `シグナル`: E.164 numbers
  - `imessage`: handles/chat id
  - `webchat`: セッションIDまたはユーザー名

v1

```json5
29. {
  tools: {
    elevated: {
      enabled: true,
      allowFrom: {
        whatsapp: ["+15555550123"],
        discord: ["steipete", "1234567890123"],
      },
    },
  },
}
```

エージェント毎のオーバーライド(さらなる制限):

```json5
30. {
  agents: {
    list: [
      {
        id: "family",
        tools: {
          elevated: { enabled: false },
        },
      },
    ],
  },
}
```

設定内でインライン環境変数を指定することもできます。これらは、プロセス環境にキーが存在しない場合にのみ適用されます（同じく上書きしません）。

- `tools.elevated` はグローバルベースラインです。 `agents.list[].tools.elevated` は、さらに制限することができます (両方とも許可する必要があります)。
- `/上に昇格|オフ|ask|full` はセッションごとの状態を保存します。インラインディレクティブは単一のメッセージに適用されます。
- `exec`が高くなってホスト上で実行され、サンドボックス化がバイパスされます。
- ツールポリシーが適用されます; `exec`が拒否された場合、昇格は使用できません。

`agents.defaults.maxConcurrent` は、セッション間で並列に
実行できる埋め込みエージェントの実行数を設定します。 各セッションはまだシリアル化されています(一度に1つのセッションキーにつき1つの実行
)。 デフォルト: 1.

### `agents.defaults.sandbox`

埋め込みエージェント用のオプションの **Docker サンドボックス** です。 メイン以外の
セッションを対象としていないため、ホストシステムにアクセスできません。

詳細: [Sandboxing](/gateway/sandboxing)

デフォルト (有効な場合):

- scope: `"agent"` (1 container + workspace per agent)
- Debian bookworm-slim based image
- ファイルが存在しない場合、OpenClaw は安全寄りのデフォルト（組み込み Pi エージェント + 送信者ごとのセッション + ワークスペース `~/.openclaw/workspace`）を使用します。通常、設定が必要になるのは次の場合です。
  - `"none"`: `~/.openclaw/sandboxes`の下でスコープごとのサンドボックスワークスペースを使用します
- `"ro"`: サンドボックスのワークスペースを`/workspace`に保ち、`/agent`でエージェントワークスペースを読み取り専用にマウントします (`write`/`edit`/`apply_patch`)
  - `"rw"`: `/workspace` でエージェントワークスペースを読み書きする
- 自動プルーン：アイドル > 24 時間 または 経過 > 7 日
- tool policy: allow only `exec`, `process`, `read`, `write`, `edit`, `apply_patch`, `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status` (deny wins)
  - `tools.sandbox.tools` を使用して設定し、`agents.list[].tools.sandbox.tools` を使用してエージェントごとに上書きする
  - sandbox ポリシーでサポートされているツールグループの短縮形: `group:runtime`, `group:fs`, `group:sessions`, `group:memory` ([Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated#tool-groups-shorthands)) を参照してください。
- オプションのサンドボックス化ブラウザ (Chromium + CDP, noVNC observer)
- ノブを硬化させる: `network`, `user`, `pidsLimit`, `memory`, `cpus`, `ulimits`, `seccompProfile`, `apparmorProfile`

警告: `scope: "shared"は共有コンテナと共有ワークスペースを意味します。 
セッション間隔離はありません。 セッションごとの分離には `scope: "session"\` を使用します。

レガシー: `perSession` はまだサポートされています (`true` → `scope: "session"`,
`false` → `scope: "shared"`).

`setupCommand` はコンテナが作成された後に **1回** 実行されます (`sh -lc`を介してコンテナの中に入ります)。
パッケージをインストールする場合は、ネットワーク egress、書き込み可能なルート FS 、および root ユーザーを確認してください。

```json5
31. {
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main", // off | non-main | all
        scope: "agent", // session | agent | shared (agent is default)
        workspaceAccess: "none", // none | ro | rw
        workspaceRoot: "~/.openclaw/sandboxes",
        docker: {
          image: "openclaw-sandbox:bookworm-slim",
          containerPrefix: "openclaw-sbx-",
          workdir: "/workspace",
          readOnlyRoot: true,
          tmpfs: ["/tmp", "/var/tmp", "/run"],
          network: "none",
          user: "1000:1000",
          capDrop: ["ALL"],
          env: { LANG: "C.UTF-8" },
          setupCommand: "apt-get update && apt-get install -y git curl jq",
          // Per-agent override (multi-agent): agents.list[].sandbox.docker.*
          pidsLimit: 256,
          memory: "1g",
          memorySwap: "2g",
          cpus: 1,
          ulimits: {
            nofile: { soft: 1024, hard: 2048 },
            nproc: 256,
          },
          seccompProfile: "/path/to/seccomp.json",
          apparmorProfile: "openclaw-sandbox",
          dns: ["1.1.1.1", "8.8.8.8"],
          extraHosts: ["internal.service:10.0.0.5"],
          binds: ["/var/run/docker.sock:/var/run/docker.sock", "/home/user/source:/source:rw"],
        },
        browser: {
          enabled: false,
          image: "openclaw-sandbox-browser:bookworm-slim",
          containerPrefix: "openclaw-sbx-browser-",
          cdpPort: 9222,
          vncPort: 5900,
          noVncPort: 6080,
          headless: false,
          enableNoVnc: true,
          allowHostControl: false,
          allowedControlUrls: ["http://10.0.0.42:18791"],
          allowedControlHosts: ["browser.lab.local", "10.0.0.42"],
          allowedControlPorts: [18791],
          autoStart: true,
          autoStartTimeoutMs: 12000,
        },
        prune: {
          idleHours: 24, // 0 disables idle pruning
          maxAgeDays: 7, // 0 disables max-age pruning
        },
      },
    },
  },
  tools: {
    sandbox: {
      tools: {
        allow: [
          "exec",
          "process",
          "read",
          "write",
          "edit",
          "apply_patch",
          "sessions_list",
          "sessions_history",
          "sessions_send",
          "sessions_spawn",
          "session_status",
        ],
        deny: ["browser", "canvas", "nodes", "cron", "discord", "gateway"],
      },
    },
  },
}
```

`$include` ディレクティブを使用して、設定を複数ファイルに分割できます。これは次の用途に便利です。

```bash
scripts/sandbox-setup.sh
```

注意: Sandbox コンテナはデフォルトで `network: "none"` に設定します。エージェントのアウトバウンドアクセスが必要な場合は、`agents.defaults.sandbox.docker.network`
に \`bridge" (またはカスタムネットワーク) を設定します。

注意: 受信添付ファイルは `media/inbound/*` のアクティブなワークスペースにステージされます。 `workspaceAccess: "rw"`では、ファイルがエージェントのワークスペースに書き込まれることを意味します。

注意: `docker.binds` は、追加のホストディレクトリをマウントします。グローバルとエージェントごとのバインディングはマージされます。

オプションのブラウザー画像を以下で作成します。

```bash
scripts/sandbox-browser-setup.sh
```

`agents.defaults.sandbox.browser.enabled=true` の場合、ブラウザツールはサンドボックス化された
Chromium インスタンス (CDP) を使用します。 noVNC が有効になっている場合 (headless=falseの場合のデフォルト)、
noVNC URL はエージェントが参照できるようにシステムプロンプトに注入されます。
メイン設定で `browser.enabled` は必要ありません。sandbox control
URL はセッションごとに注入されます。

32. `agents.defaults.sandbox.browser.allowHostControl`（既定値: false）を有効にすると、サンドボックス化されたセッションが、ブラウザツール（`target: "host"`）を介して **ホスト** のブラウザ制御サーバーを明示的に対象にできるようになります。 厳格な
    サンドボックスの分離が必要な場合は、これをオフにしてください。

リモートコントロールの許可リスト:

- `allowedControlUrls`: `target: "custom"`で許可されている正確な制御URL。
- `allowedControlHosts`: 許可されたホスト名(ホスト名のみ、ポートなし)。
- `allowedControlPorts`: ポート許可 (デフォルト: http=80, https=443)。
  デフォルト: すべての許可リストが未設定（制限なし）です。 `allowHostControl` のデフォルトは false です。

### `models` (カスタム プロバイダー + ベース URL)

OpenClawは**pi-coding-agent**モデルカタログを使用しています。 カスタム プロバイダー
(LiteLLM、ローカル OpenAI 互換サーバー、Anthropic プロキシなど) を追加できます。
`~/.openclaw/agents/<agentId>/agent/models.json` を書くか、 `models.providers` の下にある
OpenClaw設定内で同じスキーマを定義することによって。
プロバイダごとのプロバイダの概要 + 例: [/concepts/model-providers](/concepts/model-providers)

Gateway は、UI エディター向けに設定の JSON Schema 表現を `config.schema` 経由で公開します。  
Control UI はこのスキーマからフォームを生成し、エスケープハッチとして **Raw JSON** エディターを提供します。

- デフォルトの動作: **マージ** (既存のプロバイダを保持し、名前を上書きします)
- `models.mode: "replace"`を設定してファイルの内容を上書きする

`agents.defaults.model.primary` (provider/model) でモデルを選択します。

```json5
33. {
  agents: {
    defaults: {
      model: { primary: "custom-proxy/llama-3.1-8b" },
      models: {
        "custom-proxy/llama-3.1-8b": {},
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      "custom-proxy": {
        baseUrl: "http://localhost:4000/v1",
        apiKey: "LITELLM_KEY",
        api: "openai-completions",
        models: [
          {
            id: "llama-3.1-8b",
            name: "Llama 3.1 8B",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 32000,
          },
        ],
      },
    },
  },
}
```

### OpenCode Zen (マルチモデル プロキシ)

OpenCode Zenは、モデルごとのエンドポイントを備えたマルチモデルゲートウェイです。 34. OpenClaw は pi-ai の組み込み `opencode` プロバイダーを使用します。[https://opencode.ai/auth](https://opencode.ai/auth) から `OPENCODE_API_KEY`（または `OPENCODE_ZEN_API_KEY`）を設定してください。

パラメータ：

- model refs は `opencode/<modelId>` を使用します(例: `opencode/claude-opus-4-6`)。
- `agents.defaults.models` で許可リストを有効にする場合は、使用予定の各モデルを追加します。
- ショートカット: `openclawオン --auth-choice opencode-zen`。

```json5
35. {
  agents: {
    defaults: {
      model: { primary: "opencode/claude-opus-4-6" },
      models: { "opencode/claude-opus-4-6": { alias: "Opus" } },
    },
  },
}
```

### Z.AI (GLM-4.7) — プロバイダエイリアスのサポート

Z.AI モデルは、組み込みの `zai` プロバイダー経由で利用できます。 環境で `ZAI_API_KEY`
を設定し、プロバイダ/モデルでモデルを参照します。

ショートカット: `openclawon --auth-choice zai-api-key`

```json5
{
  agents: {
    defaults: {
      model: { primary: "zai/glm-4.7" },
      models: { "zai/glm-4.7": {} },
    },
  },
}
```

ネストされたインクルード

- `z.ai/*` と `z-ai/*` はエイリアスとして受け入れられ、`zai/*` に正規化されます。
- `ZAI_API_KEY` が見つからない場合、 `zai/*` へのリクエストは実行時に認証エラーで失敗します。
- 例エラー: `プロバイダー "zai" の API キーが見つかりません。`
- Z.AI の一般的な API エンドポイントは `https://api.z.ai/api/paas/v4` です。 GLMコーディング
  リクエストは専用のコーディングエンドポイント `https://api.zai/api/coding/paas/v4` を使用します。
  組み込みの `zai` プロバイダはコーディングエンドポイントを使用します。 一般的な
  エンドポイントが必要な場合は、ベース URL
  をオーバーライドする `models.providers` のカスタムプロバイダを定義します (上のカスタムプロバイダセクションを参照してください)。
- docs/configsで偽のプレースホルダを使用してください。実際のAPIキーはコミットしないでください。

### Moonshot AI（Kimi）

Moonshot の OpenAI 互換エンドポイントを使用:

```json5
36. {
  env: { MOONSHOT_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "moonshot/kimi-k2.5" },
      models: { "moonshot/kimi-k2.5": { alias: "Kimi K2.5" } },
    },
  },
  models: {
    mode: "merge",
    providers: {
      moonshot: {
        baseUrl: "https://api.moonshot.ai/v1",
        apiKey: "${MOONSHOT_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "kimi-k2.5",
            name: "Kimi K2.5",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 256000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

配列は置換

- 環境で `MOONSHOT_API_KEY` を設定するか、`openclawオン --auth-choice moonshot-api-key` を使用します。
- Model ref: `moonshot/kimi-k2.5`
- 中国のエンドポイントのいずれか:
  - `openclawオン --auth-choice moonshot-api-key-cn` を実行します (ウィザードは`https://api.moonshot.cn/v1`を設定します)。
  - `models.providers.moonshot` に `baseUrl: "https://api.moonshot.cn/v1"` を手動で設定します。

### Kimi Coding

Moonshot AIのキミコーディングエンドポイントを使用（アントロピー互換、組み込みプロバイダー）：

```json5
{
  env: { KIMI_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "kimi-coding/k2p5" },
      models: { "kimi-coding/k2p5": { alias: "Kimi K2.5" } },
    },
  },
}
```

注記：

- 環境で `KIMI_API_KEY` を設定するか、`openclawオン --auth-choice kimi-code-api-key` を使用します。
- Model ref: `kimi-coding/k2p5`

### 合成（Anthropic互換）

SyntheticのAnthropic互換エンドポイントを使用してください:

```json5
{
  env: { SYNTHETIC_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "synthetic/hf:MiniMaxAI/MiniMax-M2.1" },
      models: { "synthetic/hf:MiniMaxAI/MiniMax-M2.1": { alias: "MiniMax M2.1" } },
    },
  },
  models: {
    mode: "merge",
    providers: {
      synthetic: {
        baseUrl: "https://api.synthetic.new/anthropic",
        apiKey: "${SYNTHETIC_API_KEY}",
        api: "anthropic-messages",
        models: [
          {
            id: "hf:MiniMaxAI/MiniMax-M2.1",
            name: "MiniMax M2.1",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 192000,
            maxTokens: 65536,
          },
        ],
      },
    },
  },
}
```

gpt-5.2-chat-latest

- `SYNTHETIC_API_KEY` を設定するか、 `openclawオン --auth-choice synthetic-api-key` を使用してください。
- Model ref: `synthetic/hf:MiniMaxAI/MiniMax-M2.1`
- Anthropic クライアントが追加するため、Base URL は `/v1` を省略してください。

### ローカルモデル (LMスタジオ) — 推奨設定

現在のローカルガイダンスについては、[/gateway/local-models](/gateway/local-models) を参照してください。 TL;DR: LM Studio Responses API を介して MiniMax M2.1 を深刻なハードウェア上で実行し、ホストされたモデルをフォールバックのためにマージし続けます。

### MiniMax M2.1

LMスタジオなしでMiniMax M2.1を直接使用:

```json5
37. {
  agent: {
    model: { primary: "minimax/MiniMax-M2.1" },
    models: {
      "anthropic/claude-opus-4-6": { alias: "Opus" },
      "minimax/MiniMax-M2.1": { alias: "Minimax" },
    },
  },
  models: {
    mode: "merge",
    providers: {
      minimax: {
        baseUrl: "https://api.minimax.io/anthropic",
        apiKey: "${MINIMAX_API_KEY}",
        api: "anthropic-messages",
        models: [
          {
            id: "MiniMax-M2.1",
            name: "MiniMax M2.1",
            reasoning: false,
            input: ["text"],
            // Pricing: update in models.json if you need exact cost tracking.
            cost: { input: 15, output: 60, cacheRead: 2, cacheWrite: 10 },
            contextWindow: 200000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

上書き：

- `MINIMAX_API_KEY`環境変数を設定するか、`openclawオン --auth-choice minimax-api`を使用してください。
- 利用可能なモデル: `MiniMax-M2.1` (デフォルト)。
- 正確なコストトラッキングが必要な場合は、 `models.json` で価格を更新してください。

### Cerebras (GLM 4.6 / 4.7)

OpenAI対応エンドポイント経由でCerebraを使用:

```json5
38. {
  env: { CEREBRAS_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: {
        primary: "cerebras/zai-glm-4.7",
        fallbacks: ["cerebras/zai-glm-4.6"],
      },
      models: {
        "cerebras/zai-glm-4.7": { alias: "GLM 4.7 (Cerebras)" },
        "cerebras/zai-glm-4.6": { alias: "GLM 4.6 (Cerebras)" },
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      cerebras: {
        baseUrl: "https://api.cerebras.ai/v1",
        apiKey: "${CEREBRAS_API_KEY}",
        api: "openai-completions",
        models: [
          { id: "zai-glm-4.7", name: "GLM 4.7 (Cerebras)" },
          { id: "zai-glm-4.6", name: "GLM 4.6 (Cerebras)" },
        ],
      },
    },
  },
}
```

`config.apply` を使用すると、設定全体を検証・書き込みし、1 ステップで Gateway を再起動できます。  
再起動センチネルを書き込み、Gateway 復帰後に最後にアクティブだったセッションへ ping を送信します。

- Cerebrasには`大脳/zai-glm-4.7`を使用します。Z.AIダイレクトには`zai/glm-4.7`を使用します。
- 環境または config で `CEREBRAS_API_KEY` を設定します。

設定内でインライン環境変数を指定することもできます。これらは、プロセス環境にキーが存在しない場合にのみ適用されます（同じく上書きしません）。

- サポートされているAPI: `openai-completions` 、 `openai-responses` 、 `anthropic-messages` 、
  `google-generative-ai`
- カスタム認証には、 `authHeader: true` + `headers` を使用します。
- 警告：`config.apply` は **設定全体** を置き換えます。  
  一部のキーのみを変更したい場合は、`config.patch` または `openclaw config set` を使用してください。  
  `~/.openclaw/openclaw.json` のバックアップを保持してください。

### `セッション`

セッションスコープ、リセットポリシー、リセットトリガー、およびセッションストアが書き込まれる場所を制御します。

```json5
39. {
  session: {
    scope: "per-sender",
    dmScope: "main",
    identityLinks: {
      alice: ["telegram:123456789", "discord:987654321012345678"],
    },
    reset: {
      mode: "daily",
      atHour: 4,
      idleMinutes: 60,
    },
    resetByType: {
      thread: { mode: "daily", atHour: 4 },
      dm: { mode: "idle", idleMinutes: 240 },
      group: { mode: "idle", idleMinutes: 120 },
    },
    resetTriggers: ["/new", "/reset"],
    // Default is already per-agent under ~/.openclaw/agents/<agentId>/sessions/sessions.json
    // You can override with {agentId} templating:
    store: "~/.openclaw/agents/{agentId}/sessions/sessions.json",
    // Direct chats collapse to agent:<agentId>:<mainKey> (default: "main").
    mainKey: "main",
    agentToAgent: {
      // Max ping-pong reply turns between requester/target (0–5).
      maxPingPongTurns: 5,
    },
    sendPolicy: {
      rules: [{ action: "deny", match: { channel: "discord", chatType: "group" } }],
      default: "allow",
    },
  },
}
```

フィールド：

- `mainKey`: 直接チャットバケットキー (デフォルト: `"main"`)。 `agentId`を変更せずにプライマリDMスレッドを「名前を変更」したい場合に便利です。
  - Sandbox note: `agents.defaults.sandbox.mode: "non-main"` はこのキーを使用してメインセッションを検出します。 `mainKey` (groups/channels) と一致しないセッションキーはすべてサンドボックス化されています。
- `dmScope`: DM セッションがグループ化される方法 (デフォルト: `"main"`)。
  - `main`: すべてのDMが継続性のためのメインセッションを共有します。
  - `per-peer`: チャンネル間の送信者IDでDMを分離します。
  - `per-channel-peer`: チャンネルごとのDMと送信者を分離します(マルチユーザー受信ボックスに推奨)。
  - `per-account-channel-peer`: アカウント+チャンネル+送信者あたりのDMを隔離します (マルチアカウント受信ボックスに推奨)。
  - セキュアDMモード(推奨): `session.dmScope: "per-channel-peer"` を設定します。複数の人がBot（共有インボックス、マルチ個人許可リスト、または`dmPolicy: "open"`）をDMできるようにします。
- `identityLinks`: `per-peer` 、 `per-channel-peer` 、 `per-channel-peer` 、 `per-account-channel-peer` を使用すると、同じ人がチャンネル間でDMセッションを共有するようにします。
  - 例: `alice: ["telegram:123456789", "discord:987654321012345678"]` 。
- `reset`: primary reset policy ゲートウェイホストのローカル時間午前4時に、デフォルトでは毎日リセットされます。
  - `mode`: `daily` または `idle` (デフォルト: `reset` が存在する場合は`daily` )。
  - `atHour`: 毎日のリセット境界の ローカル時間 (0-23) 。
  - `idleMinutes`: アイドルウィンドウを分単位でスライドする 毎日+アイドルが設定されている場合、いずれかの方が最初の勝利に失効します。
- `resetByType`: セッションごとに `dm`、`group`、および `thread` をオーバーライドします。
  - レガシーの `session.idleMinutes` を`reset`/`resetByType`を設定しない場合、後方互換性のためにOpenClawはアイドルのみのモードに留まります。
- `heartbeatIdleMinutes`: ハートビートチェックのアイドルオーバーライドオプション（有効にするとデイリーリセットが適用されます）。
- `agentToAgent.maxPingPongTurns`: requester/target (0–5, default 5) の間で最大応答が返されます。
- `sendPolicy.default`: ルールが一致しない場合、`allow` または `deny` フォールバック。
- `sendPolicy.rules[]`: `channel`, `chatType` (`direct|group|room`), or `keyPrefix` (例: `cron:`). 最初の拒否が勝利します; そうでなければ許可します。

### `skills` (skillsconfig)

40. バンドルされた許可リスト、インストール設定、追加のスキルフォルダー、およびスキルごとの上書きを制御します。 **バンドル**スキルと`~/.openclaw/skills`に適用されます（ワークスペーススキル
    は名前の競合で勝利します）。

フィールド：

- `allowBundled`：**同梱** skills のみを対象とした任意の許可リスト。設定されている場合、リスト内の同梱 skills のみが有効になります（マネージド／ワークスペース skills には影響しません）。 設定されている場合、
  バンドルされたスキルのみが対象となります(管理スキル/ワークスペーススキルは影響を受けません)。
- `load.extraDirs`: スキャン対象とする追加の Skill ディレクトリ（優先度は最も低い）。
- `install.preferBrew`: 利用可能な場合に brew インストーラーを優先します（デフォルト: true）。
- `install.nodeManager`: node installer preference(`npm` | `pnpm` | `yarn`, default: npm).
- `entries.<skillKey>`: スキルごとの設定が上書きされます。

Skill ごとのフィールド:

- `enabled`: `false` を設定すると、同梱／インストール済みであっても Skill を無効化します。
- `env`: エージェント実行時に注入される環境変数（未設定の場合のみ）。
- `apiKey`: プライマリenvを宣言するスキルのオプションの利便性（例: `nano-banana-pro` → `GEMINI_API_KEY`）。

例：

```json5
{
  skills: {
    allowBundled: ["gemini", "peekaboo"],
    load: {
      extraDirs: ["~/Projects/agent-scripts/skills", "~/Projects/oss/some-skill-pack/skills"],
    },
    install: {
      preferBrew: true,
      nodeManager: "npm",
    },
    entries: {
      "nano-banana-pro": {
        apiKey: "GEMINI_KEY_HERE",
        env: {
          GEMINI_API_KEY: "GEMINI_KEY_HERE",
        },
      },
      peekaboo: { enabled: true },
      sag: { enabled: false },
    },
  },
}
```

### `plugins` (extensions)

プラグインの検出、許可/拒否、およびプラグインごとの設定を制御します。 プラグインは `~/.openclaw/extensions` から
読み込まれます。`<workspace>/.openclaw/extensions` に加えて、
`plugins.load.paths` エントリがあります。 **設定の変更にはゲートウェイの再起動が必要です。**
完全に使用するには [/plugin](/tools/plugin) を参照してください。

フィールド：

- `enabled`: プラグインの読み込みをマスター切り替えます (デフォルト: true)。
- `allow`: オプションのプラグインIDのallowlist; 設定された場合、リストされたプラグインのみがロードされます。
- `deny`: オプションのプラグインIDのdenylist(denylist)です。
- `load.paths`: 追加のプラグインファイルまたはロードするディレクトリ (absolute または `~`) 。
- `entries.<pluginId>`: プラグインごとのオーバーライド。
  - `enabled`: `false`を無効にします。
  - `config`: プラグイン固有の設定オブジェクト (指定された場合、プラグインによって検証されます)。

環境変数 + `.env`

```json5
{
  plugins: {
    enabled: true,
    allow: ["voice-call"],
    load: {
      paths: ["~/Projects/oss/voice-call-extension"],
    },
    entries: {
      "voice-call": {
        enabled: true,
        config: {
          provider: "twilio",
        },
      },
    },
  },
}
```

### `browser` (openclaw-managed browser)

OpenClawはオープンクローのための**専用の、分離された** Chrome/Brave/Edge/Chromiumインスタンスを開始し、小さなループバック制御サービスを公開することができます。
プロファイルは、`profiles（プロファイル）を介して**リモート** Chromiumベースのブラウザを指すことができます。<name>.cdpUrl`。 リモート
プロファイルはアタッチのみのプロファイルです（開始/停止/リセットは無効です）。

`browser.cdpUrl` は、レガシー単一プロファイルの設定で、`cdpPort`のみを設定するプロファイルのベース
スキーム/ホストとして残ります。

既定：

- 有効: `true`
- evaluateEnabled: `true` (`false`を設定すると`act:evaluate`と`wait --fn`)
- 制御サービス: loopback only (`gateway.port`から派生したポート, デフォルト `18791`)
- CDP URL: `http://127.0.0.1:18792` (制御サービス + 1、レガシーシングルプロファイル)
- profile color: `#FF4500` (lobster-orange)
- 注意: 制御サーバは実行中のゲートウェイ (OpenClaw.app menubar、または `openclawゲートウェイ`) によって起動されます。
- 自動検出: Chromium ベースの場合は既定のブラウザ; そうでない場合は Chrome → Brave → Edge → Chromium → Chrome Canary 。

```json5
{
  browser: {
    enabled: true,
    evaluateEnabled: true,
    // cdpUrl: "http://127.0.0.1:18792", // legacy single-profile override
    defaultProfile: "chrome",
    profiles: {
      openclaw: { cdpPort: 18800, color: "#FF4500" },
      work: { cdpPort: 18801, color: "#0066CC" },
      remote: { cdpUrl: "http://10.0.0.42:9222", color: "#00AA00" },
    },
    color: "#FF4500",
    // Advanced:
    // headless: false,
    // noSandbox: false,
    // executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    // attachOnly: false, // set true when tunneling a remote CDP to localhost
  },
}
```

### `ui`（外観）

UIクロムのネイティブアプリで使用される任意のアクセントカラー(例:トークモードバブルの色)。

未設定の場合、クライアントはミュートされたライトブルーに戻ります。

```json5
{
  ui: {
    seamColor: "#FF4500", // hex (RRGGBB or #RRGGBB)
    // Optional: Control UI assistant identity override.
    // If unset, the Control UI uses the active agent identity (config or IDENTITY.md).
    assistant: {
      name: "OpenClaw",
      avatar: "CB", // emoji, short text, or image URL/data URI
    },
  },
}
```

### `gateway` (ゲートウェイサーバーモード + bind)

このマシンがGatewayを実行するかどうかを明示的に宣言するには、 `gateway.mode` を使用します。

既定：

- モード: **unset** (「自動起動しない」として扱われます)
- bind: `loopback`
- port: `18789` (WS + HTTPの単一ポート)

```json5
{
  gateway: {
    mode: "local", // or "remote"
    port: 18789, // WS + HTTP multiplex
    bind: "loopback",
    // controlUi: { enabled: true, basePath: "/openclaw" }
    // auth: { mode: "token", token: "your-token" } // token gates WS + Control UI access
    // tailscale: { mode: "off" | "serve" | "funnel" }
  },
}
```

UIベースパスの制御:

- `gateway.controlUi.basePath` は、Control UI が提供されるURLプレフィックスを設定します。
- 例: `"/ui"`, `"/openclaw"`, `"/apps/openclaw"`.
- デフォルト: root (`/`) (変更なし)。
- `gateway.controlUi.root` は Control UI アセットのファイルシステムルートを設定します (デフォルト: `dist/control-ui`)。
- `gateway.controlUi.allowInsecureAuth` は、
  デバイスIDが省略されたとき(通常は HTTP 上)に制御UIのトークン専用の認証を許可します。 デフォルト: `false` HTTPS
  (Tailscale Serve) または `127.0.0.1` を優先します。
- `gateway.controlUi.dangerouslyDisableDeviceAuth` は
  Control UI (トークン/パスワードのみ) のデバイス識別チェックを無効にします。 デフォルト: `false` ブレイクグラスのみ

関連ドキュメント：

- [コントロール UI](/web/control-ui)
- [Web overview](/web)
- [Tailscale](/gateway/tailscale)
- [リモートアクセス](/gateway/remote)

信頼されたプロキシ:

- `gateway.trustedProxies`: ゲートウェイの前で TLS を終了させるリバースプロキシ IP のリスト。
- これらのIPのいずれかから接続される場合 OpenClawは`x-forwarded-for`(または`x-real-ip`)を使用して、ローカルペアリングチェックとHTTP認証/ローカルチェックのクライアントIPを決定します。
- プロキシのみを完全に制御し、`x-forwarded-for` の着信を**上書き**してください。

環境変数での指定：

- `gateway.mode` が `local` に設定されていない限り、 `openclawゲートウェイ` は起動を拒否します(またはオーバーライドフラグを渡します)。
- `gateway.port` は、WebSocket + HTTP (制御UI、フック、A2UI)に使用される単一の多重化ポートを制御します。
- OpenAI チャット完了エンドポイント: **デフォルトで無効**; `gateway.http.endpoints.chatCompletions.enabled: true` で有効にします。
- 前提: `--port` > `OPENCLAW_GATEWAY_PORT` > `gateway.port` > デフォルトの `18789` 。
- ゲートウェイ認証はデフォルトで必要です(token/password または Tailscale Serve ID)。 非ループバックバインディングには共有トークン/パスワードが必要です。
- オンボーディング ウィザードは、(ループバック時でも) デフォルトでゲートウェイ トークンを生成します。
- `gateway.remote.token`は、リモートCLI呼び出しに対してのみ\*\*です。ローカルゲートウェイ認証を有効にしません。 `gateway.token` は無視されます。

認証とテールスケール:

- `gateway.auth.mode` はハンドシェイク要件 (`token` または `password`) を設定します。 未設定の場合、トークン認証は仮定されます。
- `gateway.auth.token` にはトークン認証用の共有トークンが格納されています (CLIによって同じマシン上で使用されます)。
- `gateway.auth.mode` が設定されている場合は、そのメソッドのみが受け付けられます (オプションの Tailscale ヘッダーを加えてください)。
- `gateway.auth.password` はここに設定するか、 `OPENCLAW_GATEWAY_PASSWORD` （推奨） を介して設定できます。
- `gateway.auth.allowTailscale` は、リクエストがループバックに到達し、`x-forwarded-for`、`x-forwarded-proto`、`x-forwarded-host` が付与されている場合に、Tailscale Serve の ID ヘッダー（`tailscale-user-login`）を認証として満たすことを許可します。 OpenClaw
  は、
  `tailscale whois` を介して `x-forwarded-for` アドレスを解決して身元を確認します。 `true` の場合、Serve リクエストにはトークン／パスワードは不要です。明示的な資格情報を要求するには `false` に設定してください。 デフォルトは
  `true` で、`tailscale.mode = "serve"` と auth モードが `password` ではありません。
- `gateway.tailscale.mode: "serve"` は Tailscale Serve (tailnet only loopback bind) を使用します。
- `gateway.tailscale.mode: "funnel"` はダッシュボードを公開します。auth が必要です。
- `gateway.tailscale.resetOnExit` シャットダウン時にServe/Funnel設定をリセットします。

リモートクライアントのデフォルト (CLI):

- `gateway.remote.url` は、`gateway.mode = "remote"`のときにCLIコールのデフォルトのゲートウェイWebSocket URLを設定します。
- `gateway.remote.transport` はmacOSのリモートトランスポートを選択します (`ssh` デフォルト、 `direct` for ws/ws)。 `direct` の場合、 `gateway.remote.url` は `ws://` または `wss://` でなければなりません。 `ws://host` のデフォルトは `18789` です。
- `gateway.remote.token` は、リモート呼び出しのトークンを提供します (認証なしで unset のままにします)。
- `gateway.remote.password` はリモート呼び出しのパスワードを提供します (認証なしで未設定のままにしてください)。

macOS アプリの動作:

- OpenClaw.app は `~/.openclaw/openclaw.json` を監視し、`gateway.mode` または `gateway.remote.url` が変更されたときにスイッチモードが動作します。
- `gateway.mode` が unset されていて、 `gateway.remote.url` が設定されている場合、macOS アプリはリモートモードとして扱います。
- macOS アプリで接続モードを変更すると、`gateway.mode` (および `gateway.remote.url` + `gateway.remote.transport` )を設定ファイルに書き戻します。

```json5
{
  gateway: {
    mode: "remote",
    remote: {
      url: "ws://gateway.tailnet:18789",
      token: "your-token",
      password: "your-password",
    },
  },
}
```

ダイレクト転送の例 (macOS アプリ)

```json5
{
  gateway: {
    mode: "remote",
    remote: {
      transport: "direct",
      url: "wss://gateway.example.ts.net",
      token: "your-token",
    },
  },
}
```

### `gateway.reload` (Config hot reload)

ゲートウェイは `~/.openclaw/openclaw.json` (または `OPENCLAW_CONFIG_PATH` ) を監視し、変更を自動的に適用します。

モード:

- `hybrid` (default): ホット適用の安全な変更。重要な変更がある場合はゲートウェイを再起動してください。
- `hot`: ホットセーフな変更のみを適用します。再起動が必要な場合はログに記録します。
- `restart`: 設定変更時にゲートウェイを再起動します。
- `off`: ホットリロードを無効にする

```json5
{
  gateway: {
    reload: {
      mode: "hybrid",
      debounceMs: 300,
    },
  },
}
```

#### Hot reload matrix (files + impact)

見られたファイル:

- OpenClaw は、スキーマに完全一致する設定のみを受け付けます。  
  未知のキー、不正な型、無効な値がある場合、安全のため Gateway（ゲートウェイ）は **起動を拒否** します。

ホット適用 (完全なゲートウェイの再起動はありません):

- `hooks` (webhook auth/path/mappings) + `hooks.gmail` (Gmail ウォッチャーを再起動)
- `browser` (ブラウザ制御サーバの再起動)
- `cron` (cronサービスの再起動+同時更新)
- `agents.defaults.heartbeat` (heartbeat runner restart)
- `web` (WhatsApp Web チャンネル再起動)
- `telegram` 、 `discord` 、 `signal` 、 `imessage` (チャネルの再起動)
- `agent`, `models`, `routing`, `messages`, `session`, `whatsapp`, `logging`, `skills`, `ui`, `talk`, `identity`, `wizard`(dynamic reads)

完全なゲートウェイの再起動が必要です:

- `gateway` (port/bind/auth/control UI/tailscale)
- `bridge` (レガシー)
- `検出`
- `canvasHost`
- `プラグイン`
- 任意の不明/サポートされていない設定パス（デフォルトでは安全のために再起動）

### 複数インスタンスの単離性

複数のゲートウェイを1つのホスト(冗長性またはレスキューボット)で実行するには、インスタンスごとの状態 + 設定を分離し、一意のポートを使用します。

- `OPENCLAW_CONFIG_PATH` (インスタンス毎の設定)
- `OPENCLAW_STATE_DIR` (sessions/creds)
- `agents.defaults.workspace` (memores)
- `gateway.port` (インスタンス毎に一意)

便利フラグ（CLI）

- `openclaw --dev …` → `~/.openclaw-dev` を使用してください + ベースの `19001` からポート
- `openclaw --profile <name> …` → `~/.openclaw-<name>` （config/env/flags経由のポート）

派生したポートマッピング(ゲートウェイ/ブラウザー/キャンバス)については、[ゲートウェイランブック](/gateway)を参照してください。
ブラウザー/CDPポートの分離の詳細については、[Multiple gateways](/gateway/multiple-gateways)を参照してください。

openai

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/a.json \
OPENCLAW_STATE_DIR=~/.openclaw-a \
openclawゲートウェイ ---port 19001
```

### `フック` (Gateway webhooks)

ゲートウェイHTTPサーバーでシンプルなHTTPWebhookエンドポイントを有効にします。

既定：

- 有効: `false`
- path: `/hooks`
- maxBodyBytes: `262144` (256 KB)

```json5
{
  hooks: {
    enabled: true,
    token: "shared-secret",
    path: "/hooks",
    presets: ["gmail"],
    transformsDir: "~/.openclaw/hooks",
    mappings: [
      {
        match: { path: "gmail" },
        action: "agent",
        wakeMode: "now",
        name: "Gmail",
        sessionKey: "hook:gmail:{{messages[0].id}}",
        messageTemplate: "From: {{messages[0].from}}\nSubject: {{messages[0].subject}}\n{{messages[0].snippet}}",
        deliver: true,
        channel: "last",
        model: "openai/gpt-5.2-mini",
      },
    ],
  },
}
```

要求にはフックトークンを含める必要があります:

- `Authorization: Bearer <token>` または \*\*
- `x-openclaw-token: <token>`

エンドポイント:

- `POST /hooks/wake` → `{ text, mode?: "now"|"next-heartbeat" }`
- `POST /hooks/agent` → `{ message, name?, sessionKey?, wakeMode?, deliver?, channel?, to?, model?, thinking?, timeoutSeconds? }` を返却
- `POST /hooks/<name>` → `hooks.mappings` で解決

`/hooks/agent` は常にサマリーをメインセッションに投稿します（オプションで、 `wakeMode: "now"`を介してハートビートをトリガーすることもできます）。

マッピングノート:

- `match.path` は `/hooks` の後のサブパスにマッチします。(例: `/hooks/gmail` → `gmail`)。
- `match.source` はペイロードフィールドに一致します(例: `{ source: "gmail" }`) ので、一般的な `/hooks/ingest` パスを使用できます。
- ペイロードから読み込んだ「{{messages[0].subject}}」のようなテンプレート。
- `transform`はフックアクションを返すJS/TSモジュールを指すことができます。
- `deliver: true` は最終返信をチャンネルに送信します。`channel` のデフォルトは `last` (WhatsAppに戻ります) です。
- 事前の配信ルートがない場合は、 `channel` + `to` を明示的に設定してください(Telegram/Discord/Google Chat/Slack/Signal/iMessage/MS Teamsには必須)。
- `model` は、このフック実行のための LLM を上書きします（`provider/model` または alias; `agents.defaults.models` が設定されている場合は許可しなければなりません）。

Gmailヘルパー設定 (`openclaw webhooks gmail setup` / `run`で使用):

```json5
{
  hooks: {
    gmail: {
      account: "openclaw@gmail.com",
      topic: "projects/<project-id>/topics/gog-gmail-watch",
      subscription: "gog-gmail-watch-push",
      pushToken: "shared-push-token",
      hookUrl: "http://127.0.0.1:18789/hooks/gmail",
      includeBody: true,
      maxBytes: 20000,
      renewEveryMinutes: 720,
      serve: { bind: "127.0.0.1", port: 8788, path: "/" },
      tailscale: { mode: "funnel", path: "/gmail-pubsub" },

      // Optional: use a cheaper model for Gmail hook processing
      // Falls back to agents.defaults.model.fallbacks, then primary, on auth/rate-limit/timeout
      model: "openrouter/meta-llama/llama-3.3-70b-instruct:free",
      // Optional: default thinking level for Gmail hooks
      thinking: "off",
    },
  },
}
```

Gmail フックのモデルオーバーライド:

- `hooks.gmail.model` は Gmail フック処理に使用するモデルを指定します (デフォルトは session primary です)。
- `agents.defaults.models`から`provider/model`参照またはエイリアスを受け付けます。
- `agents.defaults.model.fallbacks`に戻り、`agents.defaults.model.primary`、auth/rate-limit/timeoutに戻ります。
- `agents.defaults.models` が設定されている場合は、許可リストにフックモデルを含めます。
- 起動時に、設定されたモデルがモデル カタログまたは許可リストにない場合に警告します。
- `hooks.gmail.thinking` はGmailフックのデフォルトの思考レベルを設定し、フックあたりの思考\`で上書きされます。

ゲートウェイの自動スタート:

- `hooks.enabled=true` と `hooks.gmail.account` が設定されている場合、ゲートウェイは起動時に
  `gog gmail watch serve` を起動し、ウォッチを自動的に更新します。
- `OPENCLAW_SKIP_GMAIL_WATCHER=1` を設定すると、自動起動を無効にします。
- Gateway と並行して別の `gog gmail watch serve` を実行しないでください。`listen tcp 127.0.0.1:8788: bind: address already in use` で失敗します。

注: `tailscale.mode` が有効な場合、OpenClaw は Tailscale が `/gmail-pubsub` を正しくプロキシできるよう、`serve.path` の既定値を `/` に設定します（設定されたパスプレフィックスは削除されます）。
接頭辞付きパスを受け取るバックエンドが必要な場合は、
`hooks.gmail.tailscale.target` にフルURLを設定してください (`serve.path`を整列させます)。

### `canvasHost` (LAN/tailnet Canvas ファイルサーバー + ライブリロード)

GatewayはHTTP経由でHTML/CSS/JSのディレクトリを提供するため、iOS/Androidノードは単に`canvas.navigate`を使用できます。

デフォルトのルート: `~/ 。 penclaw/workspace/canvas`  
デフォルトポート: `18793` (openclawブラウザのCDPポート`18792`を避けるために選択)  
サーバーはノードが到達できるように、**ゲートウェイバインドホスト** (LANまたはTailnet) 上でリッスンします。

サーバー:

- `canvasHost.root` の下にあるファイルを提供します
- 送信済みの HTML に小さなライブリロードクライアントを注入します
- ディレクトリを監視し、`/__openclaw__/ws`でWebSocketエンドポイントを再ロードします。
- ディレクトリが空の場合はスターター`index.html`を自動的に作成します（すぐに何かが表示されるようになります）
- `/__openclaw__/a2ui/`でもA2UIを提供し、ノードに`canvasHostUrl`
  (Canvas/A2UIのノードで常に使用) として宣伝されます。

ディレクトリが大きい場合、または`EMFILE`を押してください:

- config: `canvasHost: { liveReload: false }`

```json5
{
  canvasHost: {
    root: "~/.openclaw/workspace/canvas",
    port: 18793,
    liveReload: true,
  },
}
```

`canvasHost.*` への変更にはゲートウェイの再起動が必要です（設定の再読み込みは再起動されます）。

無効化するには：

- config: `canvasHost: { enabled: false }`
- env: `OPENCLAW_SKIP_CANVAS_HOST=1`

### `bridge` (レガシーTCPブリッジ、削除)

現在のビルドには TCP ブリッジリスナーが含まれなくなりました。`bridge.*` 設定キーは無視されます。
ノードはゲートウェイWebSocketに接続します。 この項目は歴史的参考として残されている。

従来の動作:

- ゲートウェイはノード(iOS/Android)の簡単なTCPブリッジ(通常はポート`18790`)を公開することができます。

既定：

- 有効: `true`
- ポート: `18790`
- bind: `lan` (`0.0.0.0`にバインド)

Bind modes:

- `lan`: `0.0.0.0` (LAN/Wi-Fiやテールスケールを含む任意のインターフェースに到達可能)
- `tailnet`: マシンの Tailscale IP にのみバインドする（ウィーン <unk> Londonに推奨）
- `loopback`: `127.0.0.1` (ローカルのみ)
- `auto`: tailnet IP があれば, else `lan`

TLS:

- `bridge.tls.enabled`: ブリッジ接続 (有効な場合は TLS のみ) の TLS を有効にします。
- `bridge.tls.autoGenerate`: 証明書/キーが存在しないときに自己署名証明書を生成します (デフォルト: true)。
- `bridge.tls.certPath` / `bridge.tls.keyPath`: PEM paths for the bridge certificate + private key.
- `bridge.tls.caPath`: オプションの PEM CA バンドル (カスタムルーツまたは future mTLS) 。

TLS が有効な場合、Gateway は検出用 TXT レコードに `bridgeTls=1` と `bridgeTlsSha256` を広告し、ノードが証明書をピン留めできるようにします。 手動接続では、
フィンガープリントがまだ保存されていない場合、trust-on-first-useを使用します。
自動生成された証明書はPATH上で`openssl`を必要とします。生成に失敗した場合、ブリッジは起動しません。

```json5
{
  bridge: {
    enabled: true,
    port: 18790,
    bind: "tailnet",
    tls: {
      enabled: true,
      // Uses ~/.openclaw/bridge/tls/bridge-{cert,key}.pem when omitted.
      // certPath: "~/.openclaw/bridge/tls/bridge-cert.pem",
      // keyPath: "~/.openclaw/bridge/tls/bridge-key.pem"
    },
  },
}
```

### `discovery.mdns` (Bonjour / mDNS ブロードキャストモード)

LAN mDNS ディスカバリブロードキャストを制御します (`_openclaw-gw._tcp`)。

- `minimal` (デフォルト): TXTレコードから `cliPath` + `sshPort` を省略します
- `full`: TXTレコードに`cliPath` + `sshPort` を含む
- `off`: mDNS ブロードキャストを完全に無効にする
- ホスト名: デフォルトは `openclaw` (`openclaw.local`を宣伝します)。 `OPENCLAW_MDNS_HOSTNAME` で上書きします。

```json5
{
  discovery: { mdns: { mode: "minimal" } },
}
```

### `discovery.wideArea` (ワイド-Area Bonjour / ユニキャストDNS‐SD)

有効にすると、ゲートウェイは設定されたディスカバリドメインを使用して、`~/.openclaw/dns/`の下の`_openclaw-gw._tcp`にユニキャストDNS-SDゾーンを書き込みます(例: `openclaw.internal.`)。

iOS/Androidをネットワーク(Vienna <unk> London)間で発見するには、以下をペアリングしてください：

- 選択したドメインを提供するゲートウェイホスト上の DNS サーバー (CoreDNS を推奨)
- クライアントがゲートウェイDNSサーバーを介してそのドメインを解決するために、Tailscale **split DNS**

ワンタイムセットアップヘルパー (ゲートウェイホスト):

```bash
openclaw dns setup --apply
```

```json5
{
  discovery: { wideArea: { enabled: true } },
}
```

## メディアモデルテンプレート変数

テンプレートプレースホルダは、 `tools.media.*.models[].args` と `tools.media.models[].args` (および将来テンプレートされた引数フィールド)で展開されます。

| Variable           | 説明                                                       |                  |              |            |       |        |          |         |         |    |
| ------------------ | -------------------------------------------------------- | ---------------- | ------------ | ---------- | ----- | ------ | -------- | ------- | ------- | -- |
| `{{Body}}`         | 受信メッセージ本文の全文                                             |                  |              |            |       |        |          |         |         |    |
| `{{RawBody}}`      | 生の受信メッセージ本文（履歴／送信者ラッパーなし。コマンド解析に最適）                      |                  |              |            |       |        |          |         |         |    |
| `{{BodyStripped}}` | グループメンションを除去した本文（エージェントの既定に最適）                           |                  |              |            |       |        |          |         |         |    |
| `{{From}}`         | 送信者識別子（WhatsApp では E.164。チャネルにより異なる場合あり） |                  |              |            |       |        |          |         |         |    |
| `{{To}}`           | 宛先識別子                                                    |                  |              |            |       |        |          |         |         |    |
| `{{MessageSid}}`   | チャネルのメッセージ ID（利用可能な場合）                                   |                  |              |            |       |        |          |         |         |    |
| `{{SessionId}}`    | 現在のセッション UUID                                            |                  |              |            |       |        |          |         |         |    |
| `{{IsNewSession}}` | 新しいセッションが作成された場合は `"true"`                               |                  |              |            |       |        |          |         |         |    |
| `{{MediaUrl}}`     | 受信メディアの疑似 URL（存在する場合）                                    |                  |              |            |       |        |          |         |         |    |
| `{{MediaPath}}`    | ローカルのメディアパス（ダウンロードされた場合）                                 |                  |              |            |       |        |          |         |         |    |
| `{{MediaType}}`    | メディア種別（image/audio/document/…）                           | `{{Transcript}}` | 音声文字起こし（有効時） |            |       |        |          |         |         |    |
| `{{Prompt}}`       | CLI エントリ向けに解決されたメディアプロンプト                                |                  |              |            |       |        |          |         |         |    |
| `{{MaxChars}}`     | CLI エントリ向けに解決された最大出力文字数                                  |                  |              |            |       |        |          |         |         |    |
| `{{ChatType}}`     | `"direct"` または `"group"`                                 |                  |              |            |       |        |          |         |         |    |
| `{{GroupSubject}}` | グループの件名（ベストエフォート）                                        |                  |              |            |       |        |          |         |         |    |
| `{{GroupMembers}}` | グループメンバーのプレビュー（ベストエフォート）                                 |                  |              |            |       |        |          |         |         |    |
| `{{SenderName}}`   | 送信者の表示名（ベストエフォート）                                        |                  |              |            |       |        |          |         |         |    |
| `{{SenderE164}}`   | 送信者の電話番号（ベストエフォート）                                       |                  |              |            |       |        |          |         |         |    |
| `{{Provider}}`     | プロバイダのヒント（whatsapp                                       | telegram         | discord      | googlechat | slack | signal | imessage | msteams | webchat | …） |

## Cron (ゲートウェイスケジューラ)

Cronは、ウェイクアップとスケジュールされたジョブのためのゲートウェイ所有のスケジューラです。 機能の概要と CLI の例については [Cron jobs](/automation/cron-jobs) を参照してください。

```json5
{
  cron: {
    enabled: true,
    maxConcurrentRuns: 2,
  },
}
```

---

_次へ：[Agent Runtime](/concepts/agent)_ 🦞
