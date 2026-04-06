---
read_when:
    - チャネルルーティングや受信トレイの動作を変更する場合
summary: チャネルごとのルーティングルール（WhatsApp、Telegram、Discord、Slack）と共有コンテキスト
title: チャネルルーティング
x-i18n:
    generated_at: "2026-04-02T08:24:52Z"
    model: claude-opus-4-6
    provider: anthropic
    source_hash: 63916c4dd0af5fc9bbd12581a9eb15fea14a380c5ade09323ca0c237db61e537
    source_path: channels/channel-routing.md
    workflow: 15
---

# チャネルとルーティング

OpenClawは返信を**メッセージが送られてきたチャネルに返送**します。モデルはチャネルを選択しません。ルーティングは決定論的であり、ホスト設定によって制御されます。

## 主要な用語

- **チャネル**: `telegram`、`whatsapp`、`discord`、`irc`、`googlechat`、`slack`、`signal`、`imessage`、`line`、および拡張チャネル。`webchat`は内部のWebChat UIチャネルであり、設定可能なアウトバウンドチャネルではありません。
- **AccountId**: チャネルごとのアカウントインスタンス（サポートされている場合）。
- オプションのチャネルデフォルトアカウント: `channels.<channel>.defaultAccount`は、アウトバウンドパスが`accountId`を指定していない場合に使用されるアカウントを選択します。
  - マルチアカウント構成では、2つ以上のアカウントが設定されている場合、明示的なデフォルト（`defaultAccount`または`accounts.default`）を設定してください。設定しない場合、フォールバックルーティングが最初に正規化されたアカウントIDを選択する可能性があります。
- **AgentId**: 隔離されたワークスペース＋セッションストア（「ブレイン」）。
- **SessionKey**: コンテキストの保存と同時実行の制御に使用されるバケットキー。

## セッションキーの形状（例）

ダイレクトメッセージはエージェントの**メイン**セッションに集約されます:

- `agent:<agentId>:<mainKey>`（デフォルト: `agent:main:main`）

グループとチャネルはチャネルごとに隔離されます:

- グループ: `agent:<agentId>:<channel>:group:<id>`
- チャネル/ルーム: `agent:<agentId>:<channel>:channel:<id>`

スレッド:

- Slack/Discordスレッドはベースキーに`:thread:<threadId>`を追加します。
- Telegramフォーラムトピックはグループキーに`:topic:<topicId>`を埋め込みます。

例:

- `agent:main:telegram:group:-1001234567890:topic:42`
- `agent:main:discord:channel:123456:thread:987654`

## メインダイレクトメッセージルートのピン留め

`session.dmScope`が`main`の場合、ダイレクトメッセージは1つのメインセッションを共有できます。セッションの`lastRoute`が所有者以外のダイレクトメッセージによって上書きされるのを防ぐため、以下のすべてが真の場合、OpenClawは`allowFrom`からピン留めされた所有者を推定します:

- `allowFrom`にワイルドカードでないエントリが正確に1つある。
- そのエントリがそのチャネルの具体的な送信者IDに正規化できる。
- 受信ダイレクトメッセージの送信者がそのピン留めされた所有者と一致しない。

不一致の場合、OpenClawは受信セッションメタデータを記録しますが、メインセッションの`lastRoute`の更新はスキップします。

## ルーティングルール（エージェントの選択方法）

ルーティングは受信メッセージごとに**1つのエージェント**を選択します:

1. **正確なピア一致**（`peer.kind` + `peer.id`を持つ`bindings`）。
2. **親ピア一致**（スレッド継承）。
3. **ギルド＋ロール一致**（Discord）`guildId` + `roles`経由。
4. **ギルド一致**（Discord）`guildId`経由。
5. **チーム一致**（Slack）`teamId`経由。
6. **アカウント一致**（チャネル上の`accountId`）。
7. **チャネル一致**（そのチャネル上の任意のアカウント、`accountId: "*"`）。
8. **デフォルトエージェント**（`agents.list[].default`、なければ最初のリストエントリ、フォールバックは`main`）。

バインディングに複数の一致フィールド（`peer`、`guildId`、`teamId`、`roles`）が含まれる場合、そのバインディングが適用されるには**提供されたすべてのフィールドが一致する必要があります**。

一致したエージェントによって、使用されるワークスペースとセッションストアが決定されます。

## ブロードキャストグループ（複数エージェントの実行）

ブロードキャストグループを使用すると、**OpenClawが通常返信する場合**に、同じピアに対して**複数のエージェント**を実行できます（例: WhatsAppグループで、メンション/アクティベーションゲーティングの後）。

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
- `bindings`: 受信チャネル/アカウント/ピアをエージェントにマッピング。

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

セッションストアはステートディレクトリ（デフォルト`~/.openclaw`）配下に存在します:

- `~/.openclaw/agents/<agentId>/sessions/sessions.json`
- JSONLトランスクリプトはストアと同じ場所に保存されます

`session.store`と`{agentId}`テンプレートを使用してストアパスをオーバーライドできます。

Gateway ゲートウェイとACPのセッションディスカバリーは、デフォルトの`agents/`ルート配下およびテンプレート化された`session.store`ルート配下のディスクバックエージェントストアもスキャンします。検出されたストアは、解決されたエージェントルート内に存在し、通常の`sessions.json`ファイルを使用する必要があります。シンボリックリンクやルート外のパスは無視されます。

## WebChatの動作

WebChatは**選択されたエージェント**にアタッチされ、デフォルトではエージェントのメインセッションを使用します。このため、WebChatではそのエージェントのクロスチャネルコンテキストを1か所で確認できます。

## 返信コンテキスト

受信返信には以下が含まれます:

- 利用可能な場合、`ReplyToId`、`ReplyToBody`、および`ReplyToSender`。
- 引用コンテキストは`[Replying to ...]`ブロックとして`Body`に追加されます。

これはすべてのチャネルで一貫しています。
