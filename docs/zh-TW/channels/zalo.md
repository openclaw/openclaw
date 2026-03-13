---
summary: "Zalo bot support status, capabilities, and configuration"
read_when:
  - Working on Zalo features or webhooks
title: Zalo
---

# Zalo (Bot API)

狀態：實驗性。支援私訊；群組處理可透過明確的群組政策控制來實現。

## 需要插件

Zalo 作為一個插件發佈，並不與核心安裝包捆綁在一起。

- 透過 CLI 安裝: `openclaw plugins install @openclaw/zalo`
- 或在入門時選擇 **Zalo** 並確認安裝提示
- 詳情: [Plugins](/tools/plugin)

## 快速設置（初學者）

1. 安裝 Zalo 插件：
   - 從源碼檢出：`openclaw plugins install ./extensions/zalo`
   - 從 npm（如果已發佈）：`openclaw plugins install @openclaw/zalo`
   - 或在入門時選擇 **Zalo** 並確認安裝提示
2. 設定 token：
   - 環境變數：`ZALO_BOT_TOKEN=...`
   - 或設定檔：`channels.zalo.botToken: "..."`。
3. 重新啟動網關（或完成入門）。
4. DM 存取預設為配對；在第一次聯絡時批准配對程式碼。

最小設定：

```json5
{
  channels: {
    zalo: {
      enabled: true,
      botToken: "12345689:abc-xyz",
      dmPolicy: "pairing",
    },
  },
}
```

## 這是什麼

Zalo 是一款專注於越南的即時通訊應用程式；其 Bot API 允許 Gateway 執行一個用於一對一對話的機器人。這非常適合用於支援或通知，當你希望能夠確定性地路由回 Zalo 時。

- 由 Gateway 擁有的 Zalo Bot API 通道。
- 確定性路由：回覆會返回 Zalo；模型不會選擇通道。
- 直接訊息（DMs）共享代理的主要會話。
- 群組支援政策控制 (`groupPolicy` + `groupAllowFrom`)，並預設為失敗關閉的允許清單行為。

## 設定 (快速路徑)

### 1) 創建機器人token (Zalo Bot 平台)

1. 前往 [https://bot.zaloplatforms.com](https://bot.zaloplatforms.com) 並登入。
2. 創建一個新的機器人並設定其設定。
3. 複製機器人 token（格式：`12345689:abc-xyz`）。

### 2) 設定 token（環境變數或設定檔）

[[BLOCK_1]]

```json5
{
  channels: {
    zalo: {
      enabled: true,
      botToken: "12345689:abc-xyz",
      dmPolicy: "pairing",
    },
  },
}
```

Env 選項: `ZALO_BOT_TOKEN=...`（僅適用於預設帳戶）。

多帳戶支援：使用 `channels.zalo.accounts` 搭配每個帳戶的 token 及可選的 `name`。

3. 重新啟動網關。當 token 被解析（環境變數或設定）時，Zalo 會啟動。
4. DM 存取預設為配對。當第一次聯絡機器人時，請批准程式碼。

## 如何運作（行為）

- 進入的訊息會被標準化為共享通道信封，並包含媒體佔位符。
- 回覆總是會路由回同一個 Zalo 聊天。
- 預設為長輪詢；可使用 `channels.zalo.webhookUrl` 的 webhook 模式。

## Limits

- 外發文本被分割為 2000 個字元（Zalo API 限制）。
- 媒體下載/上傳的上限為 `channels.zalo.mediaMaxMb`（預設為 5）。
- 由於 2000 字元的限制，串流預設被阻止，使得串流的實用性降低。

## 存取控制 (DMs)

### DM 存取

- 預設: `channels.zalo.dmPolicy = "pairing"`。未知的發送者會收到配對碼；在獲得批准之前，訊息會被忽略（碼在 1 小時後過期）。
- 批准方式：
  - `openclaw pairing list zalo`
  - `openclaw pairing approve zalo <CODE>`
- 配對是預設的 token 交換。詳細資訊: [配對](/channels/pairing)
- `channels.zalo.allowFrom` 接受數字用戶 ID（無法查找用戶名）。

## 存取控制 (群組)

- `channels.zalo.groupPolicy` 控制群組的進入處理：`open | allowlist | disabled`。
- 預設行為為失敗關閉：`allowlist`。
- `channels.zalo.groupAllowFrom` 限制哪些發送者 ID 可以在群組中觸發機器人。
- 如果 `groupAllowFrom` 未設定，Zalo 將回退到 `allowFrom` 進行發送者檢查。
- `groupPolicy: "disabled"` 阻擋所有群組訊息。
- `groupPolicy: "open"` 允許任何群組成員（需提及）。
- 執行時注意：如果 `channels.zalo` 完全缺失，執行時仍會回退到 `groupPolicy="allowlist"` 以確保安全。

## Long-polling 與 webhook

- 預設：長輪詢（不需要公開 URL）。
- Webhook 模式：設定 `channels.zalo.webhookUrl` 和 `channels.zalo.webhookSecret`。
  - Webhook 密鑰必須為 8-256 個字元。
  - Webhook URL 必須使用 HTTPS。
  - Zalo 透過 `X-Bot-Api-Secret-Token` 標頭發送事件以進行驗證。
  - Gateway HTTP 在 `channels.zalo.webhookPath` 處理 webhook 請求（預設為 webhook URL 路徑）。
  - 請求必須使用 `Content-Type: application/json`（或 `+json` 媒體類型）。
  - 重複事件 (`event_name + message_id`) 在短暫的重播窗口內會被忽略。
  - 突發流量會根據路徑/來源進行速率限制，可能會返回 HTTP 429。

**注意：** 根據 Zalo API 文件，getUpdates（輪詢）和 webhook 是互斥的。

## 支援的訊息類型

- **文字訊息**：完全支援 2000 字元分塊。
- **圖片訊息**：下載並處理進來的圖片；透過 `sendPhoto` 發送圖片。
- **貼圖**：已記錄但未完全處理（無代理回應）。
- **不支援的類型**：已記錄（例如，來自受保護用戶的訊息）。

## Capabilities

| 功能         | 狀態                                    |
| ------------ | --------------------------------------- |
| 直接訊息     | ✅ 支援                                 |
| 群組         | ⚠️ 支援，但有政策控制（預設為允許清單） |
| 媒體（圖片） | ✅ 支援                                 |
| 反應         | ❌ 不支援                               |
| 主題         | ❌ 不支援                               |
| 投票         | ❌ 不支援                               |
| 原生指令     | ❌ 不支援                               |
| 串流         | ⚠️ 被阻擋（2000 字元限制）              |

## 交付目標 (CLI/cron)

- 使用聊天 ID 作為目標。
- 範例：`openclaw message send --channel zalo --target 123456789 --message "hi"`。

## 故障排除

**Bot doesn't respond:**

- 檢查 token 是否有效：`openclaw channels status --probe`
- 驗證發送者是否已獲批准（配對或 allowFrom）
- 檢查閘道日誌：`openclaw logs --follow`

**Webhook 未接收事件：**

- 確保 webhook URL 使用 HTTPS
- 驗證密鑰 token 長度為 8-256 個字元
- 確認網關 HTTP 端點在設定的路徑上可達
- 檢查 getUpdates 輪詢是否未在執行（它們是互斥的）

## 設定參考 (Zalo)

完整設定: [Configuration](/gateway/configuration)

Provider options:

- `channels.zalo.enabled`: 啟用/禁用頻道啟動。
- `channels.zalo.botToken`: 來自 Zalo Bot Platform 的機器人 token。
- `channels.zalo.tokenFile`: 從常規檔案路徑讀取 token。符號連結會被拒絕。
- `channels.zalo.dmPolicy`: `pairing | allowlist | open | disabled`（預設值：配對）。
- `channels.zalo.allowFrom`: DM 允許清單（使用者 ID）。`open` 需要 `"*"`。精靈將要求輸入數字 ID。
- `channels.zalo.groupPolicy`: `open | allowlist | disabled`（預設值：允許清單）。
- `channels.zalo.groupAllowFrom`: 群組發送者允許清單（使用者 ID）。未設置時將回退到 `allowFrom`。
- `channels.zalo.mediaMaxMb`: 進入/外發媒體上限（MB，預設 5）。
- `channels.zalo.webhookUrl`: 啟用 webhook 模式（需要 HTTPS）。
- `channels.zalo.webhookSecret`: webhook 密鑰（8-256 字元）。
- `channels.zalo.webhookPath`: 網關 HTTP 伺服器上的 webhook 路徑。
- `channels.zalo.proxy`: API 請求的代理 URL。

[[BLOCK_1]]  
多帳戶選項：  
[[BLOCK_1]]

- `channels.zalo.accounts.<id>.botToken`: 每個帳戶的 token。
- `channels.zalo.accounts.<id>.tokenFile`: 每個帳戶的常規 token 檔案。符號連結會被拒絕。
- `channels.zalo.accounts.<id>.name`: 顯示名稱。
- `channels.zalo.accounts.<id>.enabled`: 啟用/停用帳戶。
- `channels.zalo.accounts.<id>.dmPolicy`: 每個帳戶的 DM 政策。
- `channels.zalo.accounts.<id>.allowFrom`: 每個帳戶的允許清單。
- `channels.zalo.accounts.<id>.groupPolicy`: 每個帳戶的群組政策。
- `channels.zalo.accounts.<id>.groupAllowFrom`: 每個帳戶的群組發送者允許清單。
- `channels.zalo.accounts.<id>.webhookUrl`: 每個帳戶的 webhook URL。
- `channels.zalo.accounts.<id>.webhookSecret`: 每個帳戶的 webhook 密鑰。
- `channels.zalo.accounts.<id>.webhookPath`: 每個帳戶的 webhook 路徑。
- `channels.zalo.accounts.<id>.proxy`: 每個帳戶的代理 URL。
