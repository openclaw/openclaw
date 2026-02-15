---
summary: "配對概覽：核准誰可以私訊您以及哪些節點可以加入"
read_when:
  - 設定私訊存取控制
  - 配對新的 iOS/Android 節點
  - 審查 OpenClaw 安全狀況
title: "配對"
---

# 配對

「配對」是 OpenClaw 的明確 **所有者核准** 步驟。
它用於兩個地方：

1. **私訊配對**（誰被允許與機器人對話）
2. **節點配對**（哪些裝置/節點被允許加入 Gateway 網路）

安全上下文：[Security](/gateway/security)

## 1) 私訊配對（入站聊天存取權）

當頻道設定了私訊策略 `pairing` 時，未知的傳送者會收到一個簡短代碼，在您核准之前，他們的訊息**不會被處理**。

預設的私訊策略文件請參閱：[Security](/gateway/security)

配對代碼：

- 8 個字元，大寫，無歧義字元 (`0O1I`)。
- **1 小時後過期**。機器人僅在建立新請求時發送配對訊息（每個傳送者大約每小時一次）。
- 待處理的私訊配對請求預設上限為 **每個頻道 3 個**；在其中一個過期或被核准之前，額外的請求將被忽略。

### 核准傳送者

```bash
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

支援的頻道：`telegram`, `whatsapp`, `signal`, `imessage`, `discord`, `slack`, `feishu`。

### 狀態儲存位置

儲存在 `~/.openclaw/credentials/` 下：

- 待處理請求：`<channel>-pairing.json`
- 已核准的允許列表儲存空間：`<channel>-allowFrom.json`

請將這些檔案視為敏感資訊（它們控制著智慧代理的存取權限）。

## 2) 節點裝置配對 (iOS/Android/macOS/headless 節點)

節點以 `role: node` 的 **裝置** 身份連線至 Gateway。Gateway 會建立一個必須經過核准的裝置配對請求。

### 透過 Telegram 配對（iOS 推薦方式）

如果您使用 `device-pair` 外掛程式，您可以完全從 Telegram 進行首次裝置配對：

1. 在 Telegram 中，傳送訊息給您的機器人：`/pair`
2. 機器人會回覆兩則訊息：一則指令訊息和一則獨立的 **設定代碼 (setup code)** 訊息（便於在 Telegram 中複製/貼上）。
3. 在您的手機上，開啟 OpenClaw iOS App → Settings → Gateway。
4. 貼上設定代碼並連線。
5. 回到 Telegram：`/pair approve`

設定代碼是一個 base64 編碼的 JSON 負載，包含：

- `url`: Gateway WebSocket URL (`ws://...` 或 `wss://...`)
- `token`: 一個短效的配對權杖 (token)

在設定代碼有效期間，請將其視為密碼。

### 核准節點裝置

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
```

### 節點配對狀態儲存

儲存在 `~/.openclaw/devices/` 下：

- `pending.json`（短效；待處理請求會過期）
- `paired.json`（已配對裝置 + 權杖）

### 注意事項

- 舊有的 `node.pair.*` API（CLI: `openclaw nodes pending/approve`）是一個獨立的 Gateway 自有配對儲存空間。WS 節點仍需要進行裝置配對。

## 相關文件

- 安全模型 + 提示詞注入：[Security](/gateway/security)
- 安全更新（執行 doctor）：[Updating](/install/updating)
- 頻道設定：
  - Telegram: [Telegram](/channels/telegram)
  - WhatsApp: [WhatsApp](/channels/whatsapp)
  - Signal: [Signal](/channels/signal)
  - BlueBubbles (iMessage): [BlueBubbles](/channels/bluebubbles)
  - iMessage (舊版): [iMessage](/channels/imessage)
  - Discord: [Discord](/channels/discord)
  - Slack: [Slack](/channels/slack)
