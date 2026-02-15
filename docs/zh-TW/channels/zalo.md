---
summary: "Zalo 智慧代理支援狀態、功能與設定"
read_when:
  - 處理 Zalo 功能或網路掛鉤時
title: "Zalo"
---

# Zalo (Bot API)

狀態：實驗性。僅支援私訊；根據 Zalo 文件，群組功能即將推出。

## 插件要求

Zalo 以插件形式提供，並未包含在核心安裝中。

- 透過 CLI 安裝：`openclaw plugins install @openclaw/zalo`
- 或在新手導覽期間選擇 **Zalo** 並確認安裝提示
- 了解詳情：[插件](/tools/plugin)

## 快速設定 (初學者)

1. 安裝 Zalo 插件：
   - 從原始碼結帳：`openclaw plugins install ./extensions/zalo`
   - 從 npm (如果已發佈)：`openclaw plugins install @openclaw/zalo`
   - 或在新手導覽中選擇 **Zalo** 並確認安裝提示
2. 設定權杖：
   - 環境變數：`ZALO_BOT_TOKEN=...`
   - 或設定：`channels.zalo.botToken: "..."`。
3. 重新啟動 Gateway（或完成新手導覽）。
4. 私訊存取預設為配對；首次聯繫時核准配對碼。

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

Zalo 是一款專注於越南的訊息應用程式；其 Bot API 允許 Gateway 執行用於一對一對話的智慧代理。
它非常適合需要確定性路由回 Zalo 的支援或通知功能。

- 由 Gateway 擁有的 Zalo Bot API 頻道。
- 確定性路由：回覆會回到 Zalo；模型從不選擇頻道。
- 私訊共享智慧代理的主要工作階段。
- 尚不支援群組功能（Zalo 文件指出「即將推出」）。

## 設定 (快速路徑)

### 1) 建立智慧代理權杖 (Zalo Bot Platform)

1. 前往 [https://bot.zaloplatforms.com](https://bot.zaloplatforms.com) 並登入。
2. 建立新的智慧代理並設定其設定。
3. 複製智慧代理權杖（格式：`12345689:abc-xyz`）。

### 2) 設定權杖 (環境變數或設定)

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

環境變數選項：`ZALO_BOT_TOKEN=...`（僅適用於預設帳戶）。

多帳戶支援：使用 `channels.zalo.accounts` 搭配每個帳戶的權杖和選填的 `name`。

3. 重新啟動 Gateway。當權杖被解析（環境變數或設定）時，Zalo 會啟動。
4. 私訊存取預設為配對。當智慧代理首次被聯繫時核准該代碼。

## 運作方式 (行為)

- 入站訊息會被正規化為共享頻道封裝，並帶有媒體佔位符。
- 回覆總是路由回相同的 Zalo 聊天。
- 預設為長輪詢；網路掛鉤模式可透過 `channels.zalo.webhookUrl` 使用。

## 限制

- 出站文字會被分塊為 2000 個字元（Zalo API 限制）。
- 媒體下載/上傳受 `channels.zalo.mediaMaxMb` 限制（預設為 5）。
- 串流傳輸預設為區塊串流傳輸，因為 2000 字元限制降低了串流傳輸的實用性。

## 存取控制 (私訊)

### 私訊存取

- 預設：`channels.zalo.dmPolicy = "pairing"`。未知發送者會收到配對碼；訊息在核准前會被忽略（代碼在 1 小時後過期）。
- 透過以下方式核准：
  - `openclaw pairing list zalo`
  - `openclaw pairing approve zalo <CODE>`
- 配對是預設的權杖交換。了解詳情：[配對](/channels/pairing)
- `channels.zalo.allowFrom` 接受數字使用者 ID（不提供使用者名稱查詢）。

## 長輪詢與網路掛鉤

- 預設：長輪詢（無需公開 URL）。
- 網路掛鉤模式：設定 `channels.zalo.webhookUrl` 和 `channels.zalo.webhookSecret`。
  - 網路掛鉤密碼必須是 8-256 個字元。
  - 網路掛鉤 URL 必須使用 HTTPS。
  - Zalo 會發送帶有 `X-Bot-Api-Secret-Token` 標頭的事件以供驗證。
  - Gateway HTTP 會在 `channels.zalo.webhookPath` 處理網路掛鉤請求（預設為網路掛鉤 URL 路徑）。

**注意**：根據 Zalo API 文件，getUpdates（輪詢）和網路掛鉤是互斥的。

## 支援的訊息類型

- **文字訊息**：完全支援，並帶有 2000 字元分塊。
- **圖片訊息**：下載並處理入站圖片；透過 `sendPhoto` 傳送圖片。
- **貼圖**：已記錄但未完全處理（智慧代理無回應）。
- **不支援的類型**：已記錄（例如，來自受保護使用者的訊息）。

## 功能

| 功能         | 狀態                         |
| --------------- | ------------------------------ |
| 私訊          | ✅ 支援                   |
| 群組          | ❌ 即將推出（根據 Zalo 文件） |
| 媒體（圖片）  | ✅ 支援                   |
| 心情回應       | ❌ 不支援               |
| 討論串         | ❌ 不支援               |
| 投票           | ❌ 不支援               |
| 原生指令       | ❌ 不支援               |
| 串流傳輸       | ⚠️ 已區塊串流傳輸（2000 字元限制）   |

## 傳送目標 (CLI/cron)

- 使用聊天 ID 作為目標。
- 範例：`openclaw message send --channel zalo --target 123456789 --message "hi"`。

## 疑難排解

**智慧代理沒有回應：**

- 檢查權杖是否有效：`openclaw channels status --probe`
- 驗證發送者是否已核准（配對或 allowFrom）
- 檢查 Gateway 日誌：`openclaw logs --follow`

**網路掛鉤沒有收到事件：**

- 確保網路掛鉤 URL 使用 HTTPS
- 驗證密碼權杖為 8-256 個字元
- 確認 Gateway HTTP 端點在設定的路徑上可達
- 檢查 getUpdates 輪詢是否未執行（它們是互斥的）

## 設定參考 (Zalo)

完整設定：[設定](/gateway/configuration)

供應商選項：

- `channels.zalo.enabled`：啟用/停用頻道啟動。
- `channels.zalo.botToken`：來自 Zalo Bot Platform 的智慧代理權杖。
- `channels.zalo.tokenFile`：從檔案路徑讀取權杖。
- `channels.zalo.dmPolicy`：`pairing | allowlist | open | disabled`（預設：pairing）。
- `channels.zalo.allowFrom`：私訊允許清單（使用者 ID）。`open` 需要 `"*"`。精靈將要求提供數字 ID。
- `channels.zalo.mediaMaxMb`：入站/出站媒體上限（MB，預設為 5）。
- `channels.zalo.webhookUrl`：啟用網路掛鉤模式（需要 HTTPS）。
- `channels.zalo.webhookSecret`：網路掛鉤密碼（8-256 字元）。
- `channels.zalo.webhookPath`：Gateway HTTP 伺服器上的網路掛鉤路徑。
- `channels.zalo.proxy`：用於 API 請求的代理 URL。

多帳戶選項：

- `channels.zalo.accounts.<id>.botToken`：每個帳戶的權杖。
- `channels.zalo.accounts.<id>.tokenFile`：每個帳戶的權杖檔案。
- `channels.zalo.accounts.<id>.name`：顯示名稱。
- `channels.zalo.accounts.<id>.enabled`：啟用/停用帳戶。
- `channels.zalo.accounts.<id>.dmPolicy`：每個帳戶的私訊策略。
- `channels.zalo.accounts.<id>.allowFrom`：每個帳戶的允許清單。
- `channels.zalo.accounts.<id>.webhookUrl`：每個帳戶的網路掛鉤 URL。
- `channels.zalo.accounts.<id>.webhookSecret`：每個帳戶的網路掛鉤密碼。
- `channels.zalo.accounts.<id>.webhookPath`：每個帳戶的網路掛鉤路徑。
- `channels.zalo.accounts.<id>.proxy`：每個帳戶的代理 URL。
