---
summary: "Pairing overview: approve who can DM you + which nodes can join"
read_when:
  - Setting up DM access control
  - Pairing a new iOS/Android node
  - Reviewing OpenClaw security posture
title: Pairing
---

# Pairing

“配對”是 OpenClaw 的明確 **擁有者批准** 步驟。  
它在兩個地方使用：

1. **DM 配對**（誰被允許與機器人對話）
2. **節點配對**（哪些設備/節點被允許加入閘道網路）

安全上下文: [安全性](/gateway/security)

## 1) DM 配對（進入聊天存取）

當頻道設定了 DM 政策 `pairing` 時，未知發送者會獲得一個短碼，他們的訊息在您批准之前**不會被處理**。

預設的 DM 政策已在以下位置記錄：[Security](/gateway/security)

[[BLOCK_1]]  
配對程式碼：  
[[BLOCK_1]]

- 8 個字元，大寫，無模糊字元 (`0O1I`)。
- **在 1 小時後過期**。機器人僅在創建新請求時發送配對訊息（大約每小時每個發送者一次）。
- 每個頻道的待處理 DM 配對請求預設上限為 **3 個**；額外的請求將被忽略，直到其中一個過期或被批准。

### 批准發件人

```bash
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

Supported channels: `telegram`, `whatsapp`, `signal`, `imessage`, `discord`, `slack`, `feishu`.

### 狀態的所在

`~/.openclaw/credentials/`

- 待處理請求: `<channel>-pairing.json`
- 已批准的允許清單儲存:
  - 預設帳戶: `<channel>-allowFrom.json`
  - 非預設帳戶: `<channel>-<accountId>-allowFrom.json`

[[BLOCK_1]]  
帳戶範圍行為：  
[[BLOCK_1]]

- 非預設帳戶僅讀取/寫入其範圍內的允許清單檔案。
- 預設帳戶使用通道範圍的未範圍允許清單檔案。

[[BLOCK_1]]

## 2) 節點設備配對 (iOS/Android/macOS/無頭節點)

節點作為 **設備** 透過 `role: node` 連接到閘道器。閘道器會創建一個設備配對請求，該請求必須獲得批准。

### 透過 Telegram 配對（建議用於 iOS）

如果您使用 `device-pair` 插件，您可以完全透過 Telegram 進行首次設備配對：

1. 在 Telegram 中，發送訊息給你的機器人：`/pair`
2. 機器人會回覆兩條訊息：一條指示訊息和一條單獨的 **設定程式碼** 訊息（方便在 Telegram 中複製/貼上）。
3. 在你的手機上，打開 OpenClaw iOS 應用程式 → 設定 → 閘道。
4. 貼上設定程式碼並連接。
5. 回到 Telegram：`/pair approve`

該設置程式碼是一個 base64 編碼的 JSON 負載，包含：

- `url`: 閘道器 WebSocket URL (`ws://...` 或 `wss://...`)
- `bootstrapToken`: 用於初始配對握手的短期單設備啟動 token

將設置程式碼視為有效期間內的密碼。

### 批准一個節點設備

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
```

### Node 配對狀態儲存

`~/.openclaw/devices/`

- `pending.json` (短期有效；待處理請求會過期)
- `paired.json` (配對設備 + token)

### Notes

- 遺留的 `node.pair.*` API (CLI: `openclaw nodes pending/approve`) 是一個由網關擁有的獨立配對儲存庫。WS 節點仍然需要設備配對。

## 相關文件

- 安全模型 + 提示注入: [安全性](/gateway/security)
- 安全更新 (執行 doctor): [更新](/install/updating)
- 頻道設定:
  - Telegram: [Telegram](/channels/telegram)
  - WhatsApp: [WhatsApp](/channels/whatsapp)
  - Signal: [Signal](/channels/signal)
  - BlueBubbles (iMessage): [BlueBubbles](/channels/bluebubbles)
  - iMessage (舊版): [iMessage](/channels/imessage)
  - Discord: [Discord](/channels/discord)
  - Slack: [Slack](/channels/slack)
