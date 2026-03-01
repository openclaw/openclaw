---
summary: "`openclaw directory` のCLIリファレンス（self、peers、groups）"
read_when:
  - チャネルのコンタクト/グループ/自分のIDを検索したい場合
  - チャネルディレクトリアダプターを開発している場合
title: "directory"
---

# `openclaw directory`

サポートしているチャネルのディレクトリ検索（コンタクト/ピア、グループ、および「me」）を行います。

## 共通フラグ

- `--channel <name>`: チャネルID/エイリアス（複数のチャネルが設定されている場合は必須、1つのみの場合は自動選択）
- `--account <id>`: アカウントID（デフォルト：チャネルのデフォルト）
- `--json`: JSON出力

## 注意事項

- `directory` は、他のコマンド（特に `openclaw message send --target ...`）に貼り付けることができるIDを見つけるためのものです。
- 多くのチャネルでは、結果はライブプロバイダーディレクトリではなく、設定ベース（許可リスト/設定済みグループ）です。
- デフォルト出力はタブ区切りの `id`（場合によっては `name` も含む）です。スクリプティングには `--json` を使用してください。

## `message send` での結果の利用

```bash
openclaw directory peers list --channel slack --query "U0"
openclaw message send --channel slack --target user:U012ABCDEF --message "hello"
```

## IDフォーマット（チャネル別）

- WhatsApp: `+15551234567`（DM）、`1234567890-1234567890@g.us`（グループ）
- Telegram: `@username` または数値チャットID、グループは数値ID
- Slack: `user:U…` および `channel:C…`
- Discord: `user:<id>` および `channel:<id>`
- Matrix（プラグイン）: `user:@user:server`、`room:!roomId:server`、または `#alias:server`
- Microsoft Teams（プラグイン）: `user:<id>` および `conversation:<id>`
- Zalo（プラグイン）: ユーザーID（Bot API）
- Zalo Personal / `zalouser`（プラグイン）: `zca` からのスレッドID（DM/グループ）（`me`、`friend list`、`group list`）

## Self（「me」）

```bash
openclaw directory self --channel zalouser
```

## Peers（コンタクト/ユーザー）

```bash
openclaw directory peers list --channel zalouser
openclaw directory peers list --channel zalouser --query "name"
openclaw directory peers list --channel zalouser --limit 50
```

## グループ

```bash
openclaw directory groups list --channel zalouser
openclaw directory groups list --channel zalouser --query "work"
openclaw directory groups members --channel zalouser --group-id <id>
```
