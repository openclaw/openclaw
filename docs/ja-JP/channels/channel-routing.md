---
summary: "チャンネルごと（WhatsApp、Telegram、Discord、Slack）のルーティングルールと共有コンテキスト"
read_when:
  - チャンネルルーティングやインボックスの動作を変更するとき
title: "チャンネルルーティング"
---

# チャンネルとルーティング

OpenClawは**メッセージが送られてきたチャンネルに返信をルーティング**します。
モデルがチャンネルを選ぶことはありません。ルーティングは決定論的であり、ホスト設定によって制御されます。

## 主要な用語

- **チャンネル**: `whatsapp`、`telegram`、`discord`、`slack`、`signal`、`imessage`、`webchat`。
- **AccountId**: チャンネルごとのアカウントインスタンス（サポートされている場合）。
- **AgentId**: 分離されたワークスペース + セッションストア（「頭脳」）。
- **SessionKey**: コンテキストの保存と同時実行制御に使用されるバケットキー。

## セッションキーの形式（例）

ダイレクトメッセージはエージェントの**メイン**セッションに集約されます:

- `agent:<agentId>:<mainKey>`（デフォルト: `agent:main:main`）

グループとチャンネルはチャンネルごとに分離されます:

- グループ: `agent:<agentId>:<channel>:group:<id>`
- チャンネル/ルーム: `agent:<agentId>:<channel>:channel:<id>`

スレッド:

- Slack/Discordのスレッドはベースキーに`:thread:<threadId>`を追加します。
- Telegramフォーラムトピックはグループキーに`:topic:<topicId>`を埋め込みます。

例:

- `agent:main:telegram:group:-1001234567890:topic:42`
- `agent:main:discord:channel:123456:thread:987654`

## ルーティングルール（エージェントの選択方法）

ルーティングは各受信メッセージに対して**1つのエージェント**を選択します:

1. **完全一致ピアマッチ**（`bindings`の`peer.kind` + `peer.id`）。
2. **親ピアマッチ**（スレッド継承）。
3. **ギルド + ロールマッチ**（Discord）`guildId` + `roles`による。
4. **ギルドマッチ**（Discord）`guildId`による。
5. **チームマッチ**（Slack）`teamId`による。
6. **アカウントマッチ**（チャンネルの`accountId`）。
7. **チャンネルマッチ**（そのチャンネルの任意のアカウント、`accountId: "*"`）。
8. **デフォルトエージェント**（`agents.list[].default`、なければ最初のリストエントリ、フォールバックは`main`）。

バインディングに複数のマッチフィールド（`peer`、`guildId`、`teamId`、`roles`）が含まれる場合、**提供されたすべてのフィールドが一致する必要があります**。

一致したエージェントが、使用されるワークスペースとセッションストアを決定します。

## ブロードキャストグループ（複数エージェントの実行）

ブロードキャストグループを使用すると、**OpenClawが通常返信する場合**に同じピアに対して**複数のエージェント**を実行できます（例: WhatsAppグループでのメンション/アクティベーションゲーティング後）。

設定:

```json5
{
  broadcast: {
    strategy: "parallel",
    "120363403215116621@g.us": ["alfred", "baerbel"],
    "+15555550123": ["support", "logger"],
  },
}
```

参照: [ブロードキャストグループ](/channels/broadcast-groups)。

## 設定の概要

- `agents.list`: 名前付きエージェント定義（ワークスペース、モデルなど）。
- `bindings`: 受信チャンネル/アカウント/ピアをエージェントにマッピング。

例:

```json5
{
  agents: {
    list: [{ id: "support", name: "Support", workspace: "~/.openclaw/workspace-support" }],
  },
  bindings: [
    { match: { channel: "slack", teamId: "T123" }, agentId: "support" },
    { match: { channel: "telegram", peer: { kind: "group", id: "-100123" } }, agentId: "support" },
  ],
}
```

## セッションストレージ

セッションストアは状態ディレクトリ（デフォルト`~/.openclaw`）の下に配置されます:

- `~/.openclaw/agents/<agentId>/sessions/sessions.json`
- JSONLトランスクリプトはストアの隣に配置されます

`session.store`と`{agentId}`テンプレートを使用してストアパスをオーバーライドできます。

## WebChatの動作

WebChatは**選択されたエージェント**にアタッチされ、デフォルトでエージェントのメインセッションを使用します。
これにより、WebChatでそのエージェントのクロスチャンネルコンテキストを一か所で確認できます。

## 返信コンテキスト

受信返信には以下が含まれます:

- 利用可能な場合、`ReplyToId`、`ReplyToBody`、`ReplyToSender`。
- 引用コンテキストは`Body`に`[Replying to ...]`ブロックとして追加されます。

これはチャンネル間で統一されています。
