---
summary: "ワークスペースとアイデンティティファイルを初期化するためのエージェントのブートストラップ儀式"
read_when:
  - 最初のエージェント実行時に何が起こるかを理解する場合
  - ブートストラップファイルの配置場所を説明する場合
  - オンボーディング時のアイデンティティ設定をデバッグする場合
title: "エージェントのブートストラップ"
sidebarTitle: "Bootstrapping"
x-i18n:
  source_path: start/bootstrapping.md
  source_hash: 4a08b5102f25c6c4
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:23:10Z
---

# エージェントのブートストラップ

ブートストラップは、エージェントのワークスペースを準備し、アイデンティティの詳細を収集する **初回実行** の儀式です。オンボーディング後、エージェントが最初に起動したときに実行されます。

## ブートストラップで行われること

最初のエージェント実行時に、OpenClaw はワークスペース（デフォルト
`~/.openclaw/workspace`）をブートストラップします。

- `AGENTS.md`、`BOOTSTRAP.md`、`IDENTITY.md`、`USER.md` を作成します。
- 短い Q&A の儀式を実行します（質問は 1 問ずつ）。
- アイデンティティと設定を `IDENTITY.md`、`USER.md`、`SOUL.md` に書き込みます。
- 完了時に `BOOTSTRAP.md` を削除し、1 回のみ実行されるようにします。

## 実行場所

ブートストラップは常に **ゲートウェイ ホスト** 上で実行されます。macOS アプリが
リモートの Gateway（ゲートウェイ）に接続している場合、ワークスペースおよびブートストラップファイルはそのリモートマシン上に存在します。

<Note>
Gateway（ゲートウェイ）が別のマシンで実行されている場合は、ゲートウェイ ホスト上でワークスペースファイルを編集してください（例：`user@gateway-host:~/.openclaw/workspace`）。
</Note>

## 関連ドキュメント

- macOS アプリのオンボーディング: [Onboarding](/start/onboarding)
- ワークスペース構成: [Agent workspace](/concepts/agent-workspace)
