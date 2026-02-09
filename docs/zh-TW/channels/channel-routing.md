---
summary: "各頻道（WhatsApp、Telegram、Discord、Slack）的路由規則與共用脈絡"
read_when:
  - 變更頻道路由或收件匣行為時
title: "頻道路由"
---

# 頻道與路由

40. OpenClaw 會將回覆**送回訊息來源的原頻道**。 The
    model does not choose a channel; routing is deterministic and controlled by the
    host configuration.

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

Threads:

- Slack／Discord 的執行緒會在基礎鍵後附加 `:thread:<threadId>`。
- Telegram 論壇主題會將 `:topic:<topicId>` 內嵌於群組鍵中。

範例：

- `agent:main:telegram:group:-1001234567890:topic:42`
- `agent:main:discord:channel:123456:thread:987654`

## 路由規則（如何選擇代理程式）

Routing picks **one agent** for each inbound message:

1. **精確對等匹配**（`bindings` 搭配 `peer.kind` + `peer.id`）。
2. **公會匹配**（Discord），透過 `guildId`。
3. **團隊匹配**（Slack），透過 `teamId`。
4. **帳戶匹配**（頻道上的 `accountId`）。
5. **頻道匹配**（該頻道上的任何帳戶）。
6. **預設代理程式**（`agents.list[].default`；否則取清單第一個，最後回退到 `main`）。

The matched agent determines which workspace and session store are used.

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
- `bindings`: map inbound channels/accounts/peers to agents.

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

## Session storage

Session stores live under the state directory (default `~/.openclaw`):

- `~/.openclaw/agents/<agentId>/sessions/sessions.json`
- JSONL transcripts live alongside the store

你可以透過 `session.store` 與 `{agentId}` 的樣板化來覆寫儲存路徑。

## WebChat 行為

WebChat attaches to the **selected agent** and defaults to the agent’s main
session. Because of this, WebChat lets you see cross‑channel context for that
agent in one place.

## Reply context

入站回覆包含：

- 可用時包含 `ReplyToId`、`ReplyToBody` 與 `ReplyToSender`。
- 被引用的脈絡會以 `[Replying to ...]` 區塊的形式附加到 `Body`。

此行為在各頻道間保持一致。
