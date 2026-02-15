---
summary: "群組聊天行為 (WhatsApp/Telegram/Discord/Slack/Signal/iMessage/Microsoft Teams)"
read_when:
  - 變更群組聊天行為或提及門控時
title: "群組"
---

# 群組

OpenClaw 在不同平台上一致處理群組聊天：WhatsApp、Telegram、Discord、Slack、Signal、iMessage、Microsoft Teams。

## 新手入門 (2 分鐘)

OpenClaw 「存在」於您自己的訊息帳號中。沒有單獨的 WhatsApp 機器人使用者。
如果您在群組中，OpenClaw 就能看到該群組並在其中回應。

預設行為：

- 群組受到限制 (`groupPolicy: "allowlist"`)。
- 除非您明確停用提及門控，否則回覆需要提及。

翻譯：允許清單中的寄件者可以透過提及 OpenClaw 來觸發它。

> TL;DR
>
> - **私訊存取**由 `*.allowFrom` 控制。
> - **群組存取**由 `*.groupPolicy` + 允許清單 (`*.groups`、`*.groupAllowFrom`) 控制。
> - **回覆觸發**由提及門控 (`requireMention`、`/activation`) 控制。

快速流程（群組訊息會發生什麼事）：

```
groupPolicy? disabled -> drop
groupPolicy? allowlist -> group allowed? no -> drop
requireMention? yes -> mentioned? no -> store for context only
otherwise -> reply
```

![Group message flow](/images/groups-flow.svg)

如果您想...

| 目標                                         | 如何設定                                                |
| -------------------------------------------- | ---------------------------------------------------------- |
| 允許所有群組但僅回覆提及                   | `groups: { "*": { requireMention: true } }`                |
| 停用所有群組回覆                           | `groupPolicy: "disabled"`                                  |
| 僅限特定群組                               | `groups: { "<group-id>": { ... } }` (無 `"*"` 金鑰)         |
| 只有您可以在群組中觸發               | `groupPolicy: "allowlist"`, `groupAllowFrom: ["+1555..."]` |

## 工作階段金鑰

- 群組工作階段使用 `agent:<agentId>:<channel>:group:<id>` 工作階段金鑰（房間/頻道使用 `agent:<agentId>:<channel>:channel:<id>`）。
- Telegram 論壇主題會將 `:topic:<threadId>` 加入群組 ID，因此每個主題都有其自己的工作階段。
- 直接聊天使用主要工作階段（或依寄件者設定）。
- 群組工作階段會跳過心跳。

## 模式：個人私訊 + 公開群組（單一智慧代理）

是的 — 如果您的「個人」流量是**私訊**，而您的「公開」流量是**群組**，這會運作良好。

原因：在單一智慧代理模式下，私訊通常會落在**主要**工作階段金鑰 (`agent:main:main`) 中，而群組總是使用**非主要**工作階段金鑰 (`agent:main:<channel>:group:<id>`)。如果您啟用沙箱隔離，並將 `mode: "non-main"`，則這些群組工作階段會在 Docker 中執行，而您的主要私訊工作階段則留在主機上。

這為您提供了一個智慧代理「大腦」（共享工作區 + 記憶體），但有兩種執行姿態：

- **私訊**：完整工具（主機）
- **群組**：沙箱隔離 + 受限工具（Docker）

> 如果您需要真正獨立的工作區/角色（「個人」和「公開」絕不能混淆），請使用第二個智慧代理 + 綁定。請參閱 [多智慧代理路由](/concepts/multi-agent)。

範例（主機上的私訊，群組為沙箱隔離 + 僅限訊息工具）：

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

想要「群組只能看到資料夾 X」而不是「沒有主機存取權」？保留 `workspaceAccess: "none"`，並僅將允許清單中的路徑掛載到沙箱中：

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

相關：

- 設定金鑰和預設值：[Gateway 設定](/gateway/configuration#agentsdefaultssandbox)
- 偵錯工具為何被封鎖：[沙箱隔離與工具策略 vs 提升權限](/gateway/sandbox-vs-tool-policy-vs-elevated)
- 綁定掛載詳情：[沙箱隔離](/gateway/sandboxing#custom-bind-mounts)

## 顯示標籤

- 使用者介面標籤在可用時使用 `displayName`，格式為 `<channel>:<token>`。
- `#room` 保留給房間/頻道使用；群組聊天使用 `g-<slug>`（小寫，空格 -> `-`，保留 `# @+._-`）。

## 群組策略

控制每個頻道如何處理群組/房間訊息：

```json5
{
  channels: {
    whatsapp: {
      groupPolicy: "disabled", // "open" | "disabled" | "allowlist"
      groupAllowFrom: ["+15551234567"],
    },
    telegram: {
      groupPolicy: "disabled",
      groupAllowFrom: ["123456789", " @username"],
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
      groupAllowFrom: ["user @org.com"],
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
      groupAllowFrom: [" @owner:example.org"],
      groups: {
        "!roomId:example.org": { allow: true },
        "#alias:example.org": { allow: true },
      },
    },
  },
}
```

| 策略        | 行為                                                     |
| ------------- | ------------------------------------------------------------ |
| `"open"`      | 群組繞過允許清單；提及門控仍然適用。      |
| `"disabled"`  | 完全封鎖所有群組訊息。                           |
| `"allowlist"` | 僅允許符合已設定允許清單的群組/房間。 |

注意事項：

- `groupPolicy` 與提及門控（需要 @提及）是分開的。
- WhatsApp/Telegram/Signal/iMessage/Microsoft Teams：使用 `groupAllowFrom`（備用：明確的 `allowFrom`）。
- Discord：允許清單使用 `channels.discord.guilds.<id>.channels`。
- Slack：允許清單使用 `channels.slack.channels`。
- Matrix：允許清單使用 `channels.matrix.groups`（房間 ID、別名或名稱）。使用 `channels.matrix.groupAllowFrom` 限制寄件者；也支援按房間設定的 `users` 允許清單。
- 群組私訊單獨控制 (`channels.discord.dm.*`、`channels.slack.dm.*`)。
- Telegram 允許清單可以比對使用者 ID（`"123456789"`、`"telegram:123456789"`、`"tg:123456789"`) 或使用者名稱（`" @alice"` 或 `"alice"`)；前綴不區分大小寫。
- 預設為 `groupPolicy: "allowlist"`；如果您的群組允許清單為空，群組訊息將被封鎖。

快速心智模型（群組訊息的評估順序）：

1. `groupPolicy`（開放/停用/允許清單）
2. 群組允許清單 (`*.groups`、`*.groupAllowFrom`、頻道特定允許清單)
3. 提及門控 (`requireMention`、`/activation`)

## 提及門控（預設）

群組訊息需要提及，除非每個群組都有覆寫。預設值存在於 `*.groups."*"` 下的每個子系統中。
回覆機器人訊息算作隱式提及（當頻道支援回覆中繼資料時）。這適用於 Telegram、WhatsApp、Slack、Discord 和 Microsoft Teams。

```json5
{
  channels: {
    whatsapp: {
      groups: {
        "*": { requireMention: true },
        "123 @g.us": { requireMention: false },
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
          mentionPatterns: [" @openclaw", "openclaw", "\\+15555550123"],
          historyLimit: 50,
        },
      },
    ],
  },
}
```

注意事項：

- `mentionPatterns` 是不區分大小寫的正規表達式。
- 提供明確提及的平台仍然會通過；模式是備用方案。
- 每個智慧代理覆寫：`agents.list[].groupChat.mentionPatterns`（當多個智慧代理共享一個群組時很有用）。
- 提及門控僅在提及偵測可能時（原生提及或已設定 `mentionPatterns`）才會執行。
- Discord 預設值存在於 `channels.discord.guilds."*"` 中（可按伺服器/頻道覆寫）。
- 群組歷史記錄上下文在所有頻道中統一包裝，並且僅限**待處理**（因提及門控而被跳過的訊息）；使用 `messages.groupChat.historyLimit` 作為全域預設值，並使用 `channels.<channel>.historyLimit`（或 `channels.<channel>.accounts.*.historyLimit`）進行覆寫。設定 `0` 以停用。

## 群組/頻道工具限制（選用）

某些頻道設定支援限制在**特定群組/房間/頻道內**可用的工具。

- `tools`：允許/拒絕整個群組的工具。
- `toolsBySender`：群組內每個寄件者的覆寫（金鑰是寄件者 ID/使用者名稱/電子郵件/電話號碼，具體取決於頻道）。使用 `"*"` 作為萬用字元。

解析順序（最具體者優先）：

1. 群組/頻道 `toolsBySender` 符合
2. 群組/頻道 `tools`
3. 預設 (`"*"`) `toolsBySender` 符合
4. 預設 (`"*"`) `tools`

範例 (Telegram)：

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

注意事項：

- 群組/頻道工具限制除了全域/智慧代理工具策略之外還會應用（拒絕仍然優先）。
- 某些頻道對房間/頻道使用不同的巢狀結構（例如，Discord `guilds.*.channels.*`、Slack `channels.*`、MS Teams `teams.*.channels.*`）。

## 群組允許清單

當設定 `channels.whatsapp.groups`、`channels.telegram.groups` 或 `channels.imessage.groups` 時，金鑰將作為群組允許清單。使用 `"*"` 允許所有群組，同時仍然設定預設提及行為。

常見意圖（複製/貼上）：

1. 停用所有群組回覆

```json5
{
  channels: { whatsapp: { groupPolicy: "disabled" } },
}
```

2. 僅允許特定群組 (WhatsApp)

```json5
{
  channels: {
    whatsapp: {
      groups: {
        "123 @g.us": { requireMention: true },
        "456 @g.us": { requireMention: false },
      },
    },
  },
}
```

3. 允許所有群組但要求提及（明確）

```json5
{
  channels: {
    whatsapp: {
      groups: { "*": { requireMention: true } },
    },
  },
}
```

4. 只有擁有者可以在群組中觸發 (WhatsApp)

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

## 啟用（僅限擁有者）

群組擁有者可以切換每個群組的啟用：

- `/activation mention`
- `/activation always`

擁有者由 `channels.whatsapp.allowFrom` 決定（或未設定時為機器人本身的 E.164）。將命令作為獨立訊息傳送。其他平台目前會忽略 `/activation`。

## 上下文字段

群組傳入負載設定：

- `ChatType=group`
- `GroupSubject`（如果已知）
- `GroupMembers`（如果已知）
- `WasMentioned`（提及門控結果）
- Telegram 論壇主題也包含 `MessageThreadId` 和 `IsForum`。

智慧代理系統提示在新的群組工作階段的第一個回合中包含群組介紹。它提醒模型像人類一樣回應，避免 Markdown 表格，並避免輸入字面上的 `\n` 序列。

## iMessage 特定資訊

- 在路由或允許清單時偏好 `chat_id:<id>`。
- 列出聊天：`imsg chats --limit 20`。
- 群組回覆總是回到相同的 `chat_id`。

## WhatsApp 特定資訊

請參閱 [群組訊息](/channels/group-messages) 以了解僅限 WhatsApp 的行為（歷史記錄注入、提及處理詳情）。
```
