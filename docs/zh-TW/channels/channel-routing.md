---
summary: 「各頻道（WhatsApp、Telegram、Discord、Slack）的路由規則與共用脈絡」
read_when:
  - 變更頻道路由或收件匣行為時
title: 「頻道路由」
x-i18n:
  source_path: channels/channel-routing.md
  source_hash: cfc2cade2984225d
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:26:52Z
---

# 頻道與路由

OpenClaw 會將回覆**送回訊息來源的頻道**。模型不會選擇頻道；路由是確定性的，並由主機設定所控制。

## 關鍵術語

- **Channel**：`whatsapp`、`telegram`、`discord`、`slack`、`signal`、`imessage`、`webchat`。
- **AccountId**：每個頻道的帳戶實例（若支援）。
- **AgentId**：隔離的工作區 + 工作階段儲存（「大腦」）。
- **SessionKey**：用於儲存脈絡並控制併發的桶鍵。

## 工作階段鍵的形狀（範例）

私訊會合併到代理程式的**主要**工作階段：

- `agent:<agentId>:<mainKey>`（預設：`agent:main:main`）

群組與頻道會依頻道各自隔離：

- 群組：`agent:<agentId>:<channel>:group:<id>`
- 頻道／房間：`agent:<agentId>:<channel>:channel:<id>`

執行緒：

- Slack／Discord 的執行緒會在基礎鍵後附加 `:thread:<threadId>`。
- Telegram 論壇主題會將 `:topic:<topicId>` 內嵌於群組鍵中。

範例：

- `agent:main:telegram:group:-1001234567890:topic:42`
- `agent:main:discord:channel:123456:thread:987654`

## 路由規則（如何選擇代理程式）

路由會為每則入站訊息選擇**一個代理程式**：

1. **精確對等匹配**（`bindings` 搭配 `peer.kind` + `peer.id`）。
2. **公會匹配**（Discord），透過 `guildId`。
3. **團隊匹配**（Slack），透過 `teamId`。
4. **帳戶匹配**（頻道上的 `accountId`）。
5. **頻道匹配**（該頻道上的任何帳戶）。
6. **預設代理程式**（`agents.list[].default`；否則取清單第一個，最後回退到 `main`）。

匹配到的代理程式會決定使用哪個工作區與工作階段儲存。

## 廣播群組（執行多個代理程式）

廣播群組可讓你在 **OpenClaw 通常會回覆** 的情況下，為同一對等端點執行**多個代理程式**（例如：在 WhatsApp 群組中，於提及／啟用閘門之後）。

設定：

```json5
{
  broadcast: {
    strategy: "parallel",
    "120363403215116621@g.us": ["alfred", "baerbel"],
    "+15555550123": ["support", "logger"],
  },
}
```

參見：[Broadcast Groups](/channels/broadcast-groups)。

## 設定概覽

- `agents.list`：具名的代理程式定義（工作區、模型等）。
- `bindings`：將入站頻道／帳戶／對等端點對應到代理程式。

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

工作階段儲存在狀態目錄之下（預設為 `~/.openclaw`）：

- `~/.openclaw/agents/<agentId>/sessions/sessions.json`
- JSONL 逐行記錄與儲存並列存在

你可以透過 `session.store` 與 `{agentId}` 的樣板化來覆寫儲存路徑。

## WebChat 行為

WebChat 會連接到**所選代理程式**，並預設使用該代理程式的主要工作階段。因此，WebChat 讓你能在同一處查看該代理程式的跨頻道脈絡。

## 回覆脈絡

入站回覆包含：

- 可用時包含 `ReplyToId`、`ReplyToBody` 與 `ReplyToSender`。
- 被引用的脈絡會以 `[Replying to ...]` 區塊的形式附加到 `Body`。

此行為在各頻道間保持一致。
