---
summary: "每個頻道（WhatsApp、Telegram、Discord、Slack）的路由規則與共享上下文"
read_when:
  - 更改頻道路由或收件匣行為時
title: "頻道路由"
---

# 頻道與路由

OpenClaw 會將回覆路由**回傳至訊息來源的頻道**。模型不會選擇頻道；路由是確定性的，並由主機設定控制。

## 關鍵術語

- **頻道 (Channel)**：`whatsapp`、`telegram`、`discord`、`slack`、`signal`、`imessage`、`webchat`。
- **AccountId**：每個頻道的帳戶實例（支援時）。
- **AgentId**：一個隔離的工作空間 + 工作階段儲存空間（「大腦」）。
- **SessionKey**：用於儲存上下文並控制並行處理的 bucket key。

## 工作階段金鑰結構（範例）

私訊會收合至智慧代理的**主**工作階段：

- `agent:<agentId>:<mainKey>`（預設：`agent:main:main`）

群組與頻道在每個頻道中保持隔離：

- 群組：`agent:<agentId>:<channel>:group:<id>`
- 頻道/聊天室：`agent:<agentId>:<channel>:channel:<id>`

執行緒 (Threads)：

- Slack/Discord 執行緒會在基本金鑰後附加 `:thread:<threadId>`。
- Telegram 論壇主題會在群組金鑰中嵌入 `:topic:<topicId>`。

範例：

- `agent:main:telegram:group:-1001234567890:topic:42`
- `agent:main:discord:channel:123456:thread:987654`

## 路由規則（如何選擇智慧代理）

路由會為每則傳入訊息挑選**一個智慧代理**：

1. **精確同儕節點匹配**（具備 `peer.kind` + `peer.id` 的 `bindings`）。
2. **父級同儕節點匹配**（執行緒繼承）。
3. **伺服器 (Guild) + 身分組匹配** (Discord)，透過 `guildId` + `roles`。
4. **伺服器匹配** (Discord)，透過 `guildId`。
5. **團隊匹配** (Slack)，透過 `teamId`。
6. **帳戶匹配**（頻道上的 `accountId`）。
7. **頻道匹配**（該頻道上的任何帳戶，`accountId: "*"`）。
8. **預設智慧代理**（`agents.list[].default`，否則為清單第一個項目，備案為 `main`）。

當 binding 包含多個匹配欄位（`peer`、`guildId`、`teamId`、`roles`）時，**所有提供的欄位都必須匹配**，該 binding 才會生效。

匹配的智慧代理決定使用哪個工作空間與工作階段儲存空間。

## 廣播群組（執行多個智慧代理）

廣播群組讓你在 **OpenClaw 正常回覆時**（例如：在 WhatsApp 群組中，經過標記/啟用門檻後），為同一個同儕節點執行**多個智慧代理**。

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

- `agents.list`：具名的智慧代理定義（工作空間、模型等）。
- `bindings`：將傳入的頻道/帳戶/同儕節點對應至智慧代理。

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

工作階段儲存空間位於狀態目錄下（預設為 `~/.openclaw`）：

- `~/.openclaw/agents/<agentId>/sessions/sessions.json`
- JSONL 對話紀錄與儲存空間並存

你可以透過 `session.store` 與 `{agentId}` 模板來覆寫儲存路徑。

## WebChat 行為

WebChat 會附加到**選定的智慧代理**，並預設為該智慧代理的主工作階段。因此，WebChat 讓你在一個地方就能查看該智慧代理的跨頻道上下文。

## 回覆上下文

傳入的回覆包含：

- 可用時包含 `ReplyToId`、`ReplyToBody` 與 `ReplyToSender`。
- 引用內容會以 `[Replying to ...]` 區塊附加到 `Body`。

這在各個頻道中都是一致的。
