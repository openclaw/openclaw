---
summary: "OpenClaw が環境変数を読み込む場所と優先順位"
read_when:
  - どの環境変数がどの順序で読み込まれるかを確認したいとき
  - Gateway での API キーが見つからない問題をデバッグしているとき
  - プロバイダー認証やデプロイ環境のドキュメントを作成しているとき
title: "環境変数"
---

# 環境変数

OpenClaw は複数のソースから環境変数を読み込みます。ルールは**既存の値を上書きしない**ことです。

## 優先順位（高 → 低）

1. **プロセス環境**（Gateway プロセスが親シェル/デーモンからすでに持っているもの）。
2. **カレントディレクトリの `.env`**（dotenv のデフォルト; 上書きしません）。
3. **グローバル `.env`**（`~/.openclaw/.env`、別名 `$OPENCLAW_STATE_DIR/.env`; 上書きしません）。
4. **設定の `env` ブロック**（`~/.openclaw/openclaw.json` 内; 欠落している場合にのみ適用）。
5. **オプションのログインシェルインポート**（`env.shellEnv.enabled` または `OPENCLAW_LOAD_SHELL_ENV=1`; 欠落しているキーにのみ適用）。

設定ファイルが完全に欠落している場合、ステップ 4 はスキップされます。シェルインポートは有効な場合は引き続き実行されます。

## 設定の `env` ブロック

インライン環境変数を設定する 2 つの同等の方法（どちらも上書きしません）:

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

## シェル環境のインポート

`env.shellEnv` はログインシェルを実行し、**欠落している**期待されるキーのみをインポートします:

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

同等の環境変数:

- `OPENCLAW_LOAD_SHELL_ENV=1`
- `OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000`

## 設定での環境変数の置換

設定の文字列値で `${VAR_NAME}` 構文を使用して環境変数を直接参照できます:

```json5
{
  models: {
    providers: {
      "vercel-gateway": {
        apiKey: "${VERCEL_GATEWAY_API_KEY}",
      },
    },
  },
}
```

詳細については [設定: 環境変数の置換](/gateway/configuration#env-var-substitution-in-config) を参照してください。

## シークレット参照 vs `${ENV}` 文字列

OpenClaw は 2 つの環境変数駆動パターンをサポートしています:

- 設定値での `${VAR}` 文字列置換。
- シークレット参照をサポートするフィールド向けの SecretRef オブジェクト（`{ source: "env", provider: "default", id: "VAR" }`）。

どちらも有効化時にプロセス環境から解決されます。SecretRef の詳細は [シークレット管理](/gateway/secrets) に記載されています。

## パス関連の環境変数

| 変数 | 目的 |
| ---- | ---- |
| `OPENCLAW_HOME` | すべての内部パス解決に使用するホームディレクトリをオーバーライドします（`~/.openclaw/`、エージェントディレクトリ、セッション、クレデンシャル）。専用サービスユーザーとして OpenClaw を実行する場合に便利です。 |
| `OPENCLAW_STATE_DIR` | 状態ディレクトリをオーバーライドします（デフォルト: `~/.openclaw`）。 |
| `OPENCLAW_CONFIG_PATH` | 設定ファイルパスをオーバーライドします（デフォルト: `~/.openclaw/openclaw.json`）。 |

## ログ

| 変数 | 目的 |
| ---- | ---- |
| `OPENCLAW_LOG_LEVEL` | ファイルとコンソールの両方のログレベルをオーバーライドします（例: `debug`、`trace`）。設定の `logging.level` および `logging.consoleLevel` より優先されます。無効な値は警告付きで無視されます。 |

### `OPENCLAW_HOME`

設定すると、`OPENCLAW_HOME` はすべての内部パス解決においてシステムのホームディレクトリ（`$HOME` / `os.homedir()`）を置き換えます。これにより、ヘッドレスサービスアカウントの完全なファイルシステム隔離が可能になります。

**優先順位:** `OPENCLAW_HOME` > `$HOME` > `USERPROFILE` > `os.homedir()`

**例**（macOS LaunchDaemon）:

```xml
<key>EnvironmentVariables</key>
<dict>
  <key>OPENCLAW_HOME</key>
  <string>/Users/kira</string>
</dict>
```

`OPENCLAW_HOME` はチルダパス（例: `~/svc`）にも設定できます。その場合は使用前に `$HOME` を使って展開されます。

## 関連情報

- [Gateway の設定](/gateway/configuration)
- [FAQ: 環境変数と .env の読み込み](/help/faq#env-vars-and-env-loading)
- [モデルの概要](/concepts/models)
