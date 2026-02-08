---
summary: 「配對概覽：核准誰可以私訊你，以及哪些節點可以加入」
read_when:
  - 設定私訊存取控制
  - 配對新的 iOS / Android 節點
  - 檢視 OpenClaw 的安全性狀態
title: 「配對」
x-i18n:
  source_path: channels/pairing.md
  source_hash: cc6ce9c71db6d96d
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:27:03Z
---

# 配對

「配對」是 OpenClaw 明確的 **擁有者核准** 步驟。
它用於兩個地方：

1. **私訊配對**（允許誰可以與機器人對話）
2. **節點配對**（允許哪些裝置／節點加入 Gateway 閘道器 網路）

安全性背景： [Security](/gateway/security)

## 1) 私訊配對（入站聊天存取）

當頻道設定為私訊政策 `pairing` 時，未知的寄件者會收到一個短碼，而其訊息在你核准之前 **不會被處理**。

預設的私訊政策文件請參閱： [Security](/gateway/security)

配對碼：

- 8 個字元，全大寫，無易混淆字元（`0O1I`）。
- **1 小時後到期**。機器人只會在建立新的請求時送出配對訊息（大約每位寄件者每小時一次）。
- 進行中的私訊配對請求，預設每個頻道上限為 **3 個**；在其中一個到期或被核准之前，額外的請求會被忽略。

### 核准寄件者

```bash
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

支援的頻道： `telegram`、`whatsapp`、`signal`、`imessage`、`discord`、`slack`。

### 狀態存放位置

儲存在 `~/.openclaw/credentials/` 之下：

- 待處理請求： `<channel>-pairing.json`
- 已核准的允許清單儲存區： `<channel>-allowFrom.json`

請將這些視為敏感資料（它們控制對你的助理的存取）。

## 2) 節點裝置配對（iOS / Android / macOS / 無介面節點）

節點會以 **裝置** 的形式連線到 Gateway 閘道器，並使用 `role: node`。Gateway 閘道器
會建立一個裝置配對請求，必須先被核准。

### 核准節點裝置

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
```

### 節點配對狀態儲存

儲存在 `~/.openclaw/devices/` 之下：

- `pending.json`（短期存在；待處理請求會到期）
- `paired.json`（已配對的裝置與權杖）

### 注意事項

- 舊版的 `node.pair.*` API（CLI： `openclaw nodes pending/approve`）是
  一個獨立、由 Gateway 閘道器 擁有的配對儲存區。WS 節點仍然需要進行裝置配對。

## 相關文件

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
