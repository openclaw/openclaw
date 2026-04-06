---
read_when:
    - 非対話的に設定を読み取りまたは編集したい場合
summary: '`openclaw config`のCLIリファレンス（get/set/unset/file/schema/validate）'
title: config
x-i18n:
    generated_at: "2026-04-02T07:33:31Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 19b0869d6e4c44212fffc15ab9af3f8f6abdfdd514c91d8233726754b0216fef
    source_path: cli/config.md
    workflow: 15
---

# `openclaw config`

`openclaw.json`の非対話的な編集のための設定ヘルパー：パスによるget/set/unset/file/schema/validate
およびアクティブな設定ファイルの表示。サブコマンドなしで実行すると、
設定ウィザードが開きます（`openclaw configure`と同じ）。

## 使用例

```bash
openclaw config file
openclaw config schema
openclaw config get browser.executablePath
openclaw config set browser.executablePath "/usr/bin/google-chrome"
openclaw config set agents.defaults.heartbeat.every "2h"
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
openclaw config set channels.discord.token --ref-provider default --ref-source env --ref-id DISCORD_BOT_TOKEN
openclaw config set secrets.providers.vaultfile --provider-source file --provider-path /etc/openclaw/secrets.json --provider-mode json
openclaw config unset plugins.entries.brave.config.webSearch.apiKey
openclaw config set channels.discord.token --ref-provider default --ref-source env --ref-id DISCORD_BOT_TOKEN --dry-run
openclaw config validate
openclaw config validate --json
```

### `config schema`

`openclaw.json`の生成されたJSONスキーマをプレーンテキストとして標準出力に表示します。

```bash
openclaw config schema
```

他のツールで検査または検証したい場合はファイルにパイプしてください：

```bash
openclaw config schema > openclaw.schema.json
```

### パス

パスはドット記法またはブラケット記法を使用します：

```bash
openclaw config get agents.defaults.workspace
openclaw config get agents.list[0].id
```

エージェントリストのインデックスを使用して特定のエージェントを指定できます：

```bash
openclaw config get agents.list
openclaw config set agents.list[1].tools.exec.node "node-id-or-name"
```

## 値

値は可能な場合JSON5としてパースされ、それ以外は文字列として扱われます。
JSON5パースを必須にするには`--strict-json`を使用してください。`--json`はレガシーエイリアスとして引き続きサポートされています。

```bash
openclaw config set agents.defaults.heartbeat.every "0m"
openclaw config set gateway.port 19001 --strict-json
openclaw config set channels.whatsapp.groups '["*"]' --strict-json
```

## `config set`モード

`openclaw config set`は4つの代入スタイルをサポートしています：

1. 値モード：`openclaw config set <path> <value>`
2. SecretRefビルダーモード：

```bash
openclaw config set channels.discord.token \
  --ref-provider default \
  --ref-source env \
  --ref-id DISCORD_BOT_TOKEN
```

3. プロバイダービルダーモード（`secrets.providers.<alias>`パスのみ）：

```bash
openclaw config set secrets.providers.vault \
  --provider-source exec \
  --provider-command /usr/local/bin/openclaw-vault \
  --provider-arg read \
  --provider-arg openai/api-key \
  --provider-timeout-ms 5000
```

4. バッチモード（`--batch-json`または`--batch-file`）：

```bash
openclaw config set --batch-json '[
  {
    "path": "secrets.providers.default",
    "provider": { "source": "env" }
  },
  {
    "path": "channels.discord.token",
    "ref": { "source": "env", "provider": "default", "id": "DISCORD_BOT_TOKEN" }
  }
]'
```

```bash
openclaw config set --batch-file ./config-set.batch.json --dry-run
```

ポリシーに関する注意：

- SecretRefの代入は、サポートされていないランタイム可変サーフェス（例：`hooks.token`、`commands.ownerDisplaySecret`、Discordスレッドバインディングwebhookトークン、WhatsApp認証情報JSON）では拒否されます。[SecretRef認証情報サーフェス](/reference/secretref-credential-surface)を参照してください。

バッチパースは常にバッチペイロード（`--batch-json`/`--batch-file`）を信頼できるソースとして使用します。
`--strict-json` / `--json`はバッチパースの動作を変更しません。

JSONパス/値モードはSecretRefとプロバイダーの両方で引き続きサポートされています：

```bash
openclaw config set channels.discord.token \
  '{"source":"env","provider":"default","id":"DISCORD_BOT_TOKEN"}' \
  --strict-json

openclaw config set secrets.providers.vaultfile \
  '{"source":"file","path":"/etc/openclaw/secrets.json","mode":"json"}' \
  --strict-json
```

## プロバイダービルダーフラグ

プロバイダービルダーのターゲットは、パスとして`secrets.providers.<alias>`を使用する必要があります。

共通フラグ：

- `--provider-source <env|file|exec>`
- `--provider-timeout-ms <ms>`（`file`、`exec`）

envプロバイダー（`--provider-source env`）：

- `--provider-allowlist <ENV_VAR>`（繰り返し指定可能）

fileプロバイダー（`--provider-source file`）：

- `--provider-path <path>`（必須）
- `--provider-mode <singleValue|json>`
- `--provider-max-bytes <bytes>`

execプロバイダー（`--provider-source exec`）：

- `--provider-command <path>`（必須）
- `--provider-arg <arg>`（繰り返し指定可能）
- `--provider-no-output-timeout-ms <ms>`
- `--provider-max-output-bytes <bytes>`
- `--provider-json-only`
- `--provider-env <KEY=VALUE>`（繰り返し指定可能）
- `--provider-pass-env <ENV_VAR>`（繰り返し指定可能）
- `--provider-trusted-dir <path>`（繰り返し指定可能）
- `--provider-allow-insecure-path`
- `--provider-allow-symlink-command`

堅牢化されたexecプロバイダーの例：

```bash
openclaw config set secrets.providers.vault \
  --provider-source exec \
  --provider-command /usr/local/bin/openclaw-vault \
  --provider-arg read \
  --provider-arg openai/api-key \
  --provider-json-only \
  --provider-pass-env VAULT_TOKEN \
  --provider-trusted-dir /usr/local/bin \
  --provider-timeout-ms 5000
```

## ドライラン

`--dry-run`を使用して、`openclaw.json`に書き込まずに変更を検証できます。

```bash
openclaw config set channels.discord.token \
  --ref-provider default \
  --ref-source env \
  --ref-id DISCORD_BOT_TOKEN \
  --dry-run

openclaw config set channels.discord.token \
  --ref-provider default \
  --ref-source env \
  --ref-id DISCORD_BOT_TOKEN \
  --dry-run \
  --json

openclaw config set channels.discord.token \
  --ref-provider vault \
  --ref-source exec \
  --ref-id discord/token \
  --dry-run \
  --allow-exec
```

ドライランの動作：

- ビルダーモード：変更されたref/プロバイダーに対してSecretRef解決可能性チェックを実行します。
- JSONモード（`--strict-json`、`--json`、またはバッチモード）：スキーマ検証とSecretRef解決可能性チェックを実行します。
- 既知のサポートされていないSecretRefターゲットサーフェスに対してもポリシー検証が実行されます。
- ポリシーチェックは変更後の完全な設定を評価するため、親オブジェクトの書き込み（例：`hooks`をオブジェクトとして設定）ではサポートされていないサーフェスの検証をバイパスできません。
- exec SecretRefチェックはコマンドの副作用を避けるため、ドライラン時にはデフォルトでスキップされます。
- exec SecretRefチェックをオプトインするには、`--dry-run`と`--allow-exec`を使用してください（プロバイダーコマンドが実行される場合があります）。
- `--allow-exec`はドライラン専用であり、`--dry-run`なしで使用するとエラーになります。

`--dry-run --json`は機械可読なレポートを出力します：

- `ok`：ドライランが成功したかどうか
- `operations`：評価された代入の数
- `checks`：スキーマ/解決可能性チェックが実行されたかどうか
- `checks.resolvabilityComplete`：解決可能性チェックが完了したかどうか（exec refがスキップされた場合はfalse）
- `refsChecked`：ドライラン中に実際に解決されたrefの数
- `skippedExecRefs`：`--allow-exec`が設定されていないためにスキップされたexec refの数
- `errors`：`ok=false`の場合の構造化されたスキーマ/解決可能性の失敗

### JSON出力の形式

```json5
{
  ok: boolean,
  operations: number,
  configPath: string,
  inputModes: ["value" | "json" | "builder", ...],
  checks: {
    schema: boolean,
    resolvability: boolean,
    resolvabilityComplete: boolean,
  },
  refsChecked: number,
  skippedExecRefs: number,
  errors?: [
    {
      kind: "schema" | "resolvability",
      message: string,
      ref?: string, // present for resolvability errors
    },
  ],
}
```

成功例：

```json
{
  "ok": true,
  "operations": 1,
  "configPath": "~/.openclaw/openclaw.json",
  "inputModes": ["builder"],
  "checks": {
    "schema": false,
    "resolvability": true,
    "resolvabilityComplete": true
  },
  "refsChecked": 1,
  "skippedExecRefs": 0
}
```

失敗例：

```json
{
  "ok": false,
  "operations": 1,
  "configPath": "~/.openclaw/openclaw.json",
  "inputModes": ["builder"],
  "checks": {
    "schema": false,
    "resolvability": true,
    "resolvabilityComplete": true
  },
  "refsChecked": 1,
  "skippedExecRefs": 0,
  "errors": [
    {
      "kind": "resolvability",
      "message": "Error: Environment variable \"MISSING_TEST_SECRET\" is not set.",
      "ref": "env:default:MISSING_TEST_SECRET"
    }
  ]
}
```

ドライランが失敗した場合：

- `config schema validation failed`：変更後の設定の形式が無効です。パス/値またはプロバイダー/refオブジェクトの形式を修正してください。
- `Config policy validation failed: unsupported SecretRef usage`：その認証情報をプレーンテキスト/文字列入力に戻し、SecretRefはサポートされているサーフェスのみで使用してください。
- `SecretRef assignment(s) could not be resolved`：参照されたプロバイダー/refが現在解決できません（環境変数の欠落、無効なファイルポインタ、execプロバイダーの失敗、またはプロバイダー/ソースの不一致）。
- `Dry run note: skipped <n> exec SecretRef resolvability check(s)`：ドライランでexec refがスキップされました。exec解決可能性の検証が必要な場合は`--allow-exec`を付けて再実行してください。
- バッチモードの場合は、失敗したエントリを修正してから書き込み前に`--dry-run`を再実行してください。

## サブコマンド

- `config file`：アクティブな設定ファイルのパスを表示します（`OPENCLAW_CONFIG_PATH`またはデフォルトの場所から解決）。

編集後はGateway ゲートウェイを再起動してください。

## 検証

Gateway ゲートウェイを起動せずに、現在の設定をアクティブなスキーマに対して検証します。

```bash
openclaw config validate
openclaw config validate --json
```
