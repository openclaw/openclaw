---
summary: "跨平台群組聊天行為 (WhatsApp/Telegram/Discord/Slack/Signal/iMessage/Microsoft Teams)"
read_when:
  - 欲修改群組聊天行為或提及限制時
title: "群組"
---

# 群組

OpenClaw 在各個平台上處理群組聊天的方式是一致的：包含 WhatsApp、Telegram、Discord、Slack、Signal、iMessage、Microsoft Teams。

## 新手簡介 (2 分鐘)

OpenClaw 「運行」在你自己的通訊帳號上。並沒有獨立的 WhatsApp 機器人使用者。
如果你**本人**在某個群組中，OpenClaw 就能看到該群組並在其中回覆。

預設行為：

- 群組受到限制 (`groupPolicy: "allowlist"`)。
- 除非你明確停用提及限制，否則回覆需要被「提及 (mention)」。

白話解釋：白名單內的傳送者可以透過提及 OpenClaw 來觸發它。

> 太長不看版 (TL;DR)
>
> - **私訊 (DM) 存取權** 由 `*.allowFrom` 控制。
> - **群組存取權** 由 `*.groupPolicy` + 白名單 (`*.groups`, `*.groupAllowFrom`) 控制。
> - **回覆觸發** 由提及限制 (`requireMention`, `/activation`) 控制。

快速流程 (群組訊息的處理過程)：

```
groupPolicy? disabled -> 捨棄
groupPolicy? allowlist -> 群組是否允許？ 否 -> 捨棄
requireMention? yes -> 是否被提及？ 否 -> 僅儲存用於上下文
否則 -> 回覆
```

![群組訊息流程](/images/groups-flow.svg)

如果你想要...

| 目標                                | 如何設定                                                   |
| ----------------------------------- | ---------------------------------------------------------- |
| 允許所有群組，但僅在被 @提及 時回覆 | `groups: { "*": { requireMention: true } }`                |
| 停用所有群組回覆                    | `groupPolicy: "disabled"`                                  |
| 僅限特定群組                        | `groups: { "<group-id>": { ... } }` (不使用 `"*"` 鍵名)    |
| 僅限你能觸發群組回覆                | `groupPolicy: "allowlist"`, `groupAllowFrom: ["+1555..."]` |

## 工作階段金鑰 (Session keys)

- 群組工作階段使用 `agent:<agentId>:<channel>:group:<id>` 工作階段金鑰 (聊天室/頻道則使用 `agent:<agentId>:<channel>:channel:<id>`)。
- Telegram 論壇主題 (forum topics) 會在群組 ID 後加上 `:topic:<threadId>`，因此每個主題都有獨立的工作階段。
- 直接對話 (Direct chats) 使用主工作階段 (或是依據設定使用個別傳送者的工作階段)。
- 群組工作階段會跳過活動訊號 (Heartbeats)。

## 模式：個人私訊 + 公開群組 (單一智慧代理)

是的 —— 如果你的「個人」流量是**私訊**，而「公開」流量是**群組**，這種模式運作良好。

原因：在單一智慧代理模式下，私訊通常會進入**主**工作階段金鑰 (`agent:main:main`)，而群組則始終使用**非主**工作階段金鑰 (`agent:main:<channel>:group:<id>`)。如果你使用 `mode: "non-main"` 啟用沙箱隔離，這些群組工作階段將在 Docker 中執行，而你的主私訊工作階段則保留在主機上。

這讓你擁有一個智慧代理「大腦」(共用工作區 + 記憶體)，但有兩種執行模式：

- **私訊**：完整工具 (主機)
- **群組**：沙箱 + 受限工具 (Docker)

> 如果你需要真正獨立的工作區/人格 (「個人」與「公開」絕對不能混合)，請使用第二個智慧代理並進行綁定。請參閱 [多智慧代理路由](/concepts/multi-agent)。

範例 (私訊在主機，群組使用沙箱 + 僅限訊息工具)：

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main", // 群組/頻道為非主工作階段 -> 進行沙箱隔離
        scope: "session", // 最強隔離 (每個群組/頻道一個容器)
        workspaceAccess: "none",
      },
    },
  },
  tools: {
    sandbox: {
      tools: {
        // 如果 allow 非空值，其他所有工具都會被封鎖 (deny 權限仍優先)。
        allow: ["group:messaging", "group:sessions"],
        deny: ["group:runtime", "group:fs", "group:ui", "nodes", "cron", "gateway"],
      },
    },
  },
}
```

想要「群組只能看到資料夾 X」而不是「完全無法存取主機」？請保留 `workspaceAccess: "none"` 並僅將白名單路徑掛載到沙箱中：

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

相關內容：

- 設定鍵名與預設值：[Gateway 設定](/gateway/configuration#agentsdefaultssandbox)
- 疑難排解工具被封鎖的原因：[沙箱 vs 工具政策 vs 提升權限](/gateway/sandbox-vs-tool-policy-vs-elevated)
- 掛載綁定詳情：[沙箱隔離](/gateway/sandboxing#custom-bind-mounts)

## 顯示標籤

- UI 標籤在可用時會使用 `displayName`，格式為 `<channel>:<token>`。
- `#room` 保留給聊天室/頻道；群組聊天使用 `g-<slug>` (小寫，空格轉換為 `-`，保留 `# @+._-`)。

## 群組策略 (Group policy)

控制每個通道處理群組/聊天室訊息的方式：

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

| 策略          | 行為                                |
| ------------- | ----------------------------------- |
| `"open"`      | 群組繞過白名單；提及限制仍然適用。  |
| `"disabled"`  | 完全封鎖所有群組訊息。              |
| `"allowlist"` | 僅允許符合設定白名單的群組/聊天室。 |

附註：

- `groupPolicy` 與提及限制 (需要 @提及) 是分開的。
- WhatsApp/Telegram/Signal/iMessage/Microsoft Teams：使用 `groupAllowFrom` (備案：明確的 `allowFrom`)。
- Discord：白名單使用 `channels.discord.guilds.<id>.channels`。
- Slack：白名單使用 `channels.slack.channels`。
- Matrix：白名單使用 `channels.matrix.groups` (聊天室 ID、別名或名稱)。使用 `channels.matrix.groupAllowFrom` 來限制傳送者；亦支援個別聊天室的 `users` 白名單。
- 群組私訊 (Group DMs) 是獨立控制的 (`channels.discord.dm.*`, `channels.slack.dm.*`)。
- Telegram 白名單可以比對使用者 ID (`"123456789"`, `"telegram:123456789"`, `"tg:123456789"`) 或使用者名稱 (`" @alice"` 或 `"alice"`)；前綴不區分大小寫。
- 預設值為 `groupPolicy: "allowlist"`；如果你的群組白名單為空，群組訊息將被封鎖。

快速思維模型 (群組訊息的評估順序)：

1. `groupPolicy` (open/disabled/allowlist)
2. 群組白名單 (`*.groups`, `*.groupAllowFrom`, 通道特定白名單)
3. 提及限制 (`requireMention`, `/activation`)

## 提及限制 (預設值)

除非在個別群組中覆寫，否則群組訊息需要被提及。預設值位於子系統下的 `*.groups."*"`。

回覆機器人的訊息會被視為隱含提及 (當通道支援回覆中繼資料時)。這適用於 Telegram、WhatsApp、Slack、Discord 和 Microsoft Teams。

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

附註：

- `mentionPatterns` 是不區分大小寫的正則表達式 (regexes)。
- 提供明確提及功能的平台仍會通過；模式 (patterns) 是備案。
- 個別智慧代理覆寫：`agents.list[].groupChat.mentionPatterns` (當多個智慧代理共用一個群組時很有用)。
- 提及限制僅在可以偵測提及時 (原生提及或已設定 `mentionPatterns`) 才會強制執行。
- Discord 的預設值位於 `channels.discord.guilds."*"` (可依據伺服器/頻道進行覆寫)。
- 群組歷史記錄上下文在各通道間以統一方式封裝，且為**僅限待處理 (pending-only)** (因提及限制而被跳過的訊息)；使用 `messages.groupChat.historyLimit` 設定全域預設值，並使用 `channels.<channel>.historyLimit` (或 `channels.<channel>.accounts.*.historyLimit`) 進行覆寫。設定為 `0` 則停用。

## 群組/頻道工具限制 (選用)

部分通道設定支援限制**在特定群組/聊天室/頻道內**可以使用的工具。

- `tools`：針對整個群組允許/拒絕工具。
- `toolsBySender`：群組內針對個別傳送者的覆寫 (鍵名為傳送者 ID/使用者名稱/電子郵件/電話號碼，視通道而定)。使用 `"*"` 作為萬用字元。

解析順序 (愈具體優先權愈高)：

1. 群組/頻道 `toolsBySender` 比對
2. 群組/頻道 `tools`
3. 預設 (`"*"`) `toolsBySender` 比對
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

附註：

- 除了全域/智慧代理工具政策外，還會套用群組/頻道工具限制 (deny 權限仍優先)。
- 部分通道對聊天室/頻道使用不同的巢狀結構 (例如 Discord `guilds.*.channels.*`、Slack `channels.*`、MS Teams `teams.*.channels.*`)。

## 群組白名單

當設定了 `channels.whatsapp.groups`、`channels.telegram.groups` 或 `channels.imessage.groups` 時，其鍵名即充當群組白名單。使用 `"*"` 可以允許所有群組，同時仍然設定預設的提及行為。

常見意圖 (複製/貼上)：

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

3. 允許所有群組但要求提及 (明確設定)

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

## 啟用 (僅限擁有者)

群組擁有者可以切換各群組的啟用狀態：

- `/activation mention`
- `/activation always`

擁有者由 `channels.whatsapp.allowFrom` 決定 (若未設定，則為機器人本身的 E.164 號碼)。請將指令作為獨立訊息傳送。其他平台目前會忽略 `/activation`。

## 上下文欄位

群組傳入內容會設定：

- `ChatType=group`
- `GroupSubject` (若已知)
- `GroupMembers` (若已知)
- `WasMentioned` (提及限制結果)
- Telegram 論壇主題還會包含 `MessageThreadId` 和 `IsForum`。

智慧代理系統提示會在新的群組工作階段的第一次對話中包含群組介紹。它會提醒模型以人類的方式回應，避免使用 Markdown 表格，並避免輸入字面上的 `\n` 序列。

## iMessage 特定說明

- 在路由或設定白名單時，建議優先使用 `chat_id:<id>`。
- 列出聊天列表：`imsg chats --limit 20`。
- 群組回覆一律會回到相同的 `chat_id`。

## WhatsApp 特定說明

關於 WhatsApp 特有的行為 (歷史記錄注入、提及處理細節)，請參閱 [群組訊息](/channels/group-messages)。
