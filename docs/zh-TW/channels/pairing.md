---
summary: "Pairing overview: approve who can DM you + which nodes can join"
read_when:
  - Setting up DM access control
  - 配對新的 iOS / Android 節點
  - 檢視 OpenClaw 的安全性狀態
title: "Pairing"
---

# Pairing

「配對」是 OpenClaw 明確的 **擁有者核准** 步驟。
它用於兩個地方：
It is used in two places:

1. **DM pairing** (who is allowed to talk to the bot)
2. **Node pairing** (which devices/nodes are allowed to join the gateway network)

安全性背景： [Security](/gateway/security)

## 1. 私訊配對（入站聊天存取）

When a channel is configured with DM policy `pairing`, unknown senders get a short code and their message is **not processed** until you approve.

Default DM policies are documented in: [Security](/gateway/security)

配對碼：

- 8 個字元，全大寫，無易混淆字元（`0O1I`）。
- **Expire after 1 hour**. The bot only sends the pairing message when a new request is created (roughly once per hour per sender).
- Pending DM pairing requests are capped at **3 per channel** by default; additional requests are ignored until one expires or is approved.

### Approve a sender

```bash
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

支援的頻道： `telegram`、`whatsapp`、`signal`、`imessage`、`discord`、`slack`。

### Where the state lives

儲存在 `~/.openclaw/credentials/` 之下：

- 待處理請求： `<channel>-pairing.json`
- 已核准的允許清單儲存區： `<channel>-allowFrom.json`

Treat these as sensitive (they gate access to your assistant).

## 2. 節點裝置配對（iOS / Android / macOS / 無介面節點）

節點會以 **裝置** 的形式連線到 Gateway 閘道器，並使用 `role: node`。Gateway 閘道器
會建立一個裝置配對請求，必須先被核准。 The Gateway
creates a device pairing request that must be approved.

### Approve a node device

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
```

### Node pairing state storage

儲存在 `~/.openclaw/devices/` 之下：

- `pending.json`（短期存在；待處理請求會到期）
- `paired.json`（已配對的裝置與權杖）

### 注意事項

- 舊版的 `node.pair.*` API（CLI： `openclaw nodes pending/approve`）是
  一個獨立、由 Gateway 閘道器 擁有的配對儲存區。WS 節點仍然需要進行裝置配對。 1. WS 節點仍然需要裝置配對。

## 2. 相關文件

- 安全性模型與提示注入： [Security](/gateway/security)
- 安全更新（執行 doctor）： [Updating](/install/updating)
- 頻道設定：
  - Telegram： [Telegram](/channels/telegram)
  - WhatsApp： [WhatsApp](/channels/whatsapp)
  - Signal： [Signal](/channels/signal)
  - BlueBubbles（iMessage）： [BlueBubbles](/channels/bluebubbles)
  - iMessage（舊版）： [iMessage](/channels/imessage)
  - Discord： [Discord](/channels/discord)
  - Slack： [Slack](/channels/slack)
