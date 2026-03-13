---
summary: >-
  Routing rules per channel (WhatsApp, Telegram, Discord, Slack) and shared
  context
read_when:
  - Changing channel routing or inbox behavior
title: Channel Routing
---

# Channels & routing

OpenClaw 將回覆 **發送回消息來源的頻道**。該模型不會選擇頻道；路由是確定性的，並由主機設定控制。

## 重要術語

- **Channel**: `whatsapp`, `telegram`, `discord`, `slack`, `signal`, `imessage`, `webchat`。
- **AccountId**: 每個通道的帳戶實例（當支援時）。
- 可選的通道預設帳戶：`channels.<channel>.defaultAccount` 選擇在未指定 `accountId` 的外發路徑時使用哪個帳戶。
  - 在多帳戶設置中，當設定兩個或更多帳戶時，設置明確的預設值 (`defaultAccount` 或 `accounts.default`)。如果沒有，回退路由可能會選擇第一個標準化的帳戶 ID。
- **AgentId**: 一個獨立的工作區 + 會話存儲（“大腦”）。
- **SessionKey**: 用於存儲上下文和控制併發的桶鍵。

## Session key shapes (examples)

直接訊息會折疊到代理的 **主要** 會話：

- `agent:<agentId>:<mainKey>` (預設值: `agent:main:main`)

群組和頻道在每個頻道中保持隔離：

- 群組: `agent:<agentId>:<channel>:group:<id>`
- 頻道/房間: `agent:<agentId>:<channel>:channel:<id>`

Threads:

- Slack/Discord 的主題會將 `:thread:<threadId>` 附加到基本鍵。
- Telegram 論壇主題會在群組鍵中嵌入 `:topic:<topicId>`。

範例：

- `agent:main:telegram:group:-1001234567890:topic:42`
- `agent:main:discord:channel:123456:thread:987654`

## Main DM 路由釘選

當 `session.dmScope` 為 `main` 時，直接訊息可能會共享一個主要會話。為了防止會話的 `lastRoute` 被非擁有者的直接訊息覆蓋，OpenClaw 會從 `allowFrom` 推斷出一個固定的擁有者，當以下所有條件都成立時：

- `allowFrom` 只有一個非通配符的條目。
- 該條目可以被標準化為該頻道的具體發送者 ID。
- 進來的 DM 發送者與該固定擁有者不匹配。

在那個不匹配的情況下，OpenClaw 仍然會記錄進入的會話元數據，但會跳過更新主要會話 `lastRoute`。

## 路由規則（如何選擇代理）

Routing picks **one agent** for each inbound message:

1. **精確對等匹配** (`bindings` 與 `peer.kind` + `peer.id`)。
2. **父級對等匹配**（執行緒繼承）。
3. **公會 + 角色匹配**（Discord）透過 `guildId` + `roles`。
4. **公會匹配**（Discord）透過 `guildId`。
5. **團隊匹配**（Slack）透過 `teamId`。
6. **帳戶匹配**（在頻道上的 `accountId`）。
7. **頻道匹配**（該頻道上的任何帳戶，`accountId: "*"`）。
8. **預設代理** (`agents.list[].default`，否則為第一個列表專案，回退至 `main`）。

當一個綁定包含多個匹配欄位 (`peer`, `guildId`, `teamId`, `roles`) 時，**所有提供的欄位必須匹配**，該綁定才能生效。

匹配的代理會決定使用哪個工作區和會話存儲。

## 廣播群組（執行多個代理）

廣播群組讓你在 OpenClaw 通常會回覆的情況下（例如：在 WhatsApp 群組中，提及/啟動閘道後）執行 **多個代理**。

Config:

```json5
{
  broadcast: {
    strategy: "parallel",
    "120363403215116621@g.us": ["alfred", "baerbel"],
    "+15555550123": ["support", "logger"],
  },
}
```

請參閱：[Broadcast Groups](/channels/broadcast-groups)。

## Config 概述

- `agents.list`: 命名代理定義（工作區、模型等）。
- `bindings`: 將進入的通道/帳戶/對等方映射到代理。

[[BLOCK_1]]  
範例：  
[[BLOCK_1]]

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

## Session storage

Session 存儲位於狀態目錄下（預設 `~/.openclaw`）：

- `~/.openclaw/agents/<agentId>/sessions/sessions.json`
- JSONL 轉錄檔與商店並存

您可以透過 `session.store` 和 `{agentId}` 模板來覆蓋儲存路徑。

Gateway 和 ACP 會話發現也會掃描位於預設 `agents/` 根目錄下以及模板化 `session.store` 根目錄下的磁碟支援代理儲存區。發現的儲存區必須保持在解析的代理根目錄內，並使用常規 `sessions.json` 檔案。符號連結和超出根目錄的路徑將被忽略。

## WebChat 行為

WebChat 會連接到 **選定的代理**，並預設使用該代理的主要會話。因此，WebChat 讓您可以在一個地方查看該代理的跨通道上下文。

## Reply context

[[BLOCK_1]]  
進來的回覆包括：  
[[BLOCK_1]]

- `ReplyToId`, `ReplyToBody` 和 `ReplyToSender` 當可用時。
- 引用的內容會附加到 `Body` 作為 `[Replying to ...]` 區塊。

這在各個渠道中是一致的。
