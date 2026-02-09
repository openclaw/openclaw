---
summary: "チャンネル（WhatsApp、Telegram、Discord、Slack）ごとのルーティングルールと共有コンテキスト"
read_when:
  - チャンネルルーティングや受信箱の挙動を変更する場合
title: "チャンネルルーティング"
---

# チャンネルとルーティング

OpenClaw は、**メッセージが届いた元のチャンネルへ返信**します。  
モデルがチャンネルを選択することはありません。ルーティングは決定論的で、ホストの設定によって制御されます。
モデルはチャンネルを選択しません。ルーティングは
ホスト構成によって決定的で制御されます。

## 主要な用語

- **チャンネル**: `whatsapp`、`telegram`、`discord`、`slack`、`signal`、`imessage`、`webchat`。
- **AccountId**: チャンネルごとのアカウントインスタンス（対応している場合）。
- **AgentId**: 分離されたワークスペース＋セッションストア（「brain」）。
- **SessionKey**: コンテキストの保存と並行制御に使用されるバケットキー。

## セッションキーの形（例）

ダイレクトメッセージは、エージェントの **メイン** セッションに集約されます。

- `agent:<agentId>:<mainKey>`（既定: `agent:main:main`）

グループやチャンネルは、チャンネルごとに分離されたままです。

- グループ: `agent:<agentId>:<channel>:group:<id>`
- チャンネル／ルーム: `agent:<agentId>:<channel>:channel:<id>`

スレッド:

- Slack／Discord のスレッドは、ベースキーに `:thread:<threadId>` を付加します。
- Telegram のフォーラムトピックは、グループキーに `:topic:<topicId>` を埋め込みます。

例:

- `agent:main:telegram:group:-1001234567890:topic:42`
- `agent:main:discord:channel:123456:thread:987654`

## ルーティングルール（エージェントの選択方法）

ルーティングは、受信メッセージごとに **1 つのエージェント** を選択します。

1. **完全一致のピア**（`bindings` と `peer.kind` + `peer.id`）。
2. **ギルド一致**（Discord）: `guildId` による。
3. **チーム一致**（Slack）: `teamId` による。
4. **アカウント一致**（チャンネル上の `accountId`）。
5. **チャンネル一致**（そのチャンネル上の任意のアカウント）。
6. **既定のエージェント**（`agents.list[].default`、それ以外はリストの先頭、最終的に `main` へフォールバック）。

一致したエージェントによって、使用されるワークスペースとセッションストアが決まります。

## ブロードキャストグループ（複数エージェントの実行）

ブロードキャストグループを使うと、**OpenClaw が通常は返信する場面**で、同一のピアに対して **複数のエージェント** を実行できます（例: WhatsApp のグループで、メンション／アクティベーションのゲーティング後）。

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

参照: [Broadcast Groups](/channels/broadcast-groups)。

## 設定の概要

- `agents.list`: 名前付きのエージェント定義（ワークスペース、モデルなど）。
- `bindings`: 受信チャンネル／アカウント／ピアをエージェントにマップします。

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

セッションストアは、状態ディレクトリ（既定は `~/.openclaw`）配下に配置されます。

- `~/.openclaw/agents/<agentId>/sessions/sessions.json`
- JSONL のトランスクリプトは、ストアと同じ場所に保存されます。

`session.store` と `{agentId}` のテンプレート化により、ストアのパスを上書きできます。

## WebChat の挙動

WebChat は **選択されたエージェント** に接続し、既定ではエージェントのメインセッションを使用します。  
このため、WebChat では、そのエージェントのクロスチャンネルなコンテキストを 1 か所で確認できます。 このため、WebChat を使用すると、
エージェントのクロスチャネルコンテキストが一箇所に表示されます。

## 返信コンテキスト

受信した返信には、次が含まれます。

- 利用可能な場合は、`ReplyToId`、`ReplyToBody`、`ReplyToSender`。
- 引用されたコンテキストは、`Body` に `[Replying to ...]` ブロックとして付加されます。

これは、すべてのチャンネルで一貫しています。
