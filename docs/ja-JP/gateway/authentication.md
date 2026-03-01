---
summary: "モデル認証: OAuth、APIキー、setup-token"
read_when:
  - Debugging model auth or OAuth expiry
  - Documenting authentication or credential storage
title: "認証"
---

# 認証

OpenClawはモデルプロバイダーに対してOAuthとAPIキーをサポートしています。Anthropicアカウントの場合は、**APIキー**の使用を推奨します。Claudeサブスクリプションアクセスの場合は、`claude setup-token`で作成された長期トークンを使用してください。

OAuthフローとストレージレイアウトの詳細については、[/concepts/oauth](/concepts/oauth)を参照してください。
SecretRefベースの認証（`env`/`file`/`exec`プロバイダー）については、[シークレット管理](/gateway/secrets)を参照してください。

## 推奨されるAnthropicセットアップ（APIキー）

Anthropicを直接使用する場合は、APIキーを使用してください。

1. Anthropic ConsoleでAPIキーを作成します。
2. **Gatewayホスト**（`openclaw gateway`を実行しているマシン）に配置します。

```bash
export ANTHROPIC_API_KEY="..."
openclaw models status
```

3. Gatewayがsystemd/launchdで実行されている場合は、デーモンが読み取れるように`~/.openclaw/.env`にキーを配置することを推奨します：

```bash
cat >> ~/.openclaw/.env <<'EOF'
ANTHROPIC_API_KEY=...
EOF
```

次にデーモンを再起動（またはGatewayプロセスを再起動）して再確認します：

```bash
openclaw models status
openclaw doctor
```

環境変数を自分で管理したくない場合は、オンボーディングウィザードでデーモン用のAPIキーを保存できます：`openclaw onboard`。

環境変数の継承（`env.shellEnv`、`~/.openclaw/.env`、systemd/launchd）の詳細については、[ヘルプ](/help)を参照してください。

## Anthropic: setup-token（サブスクリプション認証）

Anthropicの場合、推奨されるパスは**APIキー**です。Claudeサブスクリプションを使用している場合は、setup-tokenフローもサポートされています。**Gatewayホスト**で実行してください：

```bash
claude setup-token
```

次にOpenClawに貼り付けます：

```bash
openclaw models auth setup-token --provider anthropic
```

トークンが別のマシンで作成された場合は、手動で貼り付けます：

```bash
openclaw models auth paste-token --provider anthropic
```

以下のようなAnthropicエラーが表示された場合：

```
This credential is only authorized for use with Claude Code and cannot be used for other API requests.
```

…代わりにAnthropic APIキーを使用してください。

手動トークン入力（任意のプロバイダー。`auth-profiles.json`に書き込み、設定を更新します）：

```bash
openclaw models auth paste-token --provider anthropic
openclaw models auth paste-token --provider openrouter
```

認証プロファイル参照は静的な認証情報にもサポートされています：

- `api_key`認証情報は`keyRef: { source, provider, id }`を使用できます
- `token`認証情報は`tokenRef: { source, provider, id }`を使用できます

自動化対応のチェック（期限切れ/不足の場合は終了コード`1`、期限切れ間近の場合は`2`）：

```bash
openclaw models status --check
```

オプションの運用スクリプト（systemd/Termux）はこちらに記載されています：
[/automation/auth-monitoring](/automation/auth-monitoring)

> `claude setup-token`にはインタラクティブTTYが必要です。

## モデル認証ステータスの確認

```bash
openclaw models status
openclaw doctor
```

## APIキーローテーション動作（Gateway）

一部のプロバイダーは、APIコールがプロバイダーのレート制限に達した場合に、代替キーでリクエストを再試行することをサポートしています。

- 優先順序：
  - `OPENCLAW_LIVE_<PROVIDER>_KEY`（単一オーバーライド）
  - `<PROVIDER>_API_KEYS`
  - `<PROVIDER>_API_KEY`
  - `<PROVIDER>_API_KEY_*`
- Googleプロバイダーは追加のフォールバックとして`GOOGLE_API_KEY`も含みます。
- 同じキーリストは使用前に重複排除されます。
- OpenClawはレート制限エラー（例：`429`、`rate_limit`、`quota`、`resource exhausted`）の場合のみ次のキーで再試行します。
- レート制限以外のエラーは代替キーで再試行されません。
- すべてのキーが失敗した場合、最後の試行からの最終エラーが返されます。

## 使用する認証情報の制御

### セッション単位（チャットコマンド）

`/model <alias-or-id>@<profileId>`を使用して、現在のセッションに特定のプロバイダー認証情報を固定します（プロファイルIDの例：`anthropic:default`、`anthropic:work`）。

`/model`（または`/model list`）でコンパクトなピッカーを表示します。`/model status`でフルビュー（候補 + 次の認証プロファイル、設定されている場合はプロバイダーエンドポイントの詳細）を表示します。

### エージェント単位（CLIオーバーライド）

エージェントの明示的な認証プロファイル順序オーバーライドを設定します（そのエージェントの`auth-profiles.json`に保存されます）：

```bash
openclaw models auth order get --provider anthropic
openclaw models auth order set --provider anthropic anthropic:default
openclaw models auth order clear --provider anthropic
```

`--agent <id>`を使用して特定のエージェントをターゲットにします。省略すると設定されたデフォルトエージェントが使用されます。

## トラブルシューティング

### 「No credentials found」

Anthropicトークンプロファイルが見つからない場合は、**Gatewayホスト**で`claude setup-token`を実行してから再確認してください：

```bash
openclaw models status
```

### トークンの期限切れ/有効期限切れ

`openclaw models status`を実行して、どのプロファイルが期限切れになっているかを確認します。プロファイルが見つからない場合は、`claude setup-token`を再実行してトークンを再度貼り付けてください。

## 要件

- Claude MaxまたはProサブスクリプション（`claude setup-token`用）
- Claude Code CLIがインストールされていること（`claude`コマンドが利用可能）
