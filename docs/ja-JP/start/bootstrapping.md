---
read_when:
    - エージェントの初回実行時に何が起こるかを理解する場合
    - ブートストラップファイルの保存場所を説明する場合
    - オンボーディングのアイデンティティセットアップをデバッグする場合
sidebarTitle: Bootstrapping
summary: ワークスペースとアイデンティティファイルを初期化するエージェントブートストラップの手順
title: エージェントブートストラップ
x-i18n:
    generated_at: "2026-04-02T07:54:17Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 4a08b5102f25c6c4bcdbbdd44384252a9e537b245a7b070c4961a72b4c6c6601
    source_path: start/bootstrapping.md
    workflow: 15
---

# エージェントブートストラップ

ブートストラップは、エージェントのワークスペースを準備し、アイデンティティの詳細を収集する**初回実行時**の手順です。オンボーディング後、エージェントが初めて起動する際に実行されます。

## ブートストラップの内容

エージェントの初回実行時、OpenClaw はワークスペース（デフォルトは `~/.openclaw/workspace`）をブートストラップします:

- `AGENTS.md`、`BOOTSTRAP.md`、`IDENTITY.md`、`USER.md` を初期配置します。
- 短い Q&A の手順（一度に1つの質問）を実行します。
- アイデンティティと設定内容を `IDENTITY.md`、`USER.md`、`SOUL.md` に書き込みます。
- 完了後に `BOOTSTRAP.md` を削除し、一度だけ実行されるようにします。

## 実行される場所

ブートストラップは常に **Gateway ゲートウェイホスト**上で実行されます。macOS アプリがリモートの Gateway ゲートウェイに接続している場合、ワークスペースとブートストラップファイルはそのリモートマシン上に保存されます。

<Note>
Gateway ゲートウェイが別のマシンで実行されている場合は、Gateway ゲートウェイホスト上でワークスペースファイルを編集してください（例: `user@gateway-host:~/.openclaw/workspace`）。
</Note>

## 関連ドキュメント

- macOS アプリのオンボーディング: [オンボーディング](/start/onboarding)
- ワークスペースレイアウト: [エージェントワークスペース](/concepts/agent-workspace)
