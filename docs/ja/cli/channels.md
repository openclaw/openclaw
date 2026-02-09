---
summary: "CLI 参照：`openclaw channels`（アカウント、ステータス、ログイン／ログアウト、ログ）"
read_when:
  - WhatsApp／Telegram／Discord／Google Chat／Slack／Mattermost（プラグイン）／Signal／iMessage のチャンネルアカウントを追加／削除したい場合
  - チャンネルのステータスを確認したり、チャンネルログを追跡したい場合
title: "channels"
---

# `openclaw channels`

Gateway（ゲートウェイ）上で、チャットチャンネルのアカウントと実行時ステータスを管理します。

関連ドキュメント：

- チャンネルガイド：[Channels](/channels/index)
- Gateway 設定：[Configuration](/gateway/configuration)

## 共通コマンド

```bash
openclaw channels list
openclaw channels status
openclaw channels capabilities
openclaw channels capabilities --channel discord --target channel:123
openclaw channels resolve --channel slack "#general" "@jane"
openclaw channels logs --channel all
```

## アカウントの追加／削除

```bash
openclaw channels add --channel telegram --token <bot-token>
openclaw channels remove --channel telegram --delete
```

ヒント：`openclaw channels add --help` には、チャンネルごとのフラグ（トークン、アプリトークン、signal-cli のパスなど）が表示されます。

## ログイン／ログアウト（対話式）

```bash
openclaw channels login --channel whatsapp
openclaw channels logout --channel whatsapp
```

## トラブルシューティング

- 広範なプローブには `openclaw status --deep` を実行します。
- ガイド付きの修正には `openclaw doctor` を使用します。
- `openclaw channels list` は `Claude: HTTP 403 ... user:profile` → 使用スナップショットには `user:profile` スコープが必要です。 `--no-usage` を使用するか、claude.ai セッションキー (`CLAUDE_WEB_SESSION_KEY` / `CLAUDE_WEB_COOKIE` ) を指定するか、またはクロードコード CLI を使用して再認証します。

## 機能プローブ

利用可能なプロバイダーの機能ヒント（該当する場合は intents／scopes）と、静的な機能サポートを取得します。

```bash
openclaw channels capabilities
openclaw channels capabilities --channel discord --target channel:123
```

注記：

- `--channel` は任意です。省略すると、拡張を含むすべてのチャンネルが一覧表示されます。
- `--target` は `channel:<id>` または生の数値チャンネル ID を受け付け、Discord のみに適用されます。
- プローブはプロバイダー固有です：Discord の intents＋任意のチャンネル権限、Slack のボット＋ユーザースコープ、Telegram のボットフラグ＋ webhook、Signal のデーモンバージョン、MS Teams のアプリトークン＋ Graph のロール／スコープ（判明している場合は注記）。プローブを持たないチャンネルは `Probe: unavailable` を報告します。 プローブがないチャネルは `Probe: unavailable` を報告します。

## 名前を ID に解決

プロバイダーのディレクトリを使用して、チャンネル／ユーザー名を ID に解決します。

```bash
openclaw channels resolve --channel slack "#general" "@jane"
openclaw channels resolve --channel discord "My Server/#support" "@someone"
openclaw channels resolve --channel matrix "Project Room"
```

注記：

- 対象タイプを強制するには `--kind user|group|auto` を使用します。
- 同名のエントリが複数ある場合、解決はアクティブな一致を優先します。
