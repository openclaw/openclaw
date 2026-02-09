---
summary: "モデル認証：OAuth、API キー、および setup-token"
read_when:
  - モデル認証や OAuth の有効期限切れをデバッグする場合
  - 認証や資格情報の保存を文書化する場合
title: "認証"
---

# 認証

OpenClaw は、モデルプロバイダー向けに OAuth と API キーをサポートします。Anthropic のアカウントでは、**API キー**の使用を推奨します。Claude のサブスクリプションアクセスには、`claude setup-token` によって作成される長期有効トークンを使用してください。 Anthropic
アカウントでは、**API キー**を使用することをお勧めします。 22. Claude のサブスクリプションアクセスには、`claude setup-token` で作成した長期間有効なトークンを使用してください。

OAuth の完全なフローと保存レイアウトについては、[/concepts/oauth](/concepts/oauth) を参照してください。

## 推奨される Anthropic のセットアップ（API キー）

Anthropic を直接使用する場合は、API キーを使用します。

1. Anthropic Console で API キーを作成します。
2. **ゲートウェイ ホスト**（`openclaw gateway` を実行しているマシン）に配置します。

```bash
export ANTHROPIC_API_KEY="..."
openclaw models status
```

3. Gateway が systemd/launchd の下で実行されている場合は、デーモンが読み取れるように `~/.openclaw/.env` にキーを配置することを推奨します。

```bash
cat >> ~/.openclaw/.env <<'EOF'
ANTHROPIC_API_KEY=...
EOF
```

その後、デーモン（または Gateway プロセス）を再起動し、再確認します。

```bash
openclaw models status
openclaw doctor
```

環境変数を自分で管理したくない場合は、オンボーディング ウィザードがデーモン用に API キーを保存できます：`openclaw onboard`。

環境変数の継承（`env.shellEnv`、`~/.openclaw/.env`、systemd/launchd）の詳細については、[Help](/help) を参照してください。

## Anthropic：setup-token（サブスクリプション認証）

Anthropicでは、推奨されるパスは**APIキー**です。 Claude
サブスクリプションを使用している場合は、setup-token フローもサポートされます。 **ゲートウェイホスト**で実行します。

```bash
claude setup-token
```

次に、OpenClaw に貼り付けます。

```bash
openclaw models auth setup-token --provider anthropic
```

トークンが別のマシンで作成された場合は、手動で貼り付けてください。

```bash
openclaw models auth paste-token --provider anthropic
```

次のような Anthropic のエラーが表示される場合は、

```
This credential is only authorized for use with Claude Code and cannot be used for other API requests.
```

…代わりに Anthropic の API キーを使用してください。

手動トークン入力（任意のプロバイダー；`auth-profiles.json` に書き込み、設定を更新）：

```bash
openclaw models auth paste-token --provider anthropic
openclaw models auth paste-token --provider openrouter
```

自動化に適したチェック（期限切れ／未設定時は `1` で終了、期限接近時は `2`）：

```bash
openclaw models status --check
```

オプションの運用スクリプト（systemd/Termux）については、こちらを参照してください：
[/automation/auth-monitoring](/automation/auth-monitoring)

> `claude setup-token` には対話型 TTY が必要です。

## モデル認証ステータスの確認

```bash
openclaw models status
openclaw doctor
```

## 使用する資格情報の制御

### セッション単位（チャット コマンド）

`/model <alias-or-id>@<profileId>` を使用して、現在のセッションに特定のプロバイダー資格情報を固定します（例のプロファイル ID：`anthropic:default`、`anthropic:work`）。

簡易ピッカーには `/model`（または `/model list`）を使用し、完全表示（候補 + 次の認証プロファイル、設定されている場合はプロバイダー エンドポイントの詳細）には `/model status` を使用します。

### エージェント単位（CLI オーバーライド）

エージェントに対して明示的な認証プロファイル順のオーバーライドを設定します（そのエージェントの `auth-profiles.json` に保存されます）。

```bash
openclaw models auth order get --provider anthropic
openclaw models auth order set --provider anthropic anthropic:default
openclaw models auth order clear --provider anthropic
```

特定のエージェントを対象にするには `--agent <id>` を使用します。省略した場合は、設定されたデフォルト エージェントが使用されます。

## トラブルシューティング

### 「No credentials found」

Anthropic のトークン プロファイルが見つからない場合は、**ゲートウェイ ホスト**で `claude setup-token` を実行し、その後に再確認してください。

```bash
openclaw models status
```

### トークンの期限切れ／期限接近

`openclaw models status` を実行して、どのプロファイルが期限切れになっているかを確認します。プロファイルが見つからない場合は、`claude setup-token` を再実行し、トークンを再度貼り付けてください。 プロファイル
がない場合は、`claude setup-token`を再度実行し、トークンを再度貼り付けます。

## 要件

- Claude Max または Pro のサブスクリプション（`claude setup-token` 用）
- Claude Code CLI がインストールされていること（`claude` コマンドが利用可能）
