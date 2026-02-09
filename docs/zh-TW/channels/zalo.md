---
summary: "Zalo bot support status, capabilities, and configuration"
read_when:
  - 進行 Zalo 功能或 webhook 相關工作時
title: "Zalo"
---

# Zalo（Bot API）

Status: experimental. Direct messages only; groups coming soon per Zalo docs.

## Plugin required

Zalo 以外掛形式提供，未隨核心安裝一併包含。

- 透過 CLI 安裝：`openclaw plugins install @openclaw/zalo`
- 或在入門引導期間選擇 **Zalo** 並確認安裝提示
- 詳情：[Plugins](/tools/plugin)

## 快速設定（初學者）

1. 安裝 Zalo 外掛：
   - 從原始碼檢出安裝：`openclaw plugins install ./extensions/zalo`
   - 從 npm 安裝（若已發佈）：`openclaw plugins install @openclaw/zalo`
   - 或在入門引導中選擇 **Zalo** 並確認安裝提示
2. 設定權杖：
   - Env: `ZALO_BOT_TOKEN=...`
   - 或設定檔：`channels.zalo.botToken: "..."`。
3. Restart the gateway (or finish onboarding).
4. DM access is pairing by default; approve the pairing code on first contact.

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

Zalo 是以越南為主的即時通訊應用程式；其 Bot API 讓 Gateway 閘道器能執行用於 1:1 對話的機器人。
適合用於客服或通知等需要確定性回傳至 Zalo 的情境。
It is a good fit for support or notifications where you want deterministic routing back to Zalo.

- 由 Gateway 閘道器擁有的 Zalo Bot API 頻道。
- 確定性路由：回覆一律回到 Zalo；模型不會選擇頻道。
- DMs share the agent's main session.
- 尚未支援群組（Zalo 文件標示「即將推出」）。

## 設定（快速路徑）

### 1. 建立機器人權杖（Zalo Bot Platform）

1. 前往 [https://bot.zaloplatforms.com](https://bot.zaloplatforms.com) 並登入。
2. Create a new bot and configure its settings.
3. Copy the bot token (format: `12345689:abc-xyz`).

### 2) 設定權杖（環境變數或設定檔）

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

多帳號支援：使用 `channels.zalo.accounts` 搭配各帳號權杖，並可選用 `name`。

3. 重新啟動 Gateway 閘道器（或完成入門引導）。 Zalo starts when a token is resolved (env or config).
4. DM access defaults to pairing. Approve the code when the bot is first contacted.

## 運作方式（行為）

- Inbound messages are normalized into the shared channel envelope with media placeholders.
- Replies always route back to the same Zalo chat.
- 預設使用長輪詢；可透過 `channels.zalo.webhookUrl` 啟用 webhook 模式。

## 限制

- 外送文字會分段為每段 2000 個字元（Zalo API 限制）。
- 媒體下載／上傳受 `channels.zalo.mediaMaxMb` 限制（預設 5）。
- 由於 2000 字元限制使串流實用性降低，預設封鎖串流。

## Access control (DMs)

### DM access

- 預設：`channels.zalo.dmPolicy = "pairing"`。未知寄件者在核准前會被忽略。 未知寄件者會收到配對碼；在核准前會忽略訊息（配對碼 1 小時後到期）。
- Approve via:
  - `openclaw pairing list zalo`
  - `openclaw pairing approve zalo <CODE>`
- Pairing is the default token exchange. Details: [Pairing](/channels/pairing)
- `channels.zalo.allowFrom` 僅接受數字型使用者 ID（無法查詢使用者名稱）。

## Long-polling vs webhook

- 預設：長輪詢（不需要公開 URL）。
- webhook 模式：設定 `channels.zalo.webhookUrl` 與 `channels.zalo.webhookSecret`。
  - webhook 祕密必須為 8–256 個字元。
  - webhook URL 必須使用 HTTPS。
  - Zalo 會以 `X-Bot-Api-Secret-Token` 標頭傳送事件以供驗證。
  - Gateway 閘道器 HTTP 於 `channels.zalo.webhookPath` 處理 webhook 請求（預設為 webhook URL 路徑）。

**注意：** 依 Zalo API 文件，getUpdates（輪詢）與 webhook 彼此互斥。

## 支援的訊息類型

- **文字訊息**：完整支援，並進行 2000 字元分段。
- **圖片訊息**：下載並處理進站圖片；可透過 `sendPhoto` 傳送圖片。
- **Stickers**: Logged but not fully processed (no agent response).
- **不支援的類型**：僅記錄（例如來自受保護使用者的訊息）。

## 功能

| 功能              | Status            |
| --------------- | ----------------- |
| Direct messages | ✅ 支援              |
| 群組              | ❌ 即將推出（依 Zalo 文件） |
| 媒體（圖片）          | ✅ 支援              |
| 反應              | ❌ 不支援             |
| 討論串             | ❌ 不支援             |
| 投票              | ❌ 不支援             |
| 原生命令            | ❌ 不支援             |
| 串流              | ⚠️ 已封鎖（2000 字元限制） |

## 投遞目標（CLI/cron）

- 使用聊天 ID 作為目標。
- 範例：`openclaw message send --channel zalo --target 123456789 --message "hi"`。

## Troubleshooting

**Bot doesn't respond:**

- 檢查權杖是否有效：`openclaw channels status --probe`
- 確認寄件者已核准（配對或 allowFrom）
- 檢查 Gateway 閘道器日誌：`openclaw logs --follow`

**Webhook 未接收事件：**

- 確認 webhook URL 使用 HTTPS
- 驗證祕密權杖為 8–256 個字元
- 確認 Gateway 閘道器 HTTP 端點在設定的路徑上可連線
- 檢查是否未啟用 getUpdates 輪詢（兩者互斥）

## 設定參考（Zalo）

完整設定：[Configuration](/gateway/configuration)

提供者選項：

- `channels.zalo.enabled`：啟用／停用頻道啟動。
- `channels.zalo.botToken`：來自 Zalo Bot Platform 的機器人權杖。
- `channels.zalo.tokenFile`：從檔案路徑讀取權杖。
- `channels.zalo.dmPolicy`：`pairing | allowlist | open | disabled`（預設：配對）。
- `channels.zalo.allowFrom`：私訊允許清單（使用者 ID）。`open` 需要 `"*"`。 `open` requires `"*"`. The wizard will ask for numeric IDs.
- `channels.zalo.mediaMaxMb`：進站／出站媒體上限（MB，預設 5）。
- `channels.zalo.webhookUrl`：啟用 webhook 模式（需要 HTTPS）。
- `channels.zalo.webhookSecret`：webhook 祕密（8–256 個字元）。
- `channels.zalo.webhookPath`：Gateway 閘道器 HTTP 伺服器上的 webhook 路徑。
- `channels.zalo.proxy`：API 請求的代理 URL。

多帳號選項：

- `channels.zalo.accounts.<id>.botToken`：各帳號權杖。
- `channels.zalo.accounts.<id>.tokenFile`：各帳號權杖檔案。
- `channels.zalo.accounts.<id>.name`：顯示名稱。
- `channels.zalo.accounts.<id>.enabled`：啟用／停用帳號。
- `channels.zalo.accounts.<id>.dmPolicy`：各帳號私訊政策。
- `channels.zalo.accounts.<id>.allowFrom`：各帳號允許清單。
- `channels.zalo.accounts.<id>.webhookUrl`：各帳號 webhook URL。
- `channels.zalo.accounts.<id>.webhookSecret`：各帳號 webhook 祕密。
- `channels.zalo.accounts.<id>.webhookPath`：各帳號 webhook 路徑。
- `channels.zalo.accounts.<id>.proxy`：各帳號代理 URL。
