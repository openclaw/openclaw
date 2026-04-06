---
read_when:
    - チャネルアカウントを追加/削除したい（WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost（プラグイン）/Signal/iMessage/Matrix）
    - チャネルのステータスを確認したい、またはチャネルログをテールしたい
summary: '`openclaw channels`（アカウント、ステータス、ログイン/ログアウト、ログ）のCLIリファレンス'
title: channels
x-i18n:
    generated_at: "2026-04-02T07:32:59Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 770f89a11ee92fe9569e9b129a19890b713bc0fd46e7c1f23badd25a3cbf7887
    source_path: cli/channels.md
    workflow: 15
---

# `openclaw channels`

Gateway ゲートウェイ上のチャットチャネルアカウントとそのランタイムステータスを管理します。

関連ドキュメント:

- チャネルガイド: [チャネル](/channels/index)
- Gateway ゲートウェイ設定: [設定](/gateway/configuration)

## よく使うコマンド

```bash
openclaw channels list
openclaw channels status
openclaw channels capabilities
openclaw channels capabilities --channel discord --target channel:123
openclaw channels resolve --channel slack "#general" "@jane"
openclaw channels logs --channel all
```

## アカウントの追加/削除

```bash
openclaw channels add --channel telegram --token <bot-token>
openclaw channels add --channel nostr --private-key "$NOSTR_PRIVATE_KEY"
openclaw channels remove --channel telegram --delete
```

ヒント: `openclaw channels add --help`でチャネルごとのフラグ（トークン、秘密鍵、アプリトークン、signal-cliパスなど）を確認できます。

`openclaw channels add`をフラグなしで実行すると、対話型ウィザードが以下を入力を求めます:

- 選択したチャネルごとのアカウントID
- それらのアカウントのオプションの表示名
- 「設定済みのチャネルアカウントを今すぐエージェントにバインドしますか？」

今すぐバインドを確認すると、ウィザードは各設定済みチャネルアカウントを所有するエージェントを尋ね、アカウントスコープのルーティングバインディングを書き込みます。

同じルーティングルールは後から`openclaw agents bindings`、`openclaw agents bind`、`openclaw agents unbind`でも管理できます（[agents](/cli/agents)を参照）。

まだシングルアカウントのトップレベル設定（`channels.<channel>.accounts`エントリなし）を使用しているチャネルにデフォルト以外のアカウントを追加すると、OpenClawはアカウントスコープのシングルアカウントのトップレベル値を`channels.<channel>.accounts.default`に移動してから、新しいアカウントを書き込みます。これにより、マルチアカウント構造に移行しながら元のアカウントの動作が維持されます。

ルーティングの動作は一貫しています:

- 既存のチャネルのみのバインディング（`accountId`なし）は引き続きデフォルトアカウントにマッチします。
- `channels add`は非対話モードではバインディングを自動作成または書き換えしません。
- 対話型セットアップではオプションでアカウントスコープのバインディングを追加できます。

設定が混在した状態（名前付きアカウントが存在し、`default`が欠落し、トップレベルのシングルアカウント値がまだ設定されている）の場合は、`openclaw doctor --fix`を実行してアカウントスコープの値を`accounts.default`に移動してください。

## ログイン/ログアウト（対話型）

```bash
openclaw channels login --channel whatsapp
openclaw channels logout --channel whatsapp
```

## トラブルシューティング

- `openclaw status --deep`を実行して広範なプローブを行います。
- `openclaw doctor`を使用してガイド付き修正を行います。
- `openclaw channels list`が`Claude: HTTP 403 ... user:profile`と表示される → 使用量スナップショットに`user:profile`スコープが必要です。`--no-usage`を使用するか、claude.aiセッションキー（`CLAUDE_WEB_SESSION_KEY` / `CLAUDE_WEB_COOKIE`）を提供するか、Claude Code CLIで再認証してください。
- `openclaw channels status`はGateway ゲートウェイに接続できない場合、設定のみのサマリーにフォールバックします。サポート対象チャネルの認証情報がSecretRef経由で設定されているが現在のコマンドパスで利用できない場合、そのアカウントは未設定ではなく劣化ノート付きの設定済みとして報告されます。

## 機能プローブ

プロバイダーの機能ヒント（利用可能な場合はインテント/スコープ）と静的機能サポートを取得します:

```bash
openclaw channels capabilities
openclaw channels capabilities --channel discord --target channel:123
```

注意事項:

- `--channel`はオプションです。省略するとすべてのチャネル（拡張機能を含む）が一覧表示されます。
- `--target`は`channel:<id>`または生の数値チャネルIDを受け付け、Discordにのみ適用されます。
- プローブはプロバイダー固有です: Discordインテント＋オプションのチャネル権限、Slackボット＋ユーザースコープ、Telegramボットフラグ＋Webhook、Signalデーモンバージョン、Microsoft Teamsアプリトークン＋Graphロール/スコープ（既知の場合は注釈付き）。プローブのないチャネルは`Probe: unavailable`と報告されます。

## 名前からIDへの解決

プロバイダーディレクトリを使用してチャネル/ユーザー名をIDに解決します:

```bash
openclaw channels resolve --channel slack "#general" "@jane"
openclaw channels resolve --channel discord "My Server/#support" "@someone"
openclaw channels resolve --channel matrix "Project Room"
```

注意事項:

- `--kind user|group|auto`でターゲットタイプを強制できます。
- 解決は同じ名前を共有する複数のエントリがある場合、アクティブなマッチを優先します。
- `channels resolve`は読み取り専用です。選択されたアカウントがSecretRef経由で設定されているが、現在のコマンドパスでその認証情報が利用できない場合、コマンドは実行全体を中断せずに、ノート付きの劣化した未解決結果を返します。
