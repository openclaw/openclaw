---
read_when:
    - 利用可能で実行準備が整っている Skills を確認したい場合
    - ClawHub から Skills を検索、インストール、または更新したい場合
    - Skills のバイナリ/環境/設定の不足をデバッグしたい場合
summary: '`openclaw skills`（検索/インストール/更新/一覧/情報/チェック）の CLI リファレンス'
title: skills
x-i18n:
    generated_at: "2026-04-02T07:35:50Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 480e1bc1e5e9e7241f74adeaa90bd227e63893bb85709a3f43d3a4c243f1e295
    source_path: cli/skills.md
    workflow: 15
---

# `openclaw skills`

ローカルの Skills を確認し、ClawHub から Skills をインストール/更新します。

関連:

- Skills システム: [Skills](/tools/skills)
- Skills 設定: [Skills 設定](/tools/skills-config)
- ClawHub インストール: [ClawHub](/tools/clawhub)

## コマンド

```bash
openclaw skills search "calendar"
openclaw skills install <slug>
openclaw skills install <slug> --version <version>
openclaw skills update <slug>
openclaw skills update --all
openclaw skills list
openclaw skills list --eligible
openclaw skills info <name>
openclaw skills check
```

`search`/`install`/`update` は ClawHub を直接使用し、アクティブなワークスペースの `skills/` ディレクトリにインストールします。`list`/`info`/`check` は、現在のワークスペースと設定から参照可能なローカルの Skills を確認します。

この CLI の `install` コマンドは ClawHub から Skills フォルダをダウンロードします。オンボーディングや Skills 設定から実行される Gateway ベースの Skills 依存関係のインストールは、別の `skills.install` リクエストパスを使用します。
