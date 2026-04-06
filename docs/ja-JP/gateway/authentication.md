---
read_when:
    - モデル認証やOAuthの有効期限切れをデバッグする場合
    - 認証や認証情報の保存についてドキュメントを作成する場合
summary: 'モデル認証: OAuth、APIキー、setup-token'
title: 認証
x-i18n:
    generated_at: "2026-04-02T07:41:02Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: ab5a5e62669fc40da45093fd980248ded08e9b14166f87a85b350c1ff1854a7a
    source_path: gateway/authentication.md
    workflow: 15
---

# 認証（モデルプロバイダー）

<Note>
このページでは**モデルプロバイダー**の認証（APIキー、OAuth、セットアップトークン）について説明します。**Gateway ゲートウェイ接続**の認証（トークン、パスワード、trusted-proxy）については、[設定](/gateway/configuration)および[Trusted Proxy認証](/gateway/trusted-proxy-auth)を参照してください。
</Note>

OpenClawはモデルプロバイダー向けにOAuthとAPIキーをサポートしています。常時稼働のGateway ゲートウェイホストでは、APIキーが通常最も予測可能な選択肢です。サブスクリプション/OAuthフローも、プロバイダーアカウントモデルに合致する場合はサポートされています。

完全なOAuthフローとストレージレイアウトについては[/concepts/oauth](/concepts/oauth)を参照してください。
SecretRefベースの認証（`env`/`file`/`exec` プロバイダー）については、[シークレット管理](/gateway/secrets)を参照してください。
`models status --probe` で使用される認証情報の適格性/理由コードルールについては、[認証情報のセマンティクス](/auth-credential-semantics)を参照してください。

## 推奨セットアップ（APIキー、任意のプロバイダー）

長期稼働のGateway ゲートウェイを運用する場合は、選択したプロバイダーのAPIキーから始めてください。
特にAnthropicの場合、APIキー認証が安全なパスであり、サブスクリプションのsetup-token認証よりも推奨されます。

1. プロバイダーコンソールでAPIキーを作成します。
2. **Gateway ゲートウェイホスト**（`openclaw gateway` を実行するマシン）にキーを配置します。

```bash
export <PROVIDER>_API_KEY="..."
openclaw models status
```

3. Gateway ゲートウェイがsystemd/launchdで動作している場合は、デーモンが読み取れるように `~/.openclaw/.env` にキーを配置することを推奨します:

```bash
cat >> ~/.openclaw/.env <<'EOF'
<PROVIDER>_API_KEY=...
EOF
```

その後、デーモンを再起動（またはGateway ゲートウェイプロセスを再起動）し、再確認します:

```bash
openclaw models status
openclaw doctor
```

環境変数を自分で管理したくない場合は、オンボーディングでデーモン用のAPIキーを保存できます: `openclaw onboard`。

環境変数の継承（`env.shellEnv`、`~/.openclaw/.env`、systemd/launchd）の詳細は[ヘルプ](/help)を参照してください。

## Anthropic: setup-token（サブスクリプション認証）

Claudeサブスクリプションを使用している場合、setup-tokenフローがサポートされています。**Gateway ゲートウェイホスト**で実行してください:

```bash
claude setup-token
```

次にOpenClawに貼り付けます:

```bash
openclaw models auth setup-token --provider anthropic
```

トークンが別のマシンで作成された場合は、手動で貼り付けます:

```bash
openclaw models auth paste-token --provider anthropic
```

以下のようなAnthropicエラーが表示された場合:

```
This credential is only authorized for use with Claude Code and cannot be used for other API requests.
```

…代わりにAnthropic APIキーを使用してください。

<Warning>
Anthropic setup-tokenのサポートは技術的な互換性のみです。Anthropicは過去にClaude Code以外でのサブスクリプション利用をブロックしたことがあります。ポリシーリスクを許容できると判断した場合にのみ使用し、Anthropicの現行規約を自身で確認してください。
</Warning>

手動トークン入力（任意のプロバイダー。`auth-profiles.json` に書き込み、設定を更新します）:

```bash
openclaw models auth paste-token --provider anthropic
openclaw models auth paste-token --provider openrouter
```

静的認証情報にはAuthプロファイル参照もサポートされています:

- `api_key` 認証情報は `keyRef: { source, provider, id }` を使用できます
- `token` 認証情報は `tokenRef: { source, provider, id }` を使用できます
- OAuthモードのプロファイルはSecretRef認証情報をサポートしません。`auth.profiles.<id>.mode` が `"oauth"` に設定されている場合、そのプロファイルに対するSecretRefベースの `keyRef`/`tokenRef` 入力は拒否されます。

自動化向けチェック（期限切れ/未設定の場合は終了コード `1`、まもなく期限切れの場合は `2`）:

```bash
openclaw models status --check
```

オプションの運用スクリプト（systemd/Termux）はこちらに記載されています:
[/automation/auth-monitoring](/automation/auth-monitoring)

> `claude setup-token` にはインタラクティブなTTYが必要です。

## Anthropic: Claude CLI移行

Claude CLIがGateway ゲートウェイホストに既にインストールされサインイン済みの場合、既存のAnthropicセットアップをsetup-tokenの貼り付けではなくCLIバックエンドに切り替えることができます:

```bash
openclaw models auth login --provider anthropic --method cli --set-default
```

これにより既存のAnthropic認証プロファイルはロールバック用に保持されますが、デフォルトのモデル選択が `claude-cli/...` に変更され、`agents.defaults.models` の下に対応するClaude CLIの許可リストエントリが追加されます。

オンボーディングのショートカット:

```bash
openclaw onboard --auth-choice anthropic-cli
```

## モデル認証ステータスの確認

```bash
openclaw models status
openclaw doctor
```

## APIキーのローテーション動作（Gateway ゲートウェイ）

一部のプロバイダーは、API呼び出しがプロバイダーのレート制限に達した際に、代替キーでリクエストを再試行することをサポートしています。

- 優先順位:
  - `OPENCLAW_LIVE_<PROVIDER>_KEY`（単一のオーバーライド）
  - `<PROVIDER>_API_KEYS`
  - `<PROVIDER>_API_KEY`
  - `<PROVIDER>_API_KEY_*`
- Googleプロバイダーは追加のフォールバックとして `GOOGLE_API_KEY` も含みます。
- 同一のキーリストは使用前に重複排除されます。
- OpenClawはレート制限エラー（例: `429`、`rate_limit`、`quota`、`resource exhausted`）の場合のみ次のキーで再試行します。
- レート制限以外のエラーは代替キーで再試行されません。
- すべてのキーが失敗した場合、最後の試行からの最終エラーが返されます。

## 使用する認証情報の制御

### セッション単位（チャットコマンド）

`/model <alias-or-id>@<profileId>` を使用して、現在のセッションに特定のプロバイダー認証情報を固定します（プロファイルIDの例: `anthropic:default`、`anthropic:work`）。

`/model`（または `/model list`）でコンパクトなピッカーを表示します。`/model status` で完全なビュー（候補 + 次の認証プロファイル、設定されている場合はプロバイダーエンドポイントの詳細も含む）を表示します。

### エージェント単位（CLIオーバーライド）

エージェントに対して明示的な認証プロファイルの順序オーバーライドを設定します（そのエージェントの `auth-profiles.json` に保存されます）:

```bash
openclaw models auth order get --provider anthropic
openclaw models auth order set --provider anthropic anthropic:default
openclaw models auth order clear --provider anthropic
```

`--agent <id>` で特定のエージェントを指定します。省略すると、設定されたデフォルトエージェントが使用されます。

## トラブルシューティング

### 「No credentials found」

Anthropicトークンプロファイルが見つからない場合は、**Gateway ゲートウェイホスト**で `claude setup-token` を実行し、再確認してください:

```bash
openclaw models status
```

### トークンの期限切れ/期限切れ間近

`openclaw models status` を実行して、どのプロファイルが期限切れ間近かを確認します。プロファイルが見つからない場合は、`claude setup-token` を再実行し、トークンを再度貼り付けてください。

## 要件

- Anthropicサブスクリプションアカウント（`claude setup-token` 用）
- Claude Code CLIがインストール済み（`claude` コマンドが利用可能）
