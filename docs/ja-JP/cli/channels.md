---
summary: "`openclaw channels` のCLIリファレンス（アカウント、ステータス、ログイン/ログアウト、ログ）"
read_when:
  - チャネルアカウント（WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost（プラグイン）/Signal/iMessage）を追加/削除したい場合
  - チャネルのステータスを確認したり、チャネルログを追跡したい場合
title: "channels"
---

# `openclaw channels`

Gateway上のチャットチャネルアカウントとそのランタイムステータスを管理します。

関連ドキュメント：

- チャネルガイド：[Channels](/channels/index)
- Gateway設定：[Configuration](/gateway/configuration)

## 一般的なコマンド

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
openclaw channels remove --channel telegram --delete
```

ヒント：`openclaw channels add --help` でチャネルごとのフラグ（トークン、アプリトークン、signal-cliパスなど）を確認できます。

`openclaw channels add` をフラグなしで実行すると、対話型ウィザードが以下を問い合わせます：

- 選択したチャネルごとのアカウントID
- それらのアカウントのオプションの表示名
- `設定済みのチャネルアカウントを今すぐエージェントにバインドしますか？`

バインドを確認すると、ウィザードは各チャネルアカウントを所有するエージェントを尋ね、アカウントスコープのルーティングバインディングを書き込みます。

同じルーティングルールは後から `openclaw agents bindings`、`openclaw agents bind`、`openclaw agents unbind` でも管理できます（[agents](/cli/agents)を参照）。

シングルアカウントのトップレベル設定（`channels.<channel>.accounts` エントリなし）を使用しているチャネルにデフォルト以外のアカウントを追加すると、OpenClawはアカウントスコープのシングルアカウントトップレベル値を `channels.<channel>.accounts.default` に移動してから、新しいアカウントを書き込みます。これにより、マルチアカウント構造に移行しながら、元のアカウントの動作が保持されます。

ルーティングの動作は一貫しています：

- 既存のチャネルのみのバインディング（`accountId` なし）は、引き続きデフォルトアカウントに一致します。
- `channels add` は非対話モードでバインディングを自動作成したり書き換えたりしません。
- 対話型セットアップでは、オプションでアカウントスコープのバインディングを追加できます。

設定が混合状態だった場合（名前付きアカウントが存在し、`default` がなく、トップレベルのシングルアカウント値がまだ設定されている場合）、`openclaw doctor --fix` を実行してアカウントスコープ値を `accounts.default` に移動してください。

## ログイン/ログアウト（対話型）

```bash
openclaw channels login --channel whatsapp
openclaw channels logout --channel whatsapp
```

## トラブルシューティング

- 広範な診断には `openclaw status --deep` を実行してください。
- ガイド付きの修正には `openclaw doctor` を使用してください。
- `openclaw channels list` が `Claude: HTTP 403 ... user:profile` と表示する場合、使用量スナップショットに `user:profile` スコープが必要です。`--no-usage` を使用するか、claude.aiセッションキー（`CLAUDE_WEB_SESSION_KEY` / `CLAUDE_WEB_COOKIE`）を提供するか、Claude Code CLI経由で再認証してください。

## 機能プローブ

プロバイダーの機能ヒント（利用可能な場合のインテント/スコープ）と静的機能サポートを取得します：

```bash
openclaw channels capabilities
openclaw channels capabilities --channel discord --target channel:123
```

注意事項：

- `--channel` はオプションです。省略すると、拡張機能を含むすべてのチャネルが一覧表示されます。
- `--target` は `channel:<id>` または生の数値チャネルIDを受け付け、Discordにのみ適用されます。
- プローブはプロバイダー固有です：Discordインテント + オプションのチャネルパーミッション、Slackボット + ユーザースコープ、Telegramボットフラグ + Webhook、Signalデーモンバージョン、MS Teamsアプリトークン + Graphロール/スコープ（判明している場合に注釈付き）。プローブのないチャネルは `Probe: unavailable` と報告します。

## 名前からIDへの解決

プロバイダーディレクトリを使用して、チャネル/ユーザー名をIDに解決します：

```bash
openclaw channels resolve --channel slack "#general" "@jane"
openclaw channels resolve --channel discord "My Server/#support" "@someone"
openclaw channels resolve --channel matrix "Project Room"
```

注意事項：

- `--kind user|group|auto` でターゲットタイプを強制できます。
- 同じ名前を持つ複数のエントリがある場合、解決はアクティブな一致を優先します。
