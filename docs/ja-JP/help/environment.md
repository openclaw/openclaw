---
read_when:
    - どの環境変数がどの順序で読み込まれるか知りたい場合
    - Gateway ゲートウェイでAPIキーが見つからない問題をデバッグしている場合
    - プロバイダー認証やデプロイ環境をドキュメント化している場合
summary: OpenClawが環境変数を読み込む場所と優先順位
title: 環境変数
x-i18n:
    generated_at: "2026-04-02T07:43:28Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 1bc897f495ff4c3fc2dd676b394fba01b760a2eb82e00e088b594f34cc19fbd9
    source_path: help/environment.md
    workflow: 15
---

# 環境変数

OpenClawは複数のソースから環境変数を取得します。ルールは**既存の値を上書きしない**ことです。

## 優先順位（高い → 低い）

1. **プロセス環境**（親シェル/デーモンからGateway ゲートウェイプロセスが既に持っている値）。
2. **カレントワーキングディレクトリの`.env`**（dotenvのデフォルト。上書きしない）。
3. **グローバル`.env`**（`~/.openclaw/.env`、別名`$OPENCLAW_STATE_DIR/.env`。上書きしない）。
4. **設定ファイルの`env`ブロック**（`~/.openclaw/openclaw.json`内。未設定の場合のみ適用）。
5. **オプションのログインシェルインポート**（`env.shellEnv.enabled`または`OPENCLAW_LOAD_SHELL_ENV=1`）。期待されるキーが未設定の場合のみ適用。

設定ファイル自体が存在しない場合、ステップ4はスキップされます。シェルインポートは有効であれば引き続き実行されます。

## 設定ファイルの`env`ブロック

インライン環境変数を設定する2つの同等な方法（どちらも上書きしない）：

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

## シェル環境インポート

`env.shellEnv`はログインシェルを実行し、**未設定の**期待されるキーのみをインポートします：

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

環境変数での同等設定：

- `OPENCLAW_LOAD_SHELL_ENV=1`
- `OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000`

## ランタイム注入される環境変数

OpenClawは生成した子プロセスにコンテキストマーカーも注入します：

- `OPENCLAW_SHELL=exec`：`exec`ツールで実行されるコマンドに設定。
- `OPENCLAW_SHELL=acp`：ACPランタイムバックエンドプロセスの生成時（例：`acpx`）に設定。
- `OPENCLAW_SHELL=acp-client`：`openclaw acp client`がACPブリッジプロセスを生成する際に設定。
- `OPENCLAW_SHELL=tui-local`：ローカルTUIの`!`シェルコマンドに設定。

これらはランタイムマーカーであり（ユーザー設定として必須ではありません）、シェル/プロファイルのロジックで
コンテキスト固有のルールを適用するために使用できます。

## UI環境変数

- `OPENCLAW_THEME=light`：ターミナルの背景が明るい場合にライトTUIパレットを強制します。
- `OPENCLAW_THEME=dark`：ダークTUIパレットを強制します。
- `COLORFGBG`：ターミナルがこの変数をエクスポートしている場合、OpenClawは背景色のヒントを使用してTUIパレットを自動選択します。

## 設定内の環境変数置換

設定の文字列値で`${VAR_NAME}`構文を使用して環境変数を直接参照できます：

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

詳細は[設定：環境変数置換](/gateway/configuration-reference#env-var-substitution)を参照してください。

## Secret refと`${ENV}`文字列の違い

OpenClawは2つの環境変数駆動パターンをサポートしています：

- 設定値での`${VAR}`文字列置換。
- シークレット参照をサポートするフィールド用のSecretRefオブジェクト（`{ source: "env", provider: "default", id: "VAR" }`）。

どちらもアクティベーション時にプロセス環境から解決されます。SecretRefの詳細は[シークレット管理](/gateway/secrets)に記載されています。

## パス関連の環境変数

| 変数                   | 用途                                                                                                                                                                          |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENCLAW_HOME`        | すべての内部パス解決（`~/.openclaw/`、エージェントディレクトリ、セッション、認証情報）に使用されるホームディレクトリを上書きします。OpenClawを専用サービスユーザーとして実行する場合に便利です。 |
| `OPENCLAW_STATE_DIR`   | ステートディレクトリを上書きします（デフォルト：`~/.openclaw`）。                                                                                                                            |
| `OPENCLAW_CONFIG_PATH` | 設定ファイルのパスを上書きします（デフォルト：`~/.openclaw/openclaw.json`）。                                                                                                             |

## ログ

| 変数                 | 用途                                                                                                                                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENCLAW_LOG_LEVEL` | ファイルとコンソール両方のログレベルを上書きします（例：`debug`、`trace`）。設定の`logging.level`および`logging.consoleLevel`より優先されます。無効な値は警告とともに無視されます。 |

### `OPENCLAW_HOME`

設定すると、`OPENCLAW_HOME`はすべての内部パス解決においてシステムのホームディレクトリ（`$HOME` / `os.homedir()`）を置き換えます。これにより、ヘッドレスサービスアカウントの完全なファイルシステム分離が可能になります。

**優先順位：** `OPENCLAW_HOME` > `$HOME` > `USERPROFILE` > `os.homedir()`

**例**（macOS LaunchDaemon）：

```xml
<key>EnvironmentVariables</key>
<dict>
  <key>OPENCLAW_HOME</key>
  <string>/Users/user</string>
</dict>
```

`OPENCLAW_HOME`はチルダパス（例：`~/svc`）にも設定でき、使用前に`$HOME`を使って展開されます。

## nvmユーザー：web_fetchのTLS障害

Node.jsが**nvm**（システムパッケージマネージャーではなく）でインストールされた場合、組み込みの`fetch()`は
nvmにバンドルされたCAストアを使用しますが、最新のルートCA（Let's Encrypt用のISRG Root X1/X2、
DigiCert Global Root G2など）が含まれていない場合があります。これにより、ほとんどのHTTPSサイトで`web_fetch`が`"fetch failed"`で失敗します。

Linuxでは、OpenClawが自動的にnvmを検出し、実際の起動環境で修正を適用します：

- `openclaw gateway install`がsystemdサービス環境に`NODE_EXTRA_CA_CERTS`を書き込みます
- `openclaw` CLIエントリーポイントがNode起動前に`NODE_EXTRA_CA_CERTS`を設定した状態で自身を再実行します

**手動修正（古いバージョンまたは直接`node ...`起動の場合）：**

OpenClaw起動前に変数をエクスポートしてください：

```bash
export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
openclaw gateway run
```

この変数については`~/.openclaw/.env`への書き込みだけに頼らないでください。Nodeは
プロセス起動時に`NODE_EXTRA_CA_CERTS`を読み取ります。

## 関連

- [Gateway ゲートウェイの設定](/gateway/configuration)
- [よくある質問：環境変数と.envの読み込み](/help/faq#env-vars-and-env-loading)
- [モデル概要](/concepts/models)
