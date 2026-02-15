---
summary: "配對概述：批准誰可以私訊您 + 哪些節點可以加入"
read_when:
  - 設定私訊存取控制
  - 配對新的 iOS/Android 節點
  - 檢閱 OpenClaw 安全狀況
title: "配對"
---

# 配對

「配對」是 OpenClaw 明確的**擁有者批准**步驟。
它用於兩個地方：

1. **私訊配對**（誰獲允許與機器人對話）
2. **節點配對**（哪些裝置/節點獲允許加入 Gateway 網路）

安全情境：[Security](/gateway/security)

## 1) 私訊配對 (入站聊天存取)

當頻道設定為私訊政策 `pairing` 時，未知寄件者會獲得一個簡短的代碼，並且他們的訊息在您批准之前**不會被處理**。

預設的私訊政策記錄於：[Security](/gateway/security)

配對代碼：

- 8 個字元，大寫，不含模糊字元 (`0O1I`)。
- **1 小時後過期**。機器人僅在建立新請求時傳送配對訊息（大約每個寄件者每小時一次）。
- 待處理的私訊配對請求預設**每個頻道限制 3 個**；在其中一個過期或被批准之前，額外請求將被忽略。

### 批准寄件者

```bash
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

支援的頻道：`telegram`、`whatsapp`、`signal`、`imessage`、`discord`、`slack`、`feishu`。

### 狀態儲存位置

儲存在 `~/.openclaw/credentials/` 下：

- 待處理請求：`<channel>-pairing.json`
- 批准的允許清單儲存：`<channel>-allowFrom.json`

請將這些視為敏感資訊（它們控管著您助手的存取權）。

## 2) 節點裝置配對 (iOS/Android/macOS/無頭節點)

節點以 `role: node` 的**裝置**身分連接到 Gateway。Gateway 會建立一個必須批准的裝置配對請求。

### 透過 Telegram 配對 (建議用於 iOS)

如果您使用 `device-pair` 插件，您可以完全透過 Telegram 進行首次裝置配對：

1. 在 Telegram 中，向您的機器人傳送訊息：`/pair`
2. 機器人會回覆兩條訊息：一條說明訊息和一條單獨的**設定代碼**訊息（在 Telegram 中易於複製/貼上）。
3. 在您的手機上，開啟 OpenClaw iOS 應用程式 → 設定 → Gateway。
4. 貼上設定代碼並連接。
5. 返回 Telegram：`/pair approve`

設定代碼是一個 base64 編碼的 JSON 酬載，包含：

- `url`：Gateway WebSocket URL (`ws://...` 或 `wss://...`)
- `token`：一個短期有效的配對令牌

在設定代碼有效期間，請像對待密碼一樣對待它。

### 批准節點裝置

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
```

### 節點配對狀態儲存

儲存在 `~/.openclaw/devices/` 下：

- `pending.json` (短期有效；待處理請求會過期)
- `paired.json` (已配對裝置 + 令牌)

### 注意事項

- 舊版 `node.pair.*` API (CLI: `openclaw nodes pending/approve`) 是獨立於 Gateway 擁有的配對儲存。WS 節點仍然需要裝置配對。

## 相關文件

- 安全模型 + 提示注入：[Security](/gateway/security)
- 安全更新（執行 doctor）：[Updating](/install/updating)
- 頻道設定：
  - Telegram：[Telegram](/channels/telegram)
  - WhatsApp：[WhatsApp](/channels/whatsapp)
  - Signal：[Signal](/channels/signal)
  - BlueBubbles (iMessage)：[BlueBubbles](/channels/bluebubbles)
  - iMessage (舊版)：[iMessage](/channels/imessage)
  - Discord：[Discord](/channels/discord)
  - Slack：[Slack](/channels/slack)
