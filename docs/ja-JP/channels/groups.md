---
summary: "各メッセージングサービス（WhatsApp/Telegram/Discord/Slack/Signal/iMessage/Microsoft Teams/Zalo）でのグループチャット動作"
read_when:
  - グループチャットの動作やメンションゲーティングを変更するとき
title: "グループ"
---

# グループ

OpenClawは各メッセージングサービスでグループチャットを一貫して扱います: WhatsApp、Telegram、Discord、Slack、Signal、iMessage、Microsoft Teams、Zalo。

## 初心者向け紹介（2分）

OpenClawはあなた自身のメッセージングアカウント上で「生活」しています。別のWhatsAppボットユーザーは存在しません。
**あなた**がグループにいる場合、OpenClawはそのグループを見て応答できます。

デフォルトの動作:

- グループは制限されています（`groupPolicy: "allowlist"`）。
- 返信にはメンションが必要です（メンションゲーティングを明示的に無効にしない限り）。

つまり: 許可リストに登録された送信者がメンションすることでOpenClawをトリガーできます。

> TL;DR
>
> - **DMアクセス**は`*.allowFrom`で制御されます。
> - **グループアクセス**は`*.groupPolicy` + 許可リスト（`*.groups`、`*.groupAllowFrom`）で制御されます。
> - **返信トリガー**はメンションゲーティング（`requireMention`、`/activation`）で制御されます。

クイックフロー（グループメッセージに何が起こるか）:

```
groupPolicy? disabled -> ドロップ
groupPolicy? allowlist -> グループが許可されている? no -> ドロップ
requireMention? yes -> メンションされた? no -> コンテキストとしてのみ保存
otherwise -> 返信
```

![グループメッセージフロー](/images/groups-flow.svg)

目的に応じた設定...

| 目的                                             | 設定内容                                                   |
| ------------------------------------------------ | ---------------------------------------------------------- |
| すべてのグループを許可するが@メンション時のみ返信 | `groups: { "*": { requireMention: true } }`                |
| すべてのグループ返信を無効化                       | `groupPolicy: "disabled"`                                  |
| 特定のグループのみ                                 | `groups: { "<group-id>": { ... } }`（`"*"`キーなし）        |
| グループでは自分だけがトリガーできる               | `groupPolicy: "allowlist"`, `groupAllowFrom: ["+1555..."]` |

## セッションキー

- グループセッションは`agent:<agentId>:<channel>:group:<id>`のセッションキーを使用します（ルーム/チャンネルは`agent:<agentId>:<channel>:channel:<id>`を使用）。
- TelegramフォーラムトピックはグループIDに`:topic:<threadId>`を追加し、各トピックが独自のセッションを持ちます。
- ダイレクトチャットはメインセッション（または設定されている場合は送信者ごと）を使用します。
- グループセッションではハートビートはスキップされます。

## パターン: 個人DM + パブリックグループ（シングルエージェント）

はい、「個人」トラフィックが**DM**で「パブリック」トラフィックが**グループ**の場合にうまく機能します。

理由: シングルエージェントモードでは、DMは通常**メイン**セッションキー（`agent:main:main`）に到達し、グループは常に**非メイン**セッションキー（`agent:main:<channel>:group:<id>`）を使用します。`mode: "non-main"`でサンドボックスを有効にすると、グループセッションはDockerで実行され、メインDMセッションはホスト上に残ります。

これにより1つのエージェント「ブレイン」（共有ワークスペース + メモリ）を持ちつつ、2つの実行ポスチャーが得られます:

- **DM**: フルツール（ホスト）
- **グループ**: サンドボックス + 制限されたツール（Docker）

> 真に別のワークスペース/ペルソナが必要な場合（「個人」と「パブリック」が決して混ざらないように）、2番目のエージェント + バインディングを使用してください。[マルチエージェントルーティング](/concepts/multi-agent)を参照してください。

例（DMはホスト上、グループはサンドボックス + メッセージング専用ツール）:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main", // グループ/チャンネルは非メイン -> サンドボックス
        scope: "session", // 最強の分離（グループ/チャンネルごとに1コンテナ）
        workspaceAccess: "none",
      },
    },
  },
  tools: {
    sandbox: {
      tools: {
        // allowが空でない場合、他はすべてブロック（denyが優先）。
        allow: ["group:messaging", "group:sessions"],
        deny: ["group:runtime", "group:fs", "group:ui", "nodes", "cron", "gateway"],
      },
    },
  },
}
```

「グループにはフォルダXのみ見せたい」場合は「ホストアクセスなし」の代わりに、`workspaceAccess: "none"`を維持し、許可されたパスのみをサンドボックスにマウントします:

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
            "/home/user/FriendsShared:/data:ro",
          ],
        },
      },
    },
  },
}
```

関連:

- 設定キーとデフォルト: [Gateway設定](/gateway/configuration#agentsdefaultssandbox)
- ツールがブロックされる理由のデバッグ: [サンドボックス vs ツールポリシー vs 昇格](/gateway/sandbox-vs-tool-policy-vs-elevated)
- バインドマウントの詳細: [サンドボックス](/gateway/sandboxing#custom-bind-mounts)

## 表示ラベル

- UIラベルは利用可能な場合`displayName`を使用し、`<channel>:<token>`としてフォーマットされます。
- `#room`はルーム/チャンネル用に予約されています。グループチャットは`g-<slug>`を使用します（小文字、スペース -> `-`、`#@+._-`は保持）。

## グループポリシー

チャンネルごとにグループ/ルームメッセージの処理方法を制御します:

```json5
{
  channels: {
    whatsapp: {
      groupPolicy: "disabled", // "open" | "disabled" | "allowlist"
      groupAllowFrom: ["+15551234567"],
    },
    telegram: {
      groupPolicy: "disabled",
      groupAllowFrom: ["123456789"], // 数値のTelegramユーザーID（ウィザードは@usernameを解決可能）
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

| ポリシー        | 動作                                                         |
| --------------- | ------------------------------------------------------------ |
| `"open"`        | グループは許可リストをバイパスします。メンションゲーティングは引き続き適用されます。 |
| `"disabled"`    | すべてのグループメッセージを完全にブロックします。           |
| `"allowlist"`   | 設定された許可リストに一致するグループ/ルームのみを許可します。 |

注意:

- `groupPolicy`はメンションゲーティング（@メンションを必要とする）とは別です。
- WhatsApp/Telegram/Signal/iMessage/Microsoft Teams/Zalo: `groupAllowFrom`を使用します（フォールバック: 明示的な`allowFrom`）。
- DMペアリング承認（`*-allowFrom`ストアエントリ）はDMアクセスにのみ適用されます。グループ送信者の認可はグループ許可リストで明示的に行います。
- Discord: 許可リストは`channels.discord.guilds.<id>.channels`を使用します。
- Slack: 許可リストは`channels.slack.channels`を使用します。
- Matrix: 許可リストは`channels.matrix.groups`（ルームID、エイリアス、または名前）を使用します。`channels.matrix.groupAllowFrom`で送信者を制限します。ルームごとの`users`許可リストもサポートされています。
- グループDMは別途制御されます（`channels.discord.dm.*`、`channels.slack.dm.*`）。
- Telegramの許可リストはユーザーID（`"123456789"`、`"telegram:123456789"`、`"tg:123456789"`）またはユーザー名（`"@alice"`または`"alice"`）にマッチします。プレフィックスは大文字小文字を区別しません。
- デフォルトは`groupPolicy: "allowlist"`です。グループ許可リストが空の場合、グループメッセージはブロックされます。
- ランタイムの安全性: プロバイダーブロックが完全に欠けている（`channels.<provider>`が不在）場合、グループポリシーは`channels.defaults.groupPolicy`を継承する代わりにフェイルクローズドモード（通常は`allowlist`）にフォールバックします。

クイックメンタルモデル（グループメッセージの評価順序）:

1. `groupPolicy`（open/disabled/allowlist）
2. グループ許可リスト（`*.groups`、`*.groupAllowFrom`、チャンネル固有の許可リスト）
3. メンションゲーティング（`requireMention`、`/activation`）

## メンションゲーティング（デフォルト）

グループメッセージはグループごとにオーバーライドされない限りメンションが必要です。デフォルトは`*.groups."*"`のサブシステムごとに設定されます。

ボットメッセージへの返信は暗黙的なメンションとしてカウントされます（チャンネルが返信メタデータをサポートしている場合）。これはTelegram、WhatsApp、Slack、Discord、Microsoft Teamsに適用されます。

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

注意:

- `mentionPatterns`は大文字小文字を区別しない正規表現です。
- 明示的なメンションを提供するサーフェスは引き続きパスします。パターンはフォールバックです。
- エージェントごとのオーバーライド: `agents.list[].groupChat.mentionPatterns`（複数のエージェントがグループを共有する場合に便利）。
- メンションゲーティングはメンション検出が可能な場合にのみ適用されます（ネイティブメンションまたは`mentionPatterns`が設定されている場合）。
- Discordのデフォルトは`channels.discord.guilds."*"`にあります（ギルド/チャンネルごとにオーバーライド可能）。
- グループ履歴コンテキストはチャンネル間で均一にラップされ、**ペンディングのみ**です（メンションゲーティングによりスキップされたメッセージ）。グローバルデフォルトには`messages.groupChat.historyLimit`を使用し、オーバーライドには`channels.<channel>.historyLimit`（または`channels.<channel>.accounts.*.historyLimit`）を使用します。`0`で無効化。

## グループ/チャンネルのツール制限（オプション）

一部のチャンネル設定では、**特定のグループ/ルーム/チャンネル内**で利用可能なツールを制限できます。

- `tools`: グループ全体のツールの許可/拒否。
- `toolsBySender`: グループ内の送信者ごとのオーバーライド。
  明示的なキープレフィックスを使用します:
  `id:<senderId>`、`e164:<phone>`、`username:<handle>`、`name:<displayName>`、および`"*"`ワイルドカード。
  レガシーのプレフィックスなしキーは引き続き受け入れられ、`id:`としてのみマッチします。

解決順序（最も具体的なものが優先）:

1. グループ/チャンネルの`toolsBySender`マッチ
2. グループ/チャンネルの`tools`
3. デフォルト（`"*"`）の`toolsBySender`マッチ
4. デフォルト（`"*"`）の`tools`

例（Telegram）:

```json5
{
  channels: {
    telegram: {
      groups: {
        "*": { tools: { deny: ["exec"] } },
        "-1001234567890": {
          tools: { deny: ["exec", "read", "write"] },
          toolsBySender: {
            "id:123456789": { alsoAllow: ["exec"] },
          },
        },
      },
    },
  },
}
```

注意:

- グループ/チャンネルのツール制限はグローバル/エージェントのツールポリシーに加えて適用されます（denyが優先）。
- 一部のチャンネルではルーム/チャンネルに異なるネスト構造を使用します（例: Discord `guilds.*.channels.*`、Slack `channels.*`、MS Teams `teams.*.channels.*`）。

## グループ許可リスト

`channels.whatsapp.groups`、`channels.telegram.groups`、または`channels.imessage.groups`が設定されている場合、キーはグループ許可リストとして機能します。`"*"`を使用して、デフォルトのメンション動作を設定しつつすべてのグループを許可できます。

よくある設定パターン（コピー&ペースト）:

1. すべてのグループ返信を無効化

```json5
{
  channels: { whatsapp: { groupPolicy: "disabled" } },
}
```

2. 特定のグループのみを許可（WhatsApp）

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

3. すべてのグループを許可するがメンションを要求（明示的）

```json5
{
  channels: {
    whatsapp: {
      groups: { "*": { requireMention: true } },
    },
  },
}
```

4. グループではオーナーのみがトリガー可能（WhatsApp）

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

## アクティベーション（オーナー限定）

グループオーナーはグループごとのアクティベーションを切り替えられます:

- `/activation mention`
- `/activation always`

オーナーは`channels.whatsapp.allowFrom`（未設定時はボットの自己E.164）で決定されます。コマンドは単独のメッセージとして送信してください。他のサーフェスは現在`/activation`を無視します。

## コンテキストフィールド

グループの受信ペイロードは以下を設定します:

- `ChatType=group`
- `GroupSubject`（既知の場合）
- `GroupMembers`（既知の場合）
- `WasMentioned`（メンションゲーティング結果）
- Telegramフォーラムトピックは`MessageThreadId`と`IsForum`も含みます。

エージェントシステムプロンプトは新しいグループセッションの最初のターンでグループイントロを含みます。モデルに人間のように応答すること、Markdownテーブルを避けること、リテラルの`\n`シーケンスを入力しないことを指示します。

## iMessage固有の情報

- ルーティングや許可リスト登録には`chat_id:<id>`を推奨します。
- チャット一覧: `imsg chats --limit 20`。
- グループの返信は常に同じ`chat_id`に戻ります。

## WhatsApp固有の情報

WhatsApp固有の動作（履歴インジェクション、メンション処理の詳細）については[グループメッセージ](/channels/group-messages)を参照してください。
