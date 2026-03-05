---
summary: "ワークスペースとアイデンティティファイルを初期化するエージェントブートストラップの手順"
read_when:
  - エージェントの初回実行時に何が起こるかを理解したい
  - ブートストラップファイルの保存場所を知りたい
  - オンボーディングのアイデンティティ設定をデバッグしたい
title: "Agent Bootstrapping"
sidebarTitle: "Bootstrapping"
x-i18n:
  source_path: "docs/start/bootstrapping.md"
  generated_at: "2026-03-05T10:01:00Z"
  model: "claude-opus-4-6"
  provider: "pi"
---

# エージェントブートストラップ

ブートストラップは、エージェントのワークスペースを準備し、アイデンティティの詳細を収集する**初回実行**の儀式です。オンボーディング後、エージェントが初めて起動する際に実行されます。

## ブートストラップの処理内容

エージェントの初回実行時に、OpenClawはワークスペース（デフォルトは`~/.openclaw/workspace`）をブートストラップします：

- `AGENTS.md`、`BOOTSTRAP.md`、`IDENTITY.md`、`USER.md`を初期配置します。
- 短いQ&Aの儀式を実行します（一度に1つの質問）。
- アイデンティティと設定を`IDENTITY.md`、`USER.md`、`SOUL.md`に書き込みます。
- 完了後、`BOOTSTRAP.md`を削除して一度だけ実行されるようにします。

## 実行場所

ブートストラップは常に**ゲートウェイホスト**上で実行されます。macOSアプリがリモートのゲートウェイに接続する場合、ワークスペースとブートストラップファイルはそのリモートマシン上に存在します。

<Note>
ゲートウェイが別のマシンで実行されている場合は、ゲートウェイホスト上でワークスペースファイルを編集してください（例：`user@gateway-host:~/.openclaw/workspace`）。
</Note>

## 関連ドキュメント

- macOSアプリのオンボーディング：[オンボーディング](/start/onboarding)
- ワークスペースのレイアウト：[エージェントワークスペース](/concepts/agent-workspace)
