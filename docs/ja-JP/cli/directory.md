---
read_when:
    - チャネルの連絡先/グループ/自身のIDを調べたい場合
    - チャネルディレクトリアダプターを開発している場合
summary: '`openclaw directory` のCLIリファレンス（self、peers、groups）'
title: directory
x-i18n:
    generated_at: "2026-04-02T07:33:28Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 6a81a037e0a33f77c24b1adabbc4be16ed4d03c419873f3cbdd63f2ce84a1064
    source_path: cli/directory.md
    workflow: 15
---

# `openclaw directory`

サポートされているチャネルのディレクトリ検索（連絡先/ピア、グループ、「me」）。

## 共通フラグ

- `--channel <name>`：チャネルID/エイリアス（複数のチャネルが設定されている場合は必須、1つだけ設定されている場合は自動選択）
- `--account <id>`：アカウントID（デフォルト：チャネルのデフォルト）
- `--json`：JSON出力

## 注意事項

- `directory` は、他のコマンド（特に `openclaw message send --target ...`）に貼り付けるためのIDを見つけるのに役立ちます。
- 多くのチャネルでは、結果はライブプロバイダーディレクトリではなく、設定ベース（許可リスト/設定済みグループ）です。
- デフォルト出力は `id`（場合によっては `name`）がタブ区切りです。スクリプティングには `--json` を使用してください。

## `message send` での結果の使用

```bash
openclaw directory peers list --channel slack --query "U0"
openclaw message send --channel slack --target user:U012ABCDEF --message "hello"
```

## IDフォーマット（チャネル別）

- WhatsApp：`+15551234567`（ダイレクトメッセージ）、`1234567890-1234567890@g.us`（グループ）
- Telegram：`@username` または数値チャットID、グループは数値ID
- Slack：`user:U…` と `channel:C…`
- Discord：`user:<id>` と `channel:<id>`
- Matrix（プラグイン）：`user:@user:server`、`room:!roomId:server`、または `#alias:server`
- Microsoft Teams（プラグイン）：`user:<id>` と `conversation:<id>`
- Zalo（プラグイン）：ユーザーID（Bot API）
- Zalo Personal / `zalouser`（プラグイン）：`zca` からのスレッドID（ダイレクトメッセージ/グループ）（`me`、`friend list`、`group list`）

## Self（「me」）

```bash
openclaw directory self --channel zalouser
```

## Peers（連絡先/ユーザー）

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
