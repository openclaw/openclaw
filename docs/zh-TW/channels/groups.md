---
summary: >-
  Group chat behavior across surfaces
  (WhatsApp/Telegram/Discord/Slack/Signal/iMessage/Microsoft Teams/Zalo)
read_when:
  - Changing group chat behavior or mention gating
title: Groups
---

# Groups

OpenClaw 在各個平台上對群組聊天的處理是一致的：WhatsApp、Telegram、Discord、Slack、Signal、iMessage、Microsoft Teams、Zalo。

## Beginner intro (2 minutes)

OpenClaw “存在”於您自己的訊息帳號中。並沒有單獨的 WhatsApp 機器人用戶。  
如果 **您** 在一個群組中，OpenClaw 可以看到該群組並在那裡回應。

Default behavior:

- 群組是受限的 (`groupPolicy: "allowlist"`)。
- 回覆需要提及，除非您明確禁用提及限制。

允許的發件人可以透過提及 OpenClaw 來觸發它。

> TL;DR
>
> - **DM 存取** 由 `*.allowFrom` 控制。
> - **群組存取** 由 `*.groupPolicy` + 允許清單 (`*.groups`, `*.groupAllowFrom`) 控制。
> - **回覆觸發** 由提及閘道 (`requireMention`, `/activation`) 控制。

[[BLOCK_1]]  
快速流程（群組訊息的處理過程）：  
[[BLOCK_1]]

```
groupPolicy? disabled -> drop
groupPolicy? allowlist -> group allowed? no -> drop
requireMention? yes -> mentioned? no -> store for context only
otherwise -> reply
```

![Group message flow](/images/groups-flow.svg)

[[BLOCK_1]]

| 目標                            | 設定內容                                                   |
| ------------------------------- | ---------------------------------------------------------- |
| 允許所有群組但僅在 @提及 時回覆 | `groups: { "*": { requireMention: true } }`                |
| 禁用所有群組回覆                | `groupPolicy: "disabled"`                                  |
| 僅限特定群組                    | `groups: { "<group-id>": { ... } }` (無 `"*"` 鍵)          |
| 只有你可以在群組中觸發          | `groupPolicy: "allowlist"`, `groupAllowFrom: ["+1555..."]` |

## Session keys

- 群組會議使用 `agent:<agentId>:<channel>:group:<id>` 會議金鑰（房間/頻道使用 `agent:<agentId>:<channel>:channel:<id>`）。
- Telegram 論壇主題將 `:topic:<threadId>` 添加到群組 ID，以便每個主題都有自己的會議。
- 直接聊天使用主要會議（或根據發送者設定）。
- 群組會議會跳過心跳檢查。

## Pattern: personal DMs + public groups (single agent)

是的，如果你的「個人」流量是 **DMs**，而你的「公共」流量是 **groups**，這樣的做法效果很好。

為什麼：在單代理模式下，DM 通常會落在 **主** 會話金鑰 (`agent:main:main`)，而群組則始終使用 **非主** 會話金鑰 (`agent:main:<channel>:group:<id>`). 如果你啟用沙盒功能 (`mode: "non-main"`), 那些群組會話會在 Docker 中執行，而你的主 DM 會話則保持在主機上。

這為你提供了一個代理的「大腦」（共享工作區 + 記憶），但有兩種執行姿態：

- **DMs**: 完整工具 (主機)
- **Groups**: 沙盒 + 限制工具 (Docker)

> 如果您需要真正獨立的工作空間/角色（“個人”和“公共”絕不能混合），請使用第二個代理 + 綁定。請參見 [Multi-Agent Routing](/concepts/multi-agent)。

範例（主機上的直接訊息，群組被沙盒化 + 僅限訊息的工具）：

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

想要「群組只能看到資料夾 X」而不是「無主機存取」？保留 `workspaceAccess: "none"` 並且僅允許將白名單中的路徑掛載到沙盒中：

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

[[BLOCK_1]]

- 設定鍵和預設值: [閘道設定](/gateway/configuration#agentsdefaultssandbox)
- 調試為何工具被阻擋: [沙盒與工具政策與提升權限](/gateway/sandbox-vs-tool-policy-vs-elevated)
- 綁定掛載詳細資訊: [沙盒化](/gateway/sandboxing#custom-bind-mounts)

## Display labels

- UI 標籤在可用時使用 `displayName`，格式為 `<channel>:<token>`。
- `#room` 保留給房間/頻道；群組聊天使用 `g-<slug>`（小寫，空格 -> `-`，保留 `#@+._-`）。

## 群組政策

控制每個頻道的群組/房間消息處理方式：

```json5
{
  channels: {
    whatsapp: {
      groupPolicy: "disabled", // "open" | "disabled" | "allowlist"
      groupAllowFrom: ["+15551234567"],
    },
    telegram: {
      groupPolicy: "disabled",
      groupAllowFrom: ["123456789"], // numeric Telegram user id (wizard can resolve @username)
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

| 政策          | 行為                                  |
| ------------- | ------------------------------------- |
| `"open"`      | 群組繞過允許清單；提及限制仍然適用。  |
| `"disabled"`  | 完全阻止所有群組訊息。                |
| `"allowlist"` | 只允許符合已設定允許清單的群組/房間。 |

[[BLOCK_1]]

- `groupPolicy` 與提及限制是分開的（提及限制需要 @提及）。
- WhatsApp/Telegram/Signal/iMessage/Microsoft Teams/Zalo: 使用 `groupAllowFrom`（備用: 明確的 `allowFrom`）。
- DM 配對批准 (`*-allowFrom` 儲存條目) 僅適用於 DM 存取；群組發送者授權仍然明確依賴於群組允許清單。
- Discord: 允許清單使用 `channels.discord.guilds.<id>.channels`。
- Slack: 允許清單使用 `channels.slack.channels`。
- Matrix: 允許清單使用 `channels.matrix.groups`（房間 ID、別名或名稱）。使用 `channels.matrix.groupAllowFrom` 來限制發送者；每個房間的 `users` 允許清單也受到支援。
- 群組 DM 是單獨控制的 (`channels.discord.dm.*`, `channels.slack.dm.*`)。
- Telegram 允許清單可以匹配用戶 ID (`"123456789"`, `"telegram:123456789"`, `"tg:123456789"`) 或用戶名 (`"@alice"` 或 `"alice"`); 前綴不區分大小寫。
- 預設為 `groupPolicy: "allowlist"`; 如果您的群組允許清單為空，則群組消息將被阻止。
- 執行時安全性: 當提供者區塊完全缺失 (`channels.<provider>` 缺失)，群組政策將回退到失敗關閉模式（通常是 `allowlist`），而不是繼承 `channels.defaults.groupPolicy`。

[[BLOCK_1]]  
快速心智模型（群組訊息的評估順序）：  
[[BLOCK_1]]

1. `groupPolicy` (開啟/禁用/允許清單)
2. 群組允許清單 (`*.groups`, `*.groupAllowFrom`, 頻道特定允許清單)
3. 提及限制 (`requireMention`, `/activation`)

## 提及限制（預設）

群組訊息需要提及，除非每個群組另有覆蓋。預設值在 `*.groups."*"` 下的每個子系統中生效。

回覆機器人訊息會被視為隱式提及（當頻道支援回覆元資料時）。這適用於 Telegram、WhatsApp、Slack、Discord 和 Microsoft Teams。

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

[[BLOCK_1]]

- `mentionPatterns` 是不區分大小寫的正則表達式。
- 提供明確提及的表面仍然會通過；模式是備用的。
- 每個代理的覆蓋：`agents.list[].groupChat.mentionPatterns`（當多個代理共享一個群組時非常有用）。
- 只有在可以檢測到提及時（本地提及或 `mentionPatterns` 已設定）才會強制執行提及閘道。
- Discord 的預設值位於 `channels.discord.guilds."*"`（可以根據公會/頻道進行覆蓋）。
- 群組歷史上下文在各頻道中統一包裝，並且是 **僅待處理**（因提及閘道而跳過的消息）；使用 `messages.groupChat.historyLimit` 作為全域預設，並使用 `channels.<channel>.historyLimit`（或 `channels.<channel>.accounts.*.historyLimit`）進行覆蓋。設置 `0` 以禁用。

## 群組/頻道工具限制（選用）

某些頻道設定支援限制在 **特定群組/房間/頻道** 內可用的工具。

- `tools`: 允許/拒絕整個群組的工具。
- `toolsBySender`: 群組內每個發送者的覆蓋設定。
  使用明確的鍵前綴：
  `id:<senderId>`, `e164:<phone>`, `username:<handle>`, `name:<displayName>`, 和 `"*"` 通配符。
  過去未加前綴的鍵仍然被接受並僅匹配為 `id:`。

解析順序（最具體者勝）：

1. 群組/頻道 `toolsBySender` 匹配
2. 群組/頻道 `tools`
3. 預設 (`"*"`) `toolsBySender` 匹配
4. 預設 (`"*"`) `tools`

[[BLOCK_1]]  
範例 (Telegram):  
[[BLOCK_2]]

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

Notes:

- 群組/頻道工具限制是附加於全域/代理工具政策之上的（拒絕仍然優先）。
- 某些頻道對房間/頻道使用不同的嵌套方式（例如，Discord `guilds.*.channels.*`、Slack `channels.*`、MS Teams `teams.*.channels.*`）。

## Group allowlists

當 `channels.whatsapp.groups`、`channels.telegram.groups` 或 `channels.imessage.groups` 被設定時，這些鍵會作為一組允許清單。使用 `"*"` 來允許所有群組，同時仍然設置預設的提及行為。

[[BLOCK_1]]  
Common intents (copy/paste):  
[[BLOCK_1]]

1. 禁用所有群組回覆

```json5
{
  channels: { whatsapp: { groupPolicy: "disabled" } },
}
```

2. 僅允許特定群組（WhatsApp）

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

3. 允許所有群組，但需要提及（明確）

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

群組擁有者可以切換每個群組的啟用狀態：

- `/activation mention`
- `/activation always`

擁有者由 `channels.whatsapp.allowFrom` 決定（或在未設置時使用機器人的自我 E.164）。請將命令作為獨立消息發送。其他介面目前忽略 `/activation`。

## Context fields

Group inbound payloads set:

- `ChatType=group`
- `GroupSubject` (如果已知)
- `GroupMembers` (如果已知)
- `WasMentioned` (提及閘控結果)
- Telegram 論壇主題還包括 `MessageThreadId` 和 `IsForum`。

代理系統提示在新群組會話的第一輪中包含一個群組介紹。它提醒模型要像人類一樣回應，避免使用 Markdown 表格，並避免輸入字面上的 `\n` 序列。

## iMessage 具體資訊

- 在路由或允許清單時，優先使用 `chat_id:<id>`。
- 列出聊天：`imsg chats --limit 20`。
- 群組回覆總是回到相同的 `chat_id`。

## WhatsApp 相關細節

請參閱 [Group messages](/channels/group-messages) 以了解僅限 WhatsApp 的行為（歷史注入、提及處理細節）。
