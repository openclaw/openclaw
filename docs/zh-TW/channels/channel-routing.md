---
summary: "每個頻道（WhatsApp、Telegram、Discord、Slack）的路由規則和共享上下文"
read_when:
  - 更改頻道路由或收件匣行為
title: "通道路由"
---

# 頻道與路由

OpenClaw 會將回覆訊息**路由回訊息來源的頻道**。
模型不會選擇頻道；路由是確定性的，由主機設定控制。

## 關鍵詞彙

- **頻道**：`whatsapp`、`telegram`、`discord`、`slack`、`signal`、`imessage`、`webchat`。
- **帳號 ID**：每個頻道的帳號實例（如果支援）。
- **智慧代理 ID**：一個隔離的工作區 + 工作階段儲存（「大腦」）。
- **工作階段鍵**：用於儲存上下文和控制併發的儲存鍵。

## 工作階段鍵的格式（範例）

私訊會收合至智慧代理的**主要**工作階段：

- `agent:<agentId>:<mainKey>`（預設值：`agent:main:main`）

群組和頻道在每個頻道中保持隔離：

- 群組：`agent:<agentId>:<channel>:group:<id>`
- 頻道/聊天室：`agent:<agentId>:<channel>:channel:<id>`

討論串：

- Slack/Discord 討論串會在基礎鍵後附加 `:thread:<threadId>`。
- Telegram 論壇主題會在群組鍵中嵌入 `:topic:<topicId>`。

範例：

- `agent:main:telegram:group:-1001234567890:topic:42`
- `agent:main:discord:channel:123456:thread:987654`

## 路由規則（如何選擇智慧代理）

路由會為每個傳入**訊息**選擇**一個智慧代理**：

1. **精確的對等匹配**（`bindings` 與 `peer.kind` + `peer.id`）。
2. **父級對等匹配**（討論串繼承）。
3. **公會 + 角色匹配**（Discord），透過 `guildId` + `roles`。
4. **公會匹配**（Discord），透過 `guildId`。
5. **團隊匹配**（Slack），透過 `teamId`。
6. **帳號匹配**（頻道上的 `accountId`）。
7. **頻道匹配**（該頻道上的任何帳號，`accountId: "*"`）。
8. **預設智慧代理**（`agents.list[].default`，否則為列表中的第一個項目，最終為 `main`）。

當綁定包含多個匹配欄位（`peer`、`guildId`、`teamId`、`roles`）時，**所有提供的欄位都必須匹配**該綁定才會生效。

匹配到的智慧代理會決定使用哪個工作區和工作階段儲存。

## 廣播群組（執行多個智慧代理）

廣播群組讓您可以為相同的對等方執行**多個智慧代理**，**當 OpenClaw 通常會回覆時**（例如：在 WhatsApp 群組中，在提及/啟動閘門之後）。

設定：

```json5
{
  broadcast: {
    strategy: "parallel",
    "120363403215116621 @g.us": ["alfred", "baerbel"],
    "+15555550123": ["support", "logger"],
  },
}
```

請參閱：[廣播群組](/channels/broadcast-groups)。

## 設定概覽

- `agents.list`：命名的智慧代理定義（工作區、模型等）。
- `bindings`：將傳入的頻道/帳號/對等方映射到智慧代理。

範例：

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

## 工作階段儲存

工作階段儲存位於狀態目錄下（預設 `~/.openclaw`）：

- `~/.openclaw/agents/<agentId>/sessions/sessions.json`
- JSONL 謄本與儲存並存

您可以透過 `session.store` 和 `{agentId}` 模板來覆寫儲存路徑。

## WebChat 行為

WebChat 會連接到**選定的智慧代理**，並預設為智慧代理的主要工作階段。
因此，WebChat 讓您可以在一個地方查看該智慧代理的跨頻道上下文。

## 回覆上下文

傳入的回覆包括：

- `ReplyToId`、`ReplyToBody` 和 `ReplyToSender`（如果可用）。
- 引用的上下文會以 `[回覆給 ...]` 區塊的形式附加到 `Body`。

這在所有頻道中都是一致的。
