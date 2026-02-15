---
summary: "Zalo 機器人支援狀態、功能與設定"
read_when:
  - 處理 Zalo 功能或 webhook 時
title: "Zalo"
---

# Zalo (Bot API)

狀態：實驗性。僅限私訊；根據 Zalo 文件，群組功能即將推出。

## 需要外掛程式

Zalo 以外掛程式形式提供，未包含在核心安裝包中。

- 透過 CLI 安裝：`openclaw plugins install @openclaw/zalo`
- 或在新手導覽期間選擇 **Zalo** 並確認安裝提示
- 詳情：[Plugins](/tools/plugin)

## 快速開始 (初學者)

1. 安裝 Zalo 外掛程式：
   - 從原始碼安裝：`openclaw plugins install ./extensions/zalo`
   - 從 npm 安裝（若已發佈）：`openclaw plugins install @openclaw/zalo`
   - 或在新手導覽中選擇 **Zalo** 並確認安裝提示
2. 設定權杖 (Token)：
   - 環境變數：`ZALO_BOT_TOKEN=...`
   - 或設定：`channels.zalo.botToken: "..."`。
3. 重新啟動 Gateway（或完成新手導覽）。
4. 私訊存取預設為配對模式；在首次接觸時核准配對碼。

最小設定範例：

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

## 功能簡介

Zalo 是一款針對越南市場的通訊應用程式；其 Bot API 讓 Gateway 能運作一個機器人進行 1:1 對話。它非常適合用於需要確定性路由回到 Zalo 的支援或通知場景。

- 由 Gateway 擁有的 Zalo Bot API 頻道。
- 確定性路由：回覆會傳回 Zalo；模型絕不會自行選擇頻道。
- 私訊共享智慧代理的主工作階段。
- 尚未支援群組（Zalo 文件指出「即將推出」）。

## 設定 (快速路徑)

### 1) 建立機器人權杖 (Zalo Bot Platform)

1. 前往 [https://bot.zaloplatforms.com](https://bot.zaloplatforms.com) 並登入。
2. 建立新的機器人並調整其設定。
3. 複製機器人權杖（格式：`12345689:abc-xyz`）。

### 2) 設定權杖（環境變數或設定檔案）

範例：

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

環境變數選項：`ZALO_BOT_TOKEN=...`（僅適用於預設帳號）。

多帳號支援：使用 `channels.zalo.accounts` 為每個帳號設定權杖及選用的 `name`。

3. 重新啟動 Gateway。當權杖解析成功時（環境變數或設定），Zalo 就會啟動。
4. 私訊存取預設為配對。當機器人首次被聯絡時，核准該驗證碼。

## 運作方式 (行為)

- 傳入的訊息會被正規化為帶有媒體佔位符的共享頻道封包。
- 回覆始終會路由回同一個 Zalo 聊天視窗。
- 預設使用長輪詢 (Long-polling)；可透過 `channels.zalo.webhookUrl` 使用 webhook 模式。

## 限制

- 傳出文字會被切分為 2000 個字元（Zalo API 限制）。
- 媒體下載/上傳上限由 `channels.zalo.mediaMaxMb` 設定（預設為 5 MB）。
- 由於 2000 字元的限制使得串流傳輸作用不大，因此預設情況下會阻斷區塊串流傳輸。

## 存取控制 (私訊)

### 私訊存取

- 預設值：`channels.zalo.dmPolicy = "pairing"`。未知傳送者會收到配對碼；訊息在核准前會被忽略（配對碼 1 小時後過期）。
- 透過以下方式核准：
  - `openclaw pairing list zalo`
  - `openclaw pairing approve zalo <CODE>`
- 配對是預設的權杖交換方式。詳情：[Pairing](/channels/pairing)
- `channels.zalo.allowFrom` 接受數值形式的使用者 ID（無法查詢使用者名稱）。

## 長輪詢 vs Webhook

- 預設：長輪詢（不需要公開 URL）。
- Webhook 模式：設定 `channels.zalo.webhookUrl` 和 `channels.zalo.webhookSecret`。
  - Webhook 密鑰長度必須介於 8 到 256 個字元之間。
  - Webhook URL 必須使用 HTTPS。
  - Zalo 傳送事件時會附帶 `X-Bot-Api-Secret-Token` 標頭以供驗證。
  - Gateway HTTP 在 `channels.zalo.webhookPath` 處理 webhook 請求（預設為 webhook URL 的路徑）。

**注意：** 根據 Zalo API 文件，getUpdates（輪詢）與 webhook 是互斥的。

## 支援的訊息類型

- **文字訊息**：完全支援，並具備 2000 字元切分功能。
- **圖片訊息**：下載並處理傳入的圖片；透過 `sendPhoto` 傳送圖片。
- **貼圖**：會記錄但未完全處理（智慧代理不會回覆）。
- **不支援的類型**：會記錄（例如：來自受保護使用者的訊息）。

## 功能清單

| 功能             | 狀態                         |
| ---------------- | ---------------------------- |
| 私訊             | ✅ 支援                      |
| 群組             | ❌ 即將推出 (根據 Zalo 文件) |
| 媒體 (圖片)      | ✅ 支援                      |
| 回應 (Reactions) | ❌ 不支援                    |
| 討論串 (Threads) | ❌ 不支援                    |
| 投票 (Polls)     | ❌ 不支援                    |
| 原生指令         | ❌ 不支援                    |
| 區塊串流傳輸     | ⚠️ 已阻斷 (2000 字元限制)    |

## 傳送目標 (CLI/cron)

- 使用聊天 ID 作為目標。
- 範例：`openclaw message send --channel zalo --target 123456789 --message "hi"`。

## 疑難排解

**機器人沒有回應：**

- 檢查權杖是否有效：`openclaw channels status --probe`
- 驗證傳送者是否已核准（配對或 allowFrom）
- 檢查 Gateway 記錄：`openclaw logs --follow`

**Webhook 未接收到事件：**

- 確保 webhook URL 使用 HTTPS
- 驗證密鑰權杖為 8 到 256 個字元
- 確認 Gateway HTTP 端點在設定的路徑上可供存取
- 檢查 getUpdates 輪詢是否未在執行（兩者互斥）

## 設定參考 (Zalo)

完整設定：[Configuration](/gateway/configuration)

供應商選項：

- `channels.zalo.enabled`: 啟用/停用頻道啟動。
- `channels.zalo.botToken`: 來自 Zalo Bot Platform 的機器人權杖。
- `channels.zalo.tokenFile`: 從檔案路徑讀取權杖。
- `channels.zalo.dmPolicy`: `pairing | allowlist | open | disabled` (預設：pairing)。
- `channels.zalo.allowFrom`: 私訊白名單（使用者 ID）。`open` 模式需要填入 `"*"`。精靈會要求輸入數值 ID。
- `channels.zalo.mediaMaxMb`: 傳入/傳出媒體上限 (MB，預設為 5)。
- `channels.zalo.webhookUrl`: 啟用 webhook 模式（需要 HTTPS）。
- `channels.zalo.webhookSecret`: Webhook 密鑰 (8-256 字元)。
- `channels.zalo.webhookPath`: Gateway HTTP 伺服器上的 webhook 路徑。
- `channels.zalo.proxy`: API 請求的代理伺服器 URL。

多帳號選項：

- `channels.zalo.accounts.<id>.botToken`: 帳號專屬權杖。
- `channels.zalo.accounts.<id>.tokenFile`: 帳號專屬權杖檔案。
- `channels.zalo.accounts.<id>.name`: 顯示名稱。
- `channels.zalo.accounts.<id>.enabled`: 啟用/停用帳號。
- `channels.zalo.accounts.<id>.dmPolicy`: 帳號專屬私訊政策。
- `channels.zalo.accounts.<id>.allowFrom`: 帳號專屬白名單。
- `channels.zalo.accounts.<id>.webhookUrl`: 帳號專屬 webhook URL。
- `channels.zalo.accounts.<id>.webhookSecret`: 帳號專屬 webhook 密鑰。
- `channels.zalo.accounts.<id>.webhookPath`: 帳號專屬 webhook 路徑。
- `channels.zalo.accounts.<id>.proxy`: 帳號專屬代理伺服器 URL。
