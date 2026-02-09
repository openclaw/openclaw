---
summary: "「openclaw directory」（self、peers、groups）の CLI リファレンス"
read_when:
  - チャンネルの連絡先／グループ／self の ID を調べたいとき
  - チャンネルディレクトリアダプターを開発しているとき
title: "directory"
---

# `openclaw directory`

対応しているチャンネル向けのディレクトリ検索（連絡先／ピア、グループ、「me」）。

## Common flags

- `--channel <name>`: チャンネル ID／エイリアス（複数のチャンネルが設定されている場合は必須。1 つのみ設定されている場合は自動）
- `--account <id>`: アカウント ID（デフォルト：チャンネルのデフォルト）
- `--json`: JSON を出力

## Notes

- `directory` は、他のコマンド（特に `openclaw message send --target ...`）に貼り付けて使える ID を見つけるためのものです。
- 多くのチャンネルでは、結果はライブなプロバイダーディレクトリではなく、設定に基づくもの（許可リスト／設定済みグループ）です。
- デフォルトの出力は、タブ区切りの `id`（場合によっては `name`）です。スクリプト用途では `--json` を使用してください。

## Using results with `message send`

```bash
openclaw directory peers list --channel slack --query "U0"
openclaw message send --channel slack --target user:U012ABCDEF --message "hello"
```

## ID formats (by channel)

- WhatsApp: `+15551234567`（DM）、`1234567890-1234567890@g.us`（グループ）
- Telegram: `@username` または数値のチャット ID；グループは数値 ID
- Slack: `user:U…` および `channel:C…`
- Discord: `user:<id>` および `channel:<id>`
- Matrix（プラグイン）: `user:@user:server`、`room:!roomId:server`、または `#alias:server`
- Microsoft Teams（プラグイン）: `user:<id>` および `conversation:<id>`
- Zalo（プラグイン）: ユーザー ID（Bot API）
- Zalo Personal／`zalouser`（プラグイン）: `zca` から取得したスレッド ID（DM／グループ）（`me`、`friend list`、`group list`）

## Self（「me」）

```bash
openclaw directory self --channel zalouser
```

## Peers（連絡先／ユーザー）

```bash
openclaw directory peers list --channel zalouser
openclaw directory peers list --channel zalouser --query "name"
openclaw directory peers list --channel zalouser --limit 50
```

## Groups

```bash
openclaw directory groups list --channel zalouser
openclaw directory groups list --channel zalouser --query "work"
openclaw directory groups members --channel zalouser --group-id <id>
```
