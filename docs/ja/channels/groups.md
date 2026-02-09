---
summary: "各サーフェス（WhatsApp / Telegram / Discord / Slack / Signal / iMessage / Microsoft Teams）におけるグループチャットの挙動"
read_when:
  - グループチャットの挙動やメンションゲーティングを変更する場合
title: "グループ"
---

# グループ

OpenClaw は、WhatsApp、Telegram、Discord、Slack、Signal、iMessage、Microsoft Teams といった各サーフェスにおいて、グループチャットを一貫した形で扱います。

## 初心者向けイントロ（2 分）

あなた自身のメッセージングアカウントでOpenClawの「ライブ」。 別のWhatsAppボットユーザーはありません。
**あなた**がグループにいる場合、OpenClawはそのグループを見ることができ、そこで応答します。

デフォルトの挙動：

- グループは制限されています（`groupPolicy: "allowlist"`）。
- 明示的にメンションゲーティングを無効化しない限り、返信にはメンションが必要です。

要するに：許可リストに登録された送信者が、OpenClaw にメンションすることでトリガーできます。

> TL;DR
>
> - **DM アクセス**は `*.allowFrom` により制御されます。
> - **グループアクセス**は `*.groupPolicy` と許可リスト（`*.groups`、`*.groupAllowFrom`）により制御されます。
> - **返信トリガー**はメンションゲーティング（`requireMention`、`/activation`）により制御されます。

クイックフロー（グループメッセージで何が起きるか）：

```
groupPolicy? disabled -> drop
groupPolicy? allowlist -> group allowed? no -> drop
requireMention? yes -> mentioned? no -> store for context only
otherwise -> reply
```

![グループメッセージのフロー](/images/groups-flow.svg)

ご希望の方は...

| 目的                                    | 設定するもの                                                    |
| ------------------------------------- | --------------------------------------------------------- |
| すべてのグループを許可し、@メンション時のみ返信 | `groups: { "*": { requireMention: true } }`               |
| すべてのグループ返信を無効化                        | `groupPolicy: "disabled"`                                 |
| 特定のグループのみ許可                           | `groups: { "<group-id>": { ... } }`（`"*"` キーなし）           |
| グループでトリガーできるのは自分のみ                    | `groupPolicy: "allowlist"`、`groupAllowFrom: ["+1555..."]` |

## セッションキー

- グループセッションは `agent:<agentId>:<channel>:group:<id>` セッションキーを使用します（ルーム / チャンネルは `agent:<agentId>:<channel>:channel:<id>` を使用）。
- Telegram のフォーラムトピックでは、グループ ID に `:topic:<threadId>` が追加され、各トピックが独立したセッションになります。
- ダイレクトチャットはメインセッション（または設定により送信者ごと）を使用します。
- グループセッションではハートビートはスキップされます。

## パターン：個人 DM + 公開グループ（単一エージェント）

はい。これは「個人的」なトラフィックが **DM**、「公開」トラフィックが **グループ**である場合に非常によく機能します。

理由：単一エージェントモードでは、DM は通常 **メイン** セッションキー（`agent:main:main`）に入り、グループは常に **非メイン** セッションキー（`agent:main:<channel>:group:<id>`）を使用します。`mode: "non-main"` でサンドボックス化を有効にすると、グループセッションは Docker 上で実行され、メインの DM セッションはホスト上に残ります。 `mode: "non-main"`でサンドボックス化を有効にした場合、メインDMセッションがホスト上にとどまりながら、Dockerで実行されます。

これにより、1 つのエージェントの「頭脳」（共有ワークスペース + メモリ）を保ちつつ、2 種類の実行形態を持てます。

- **DM**：フルツール（ホスト）
- **グループ**：サンドボックス + 制限付きツール（Docker）

> 「個人」と「公開」を完全に分離したワークスペース / ペルソナ（決して混在させない）が必要な場合は、2 つ目のエージェントとバインディングを使用してください。[マルチエージェントルーティング](/concepts/multi-agent) を参照してください。 [マルチエージェントルーティング](/concepts/multi-agent)を参照。

例（DM はホスト、グループはサンドボックス化 + メッセージング専用ツール）：

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main", // groups/channels are non-main -> sandboxed
        scope: "session", // strongest isolation (one container per group/channel)
        workspaceAccess: "none",
      },
    },
  },
  tools: {
    sandbox: {
      tools: {
        // If allow is non-empty, everything else is blocked (deny still wins).
        allow: ["group:messaging", "group:sessions"],
        deny: ["group:runtime", "group:fs", "group:ui", "nodes", "cron", "gateway"],
      },
    },
  },
}
```

「ホストへのアクセスなし」ではなく「グループからはフォルダ X のみ参照可能」にしたい場合は、`workspaceAccess: "none"` を維持し、許可リストにあるパスのみをサンドボックスにマウントしてください。 \`workspaceAccess: "none"を保持し、許可されているパスのみサンドボックスにマウントします。

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main",
        scope: "session",
        workspaceAccess: "none",
        docker: {
          binds: [
            // hostPath:containerPath:mode
            "~/FriendsShared:/data:ro",
          ],
        },
      },
    },
  },
}
```

関連事項:

- 設定キーとデフォルト値：[Gateway 設定](/gateway/configuration#agentsdefaultssandbox)
- ツールがブロックされる理由のデバッグ：[サンドボックス vs ツールポリシー vs 昇格](/gateway/sandbox-vs-tool-policy-vs-elevated)
- バインドマウントの詳細：[サンドボックス化](/gateway/sandboxing#custom-bind-mounts)

## 表示ラベル

- UI ラベルは、利用可能な場合 `displayName` を使用し、`<channel>:<token>` 形式で表示されます。
- `#room` はルーム / チャンネル用に予約されています。グループチャットは `g-<slug>` を使用します（小文字、スペースは `-` に変換し、`#@+._-` は維持します）。

## グループポリシー

チャンネルごとに、グループ / ルームメッセージの扱いを制御します。

```json5
{
  channels: {
    whatsapp: {
      groupPolicy: "disabled", // "open" | "disabled" | "allowlist"
      groupAllowFrom: ["+15551234567"],
    },
    telegram: {
      groupPolicy: "disabled",
      groupAllowFrom: ["123456789", "@username"],
    },
    signal: {
      groupPolicy: "disabled",
      groupAllowFrom: ["+15551234567"],
    },
    imessage: {
      groupPolicy: "disabled",
      groupAllowFrom: ["chat_id:123"],
    },
    msteams: {
      groupPolicy: "disabled",
      groupAllowFrom: ["user@org.com"],
    },
    discord: {
      groupPolicy: "allowlist",
      guilds: {
        GUILD_ID: { channels: { help: { allow: true } } },
      },
    },
    slack: {
      groupPolicy: "allowlist",
      channels: { "#general": { allow: true } },
    },
    matrix: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["@owner:example.org"],
      groups: {
        "!roomId:example.org": { allow: true },
        "#alias:example.org": { allow: true },
      },
    },
  },
}
```

| ポリシー          | 挙動                                      |
| ------------- | --------------------------------------- |
| `"open"`      | グループは許可リストをバイパスしますが、メンションゲーティングは適用されます。 |
| `"disabled"`  | すべてのグループメッセージを完全にブロックします。               |
| `"allowlist"` | 設定された許可リストに一致するグループ / ルームのみ許可します。       |

注記：

- `groupPolicy` はメンションゲーティング（@メンション必須）とは別物です。
- WhatsApp / Telegram / Signal / iMessage / Microsoft Teams：`groupAllowFrom` を使用します（フォールバック：明示的な `allowFrom`）。
- Discord：許可リストは `channels.discord.guilds.<id>.channels` を使用します。
- Slack：許可リストは `channels.slack.channels` を使用します。
- Matrix: allowlist は `channels.matrix.groups` (ルーム ID、エイリアス、または名前) を使用します。 Matrix：許可リストは `channels.matrix.groups`（ルーム ID、エイリアス、または名前）を使用します。送信者を制限するには `channels.matrix.groupAllowFrom` を使用してください。ルーム単位の `users` 許可リストもサポートされています。
- グループ DM は別途制御されます（`channels.discord.dm.*`、`channels.slack.dm.*`）。
- Telegram の許可リストは、ユーザー ID（`"123456789"`、`"telegram:123456789"`、`"tg:123456789"`）またはユーザー名（`"@alice"` または `"alice"`）に一致させられます。プレフィックスは大文字小文字を区別しません。
- デフォルトは `groupPolicy: "allowlist"` です。グループ許可リストが空の場合、グループメッセージはブロックされます。

簡易的なメンタルモデル（グループメッセージの評価順）：

1. `groupPolicy`（open / disabled / allowlist）
2. グループ許可リスト（`*.groups`、`*.groupAllowFrom`、チャンネル固有の許可リスト）
3. メンションゲーティング（`requireMention`、`/activation`）

## メンションゲーティング（デフォルト）

グループメッセージは、グループごとに上書きされない限り、メンションが必要です。デフォルト設定は `*.groups."*"` 配下の各サブシステムに存在します。 デフォルトは `*.groups."*"`のサブシステム毎に動作します。

ボットのメッセージに返信する行為は、暗黙のメンションとして扱われます（チャンネルが返信メタデータをサポートしている場合）。これは Telegram、WhatsApp、Slack、Discord、Microsoft Teams に適用されます。 Telegram、WhatsApp、Slack、Discord、Microsoft Teamsに適用されます。

```json5
{
  channels: {
    whatsapp: {
      groups: {
        "*": { requireMention: true },
        "123@g.us": { requireMention: false },
      },
    },
    telegram: {
      groups: {
        "*": { requireMention: true },
        "123456789": { requireMention: false },
      },
    },
    imessage: {
      groups: {
        "*": { requireMention: true },
        "123": { requireMention: false },
      },
    },
  },
  agents: {
    list: [
      {
        id: "main",
        groupChat: {
          mentionPatterns: ["@openclaw", "openclaw", "\\+15555550123"],
          historyLimit: 50,
        },
      },
    ],
  },
}
```

注記：

- `mentionPatterns` は大文字小文字を区別しない正規表現です。
- 明示的な言及を提供する表面は依然として通過します; パターンはフォールバックです。
- エージェント単位の上書き：`agents.list[].groupChat.mentionPatterns`（複数エージェントが同じグループを共有する場合に有用）。
- メンションゲーティングは、メンション検出が可能な場合（ネイティブメンション、または `mentionPatterns` が設定されている場合）にのみ適用されます。
- Discord のデフォルトは `channels.discord.guilds."*"` にあります（ギルド / チャンネル単位で上書き可能）。
- グループ履歴コンテキストはチャンネル間で均一にラップされ、**保留のみ** (gatingへの言及により飛ばされたメッセージ); `messagesを使用します。 グローバルデフォルトの roupChat.historyLimit` および `channel.<channel>.historyLimit`（または `channels.<channel>.accounts.*.historyLimit`）を使用します。無効化するには `0` を設定してください。 `0` を無効にします。

## グループ / チャンネルのツール制限（任意）

一部のチャンネル設定では、**特定のグループ / ルーム / チャンネル内**で利用可能なツールを制限できます。

- `tools`：グループ全体に対するツールの許可 / 拒否。
- `toolsBySender`：グループ内での送信者単位の上書き（キーはチャンネルに応じて送信者 ID / ユーザー名 / メール / 電話番号）。ワイルドカードには `"*"` を使用します。 ワイルドカードとして `"*"` を使用します。

解決順（最も具体的なものが優先）：

1. グループ / チャンネルの `toolsBySender` 一致
2. グループ / チャンネルの `tools`
3. デフォルト（`"*"`）の `toolsBySender` 一致
4. デフォルト（`"*"`）の `tools`

例（Telegram）：

```json5
{
  channels: {
    telegram: {
      groups: {
        "*": { tools: { deny: ["exec"] } },
        "-1001234567890": {
          tools: { deny: ["exec", "read", "write"] },
          toolsBySender: {
            "123456789": { alsoAllow: ["exec"] },
          },
        },
      },
    },
  },
}
```

注記：

- グループ / チャンネルのツール制限は、グローバル / エージェントのツールポリシーに追加で適用されます（拒否が常に優先）。
- 一部のチャンネルでは、ルーム / チャンネルのネスト構造が異なります（例：Discord `guilds.*.channels.*`、Slack `channels.*`、Microsoft Teams `teams.*.channels.*`）。

## グループ許可リスト

`channels.whatsapp.groups`、`channels.telegram.groups`、または `channels.imessage.groups` が設定されている場合、これらのキーはグループ許可リストとして機能します。すべてのグループを許可しつつ、デフォルトのメンション挙動を設定したい場合は `"*"` を使用してください。 デフォルトのメンション動作を設定しながら、すべてのグループを許可するには、`"*"` を使用します。

よくある意図（コピー & ペースト）：

1. すべてのグループ返信を無効化

```json5
{
  channels: { whatsapp: { groupPolicy: "disabled" } },
}
```

2. 特定のグループのみ許可（WhatsApp）

```json5
{
  channels: {
    whatsapp: {
      groups: {
        "123@g.us": { requireMention: true },
        "456@g.us": { requireMention: false },
      },
    },
  },
}
```

3. すべてのグループを許可し、メンション必須（明示）

```json5
{
  channels: {
    whatsapp: {
      groups: { "*": { requireMention: true } },
    },
  },
}
```

4. グループでトリガーできるのはオーナーのみ（WhatsApp）

```json5
{
  channels: {
    whatsapp: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15551234567"],
      groups: { "*": { requireMention: true } },
    },
  },
}
```

## アクティベーション（オーナーのみ）

グループオーナーは、グループ単位で有効 / 無効を切り替えられます。

- `/activation mention`
- `/activation always`

オーナーは `channels.whatsapp.allowFrom` により判定されます（未設定の場合はボット自身の E.164）。コマンドは単独のメッセージとして送信してください。他のサーフェスでは現在 `/activation` は無視されます。 このコマンドをスタンドアロンメッセージとして送信します。 他のサーフェスは現在 `/activation` を無視します。

## コンテキストフィールド

グループの受信ペイロードには以下が設定されます。

- `ChatType=group`
- `GroupSubject`（既知の場合）
- `GroupMembers`（既知の場合）
- `WasMentioned`（メンションゲーティングの結果）
- Telegram のフォーラムトピックでは、さらに `MessageThreadId` と `IsForum` が含まれます。

エージェント システムプロンプトには、新しいグループ セッションの最初のターンにグループのイントロが含まれます。 これは、モデルが人間のように反応するように思い出させ、Markdownテーブルを避け、リテラルを入力しないようにします。`\n`シーケンス。

## iMessage 固有の注意点

- ルーティングや許可リストでは `chat_id:<id>` を優先してください。
- チャット一覧：`imsg chats --limit 20`。
- グループ返信は常に同じ `chat_id` に返されます。

## WhatsApp 固有の注意点

WhatsApp 専用の挙動（履歴注入、メンション処理の詳細）については、[グループメッセージ](/channels/group-messages) を参照してください。
