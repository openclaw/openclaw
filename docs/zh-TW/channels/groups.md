---
summary: "跨平台的群組聊天行為（WhatsApp／Telegram／Discord／Slack／Signal／iMessage／Microsoft Teams）"
read_when:
  - 變更群組聊天行為或提及（mention）管控時
title: "群組"
---

# 群組

OpenClaw 會在各種平台上一致地處理群組聊天：WhatsApp、Telegram、Discord、Slack、Signal、iMessage、Microsoft Teams。

## 新手入門（2 分鐘）

26. OpenClaw「存在」於你自己的通訊帳號上。 27. 沒有獨立的 WhatsApp 機器人使用者。
27. 如果**你**在某個群組中，OpenClaw 就能看到該群組並在那裡回應。

29. 預設行為：

- 群組是受限的（`groupPolicy: "allowlist"`）。
- 30. 回覆需要被點名，除非你明確停用點名門檻。

翻譯一下：在允許清單中的寄件者，必須提及 OpenClaw 才能觸發它。

> TL;DR
>
> - **私訊（DM）存取** 由 `*.allowFrom` 控制。
> - **群組存取** 由 `*.groupPolicy` + 允許清單（`*.groups`、`*.groupAllowFrom`）控制。
> - **回覆觸發** 由提及管控（`requireMention`、`/activation`）控制。

快速流程（群組訊息會發生什麼）：

```
groupPolicy? disabled -> drop
groupPolicy? allowlist -> group allowed? no -> drop
requireMention? yes -> mentioned? no -> store for context only
otherwise -> reply
```

![Group message flow](/images/groups-flow.svg)

如果你想要……

| 目標                                    | 要設定的項目                                                    |
| ------------------------------------- | --------------------------------------------------------- |
| 允許所有群組，但只在 @mentions 時回覆 | `groups: { "*": { requireMention: true } }`               |
| 停用所有群組回覆                              | `groupPolicy: "disabled"`                                 |
| 只允許特定群組                               | `groups: { "<group-id>": { ... } }`（沒有 `"*"` 金鑰）          |
| 只有你可以在群組中觸發                           | `groupPolicy: "allowlist"`、`groupAllowFrom: ["+1555..."]` |

## 31. 工作階段金鑰

- 群組工作階段使用 `agent:<agentId>:<channel>:group:<id>` 工作階段金鑰（房間／頻道使用 `agent:<agentId>:<channel>:channel:<id>`）。
- Telegram 論壇主題會在群組 ID 上加入 `:topic:<threadId>`，讓每個主題都有自己的工作階段。
- 32. 私聊使用主要工作階段（或依設定為每位寄件者一個）。
- 群組工作階段會略過心跳。

## 模式：個人私訊 + 公開群組（單一代理程式）

可以——如果你的「個人」流量是 **私訊（DM）**，而「公開」流量是 **群組**，這個模式運作得很好。

33. 原因：在單一代理模式下，DM 通常落在**主要**工作階段金鑰（`agent:main:main`），而群組一律使用**非主要**工作階段金鑰（`agent:main:<channel>:group:<id>`）。 34. 若啟用沙箱並設定 `mode: "non-main"`，這些群組工作階段會在 Docker 中執行，而你的主要 DM 工作階段則留在主機上。

這樣你會有一個代理程式「大腦」（共享的工作區與記憶），但有兩種執行姿態：

- **私訊（DM）**：完整工具（主機）
- **群組**：沙箱 + 受限工具（Docker）

> 如果你需要真正分離的工作區／角色（「個人」與「公開」絕不能混用），請使用第二個代理程式 + 綁定。請參閱 [Multi-Agent Routing](/concepts/multi-agent)。 35. 請參閱 [Multi-Agent Routing](/concepts/multi-agent)。

範例（私訊在主機上、群組在沙箱中且僅有傳訊工具）：

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

想要「群組只能看到資料夾 X」，而不是「沒有主機存取權」？保留 `workspaceAccess: "none"`，並只將允許清單中的路徑掛載到沙箱中： 36. 保持 `workspaceAccess: "none"`，並只將 allowlist 中的路徑掛載到沙箱中：

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

37. 相關：

- 設定金鑰與預設值：[Gateway configuration](/gateway/configuration#agentsdefaultssandbox)
- 偵錯工具為何被封鎖：[Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated)
- 綁定掛載細節：[Sandboxing](/gateway/sandboxing#custom-bind-mounts)

## 顯示標籤

- UI 標籤在可用時使用 `displayName`，格式為 `<channel>:<token>`。
- `#room` 保留給房間／頻道；群組聊天使用 `g-<slug>`（小寫，空白轉為 `-`，保留 `#@+._-`）。

## 群組政策

控制各頻道中群組／房間訊息的處理方式：

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

| 政策            | 行為                  |
| ------------- | ------------------- |
| `"open"`      | 群組略過允許清單；仍套用提及管控。   |
| `"disabled"`  | 完全封鎖所有群組訊息。         |
| `"allowlist"` | 只允許符合設定之允許清單的群組／房間。 |

注意事項：

- `groupPolicy` 與提及管控是分開的（提及管控需要 @mentions）。
- WhatsApp／Telegram／Signal／iMessage／Microsoft Teams：使用 `groupAllowFrom`（後備：明確的 `allowFrom`）。
- Discord：允許清單使用 `channels.discord.guilds.<id>.channels`。
- Slack：允許清單使用 `channels.slack.channels`。
- 38. Matrix：allowlist 使用 `channels.matrix.groups`（房間 ID、別名或名稱）。 Matrix：允許清單使用 `channels.matrix.groups`（房間 ID、別名或名稱）。使用 `channels.matrix.groupAllowFrom` 來限制寄件者；也支援每個房間的 `users` 允許清單。
- 群組私訊（Group DMs）是分開控制的（`channels.discord.dm.*`、`channels.slack.dm.*`）。
- Telegram 允許清單可比對使用者 ID（`"123456789"`、`"telegram:123456789"`、`"tg:123456789"`）或使用者名稱（`"@alice"` 或 `"alice"`）；前綴不分大小寫。
- 預設為 `groupPolicy: "allowlist"`；如果你的群組允許清單是空的，群組訊息會被封鎖。

快速心智模型（群組訊息的評估順序）：

1. `groupPolicy`（開放／停用／允許清單）
2. 群組允許清單（`*.groups`、`*.groupAllowFrom`、頻道專屬允許清單）
3. 提及管控（`requireMention`、`/activation`）

## 39) 點名門檻（預設）

除非針對特定群組覆寫，否則群組訊息需要被提及。預設值位於各子系統的 `*.groups."*"` 之下。 40. 預設值位於各子系統下的 `*.groups."*"`。

Replying to a bot message counts as an implicit mention (when the channel supports reply metadata). This applies to Telegram, WhatsApp, Slack, Discord, and Microsoft Teams.

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

注意事項：

- `mentionPatterns` are case-insensitive regexes.
- Surfaces that provide explicit mentions still pass; patterns are a fallback.
- 每個代理程式的覆寫：`agents.list[].groupChat.mentionPatterns`（多個代理程式共用同一個群組時很有用）。
- Mention gating is only enforced when mention detection is possible (native mentions or `mentionPatterns` are configured).
- Discord 的預設值位於 `channels.discord.guilds."*"`（可依伺服器／頻道覆寫）。
- Group history context is wrapped uniformly across channels and is **pending-only** (messages skipped due to mention gating); use `messages.groupChat.historyLimit` for the global default and `channels.<channel>.historyLimit`（或 `channels.<channel>.accounts.*.historyLimit`）。設定 `0` 可停用。 Set `0` to disable.

## 群組／頻道工具限制（選用）

部分頻道設定支援限制**特定群組／房間／頻道內**可用的工具。

- `tools`：整個群組允許／拒絕工具。
- `toolsBySender`：群組內依寄件者覆寫（鍵值為寄件者 ID／使用者名稱／電子郵件／電話號碼，視頻道而定）。使用 `"*"` 作為萬用字元。 Use `"*"` as a wildcard.

Resolution order (most specific wins):

1. 群組／頻道 `toolsBySender` 比對
2. 群組／頻道 `tools`
3. 預設（`"*"`）`toolsBySender` 比對
4. 預設（`"*"`）`tools`

範例（Telegram）：

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

- Group/channel tool restrictions are applied in addition to global/agent tool policy (deny still wins).
- 某些頻道對房間／頻道使用不同的巢狀結構（例如 Discord 的 `guilds.*.channels.*`、Slack 的 `channels.*`、Microsoft Teams 的 `teams.*.channels.*`）。

## 群組允許清單

當設定了 `channels.whatsapp.groups`、`channels.telegram.groups` 或 `channels.imessage.groups` 時，這些金鑰會作為群組允許清單。使用 `"*"` 可以在仍設定預設提及行為的同時允許所有群組。 Use `"*"` to allow all groups while still setting default mention behavior.

Common intents (copy/paste):

1. 停用所有群組回覆

```json5
{
  channels: { whatsapp: { groupPolicy: "disabled" } },
}
```

2. 只允許特定群組（WhatsApp）

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

4. 只有擁有者可以在群組中觸發（WhatsApp）

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

擁有者由 `channels.whatsapp.allowFrom` 決定（未設定時使用機器人的自身 E.164）。請以單獨訊息送出指令。其他平台目前會忽略 `/activation`。 Send the command as a standalone message. Other surfaces currently ignore `/activation`.

## 情境欄位

群組的入站負載會設定：

- `ChatType=group`
- `GroupSubject`（若已知）
- `GroupMembers`（若已知）
- `WasMentioned`（提及管控結果）
- Telegram 論壇主題也會包含 `MessageThreadId` 與 `IsForum`。

The agent system prompt includes a group intro on the first turn of a new group session. It reminds the model to respond like a human, avoid Markdown tables, and avoid typing literal `\n` sequences.

## iMessage 特定事項

- 在路由或允許清單時，優先使用 `chat_id:<id>`。
- 列出聊天：`imsg chats --limit 20`。
- 群組回覆一律回到相同的 `chat_id`。

## WhatsApp 特定事項

WhatsApp 專屬行為（歷史注入、提及處理細節）請參閱 [Group messages](/channels/group-messages)。
