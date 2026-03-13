---
summary: "Date and time handling across envelopes, prompts, tools, and connectors"
read_when:
  - You are changing how timestamps are shown to the model or users
  - You are debugging time formatting in messages or system prompt output
title: Date and Time
---

# Date & Time

OpenClaw 預設使用 **主機本地時間作為傳輸時間戳**，並且 **僅在系統提示中使用使用者時區**。提供者的時間戳會被保留，以便工具保持其原生語義（當前時間可以透過 `session_status` 獲得）。

## 訊息信封（預設為本地）

進來的訊息會附上時間戳記（分鐘精度）：

```
[Provider ... 2026-01-05 16:26 PST] message text
```

此信封的時間戳記預設為 **主機本地時間**，無論提供者的時區為何。

您可以覆蓋此行為：

```json5
{
  agents: {
    defaults: {
      envelopeTimezone: "local", // "utc" | "local" | "user" | IANA timezone
      envelopeTimestamp: "on", // "on" | "off"
      envelopeElapsed: "on", // "on" | "off"
    },
  },
}
```

- `envelopeTimezone: "utc"` 使用 UTC。
- `envelopeTimezone: "local"` 使用主機時區。
- `envelopeTimezone: "user"` 使用 `agents.defaults.userTimezone`（回退到主機時區）。
- 對於固定時區，使用明確的 IANA 時區（例如，`"America/Chicago"`）。
- `envelopeTimestamp: "off"` 從信封標頭中移除絕對時間戳。
- `envelopeElapsed: "off"` 移除經過時間的後綴（`+2m` 樣式）。

### Examples

**Local (default):**

```
[WhatsApp +1555 2026-01-18 00:19 PST] hello
```

**使用者時區：**

```
[WhatsApp +1555 2026-01-18 00:19 CST] hello
```

**啟用經過時間：**

```
[WhatsApp +1555 +30s 2026-01-18T05:19Z] follow-up
```

## System prompt: Current Date & Time

如果已知使用者的時區，系統提示將包含一個專門的 **當前日期與時間** 區域，僅顯示 **時區**（不包含時鐘/時間格式），以保持提示快取的穩定性：

```
Time zone: America/Chicago
```

當代理需要當前時間時，請使用 `session_status` 工具；狀態卡包含一行時間戳。

## 系統事件行（預設為本地）

排隊的系統事件插入到代理上下文中時，會使用與訊息信封相同的時區選擇（預設：主機本地）來加上時間戳記。

```
System: [2026-01-12 12:19:17 PST] Model switched.
```

### 設定使用者時區 + 格式

```json5
{
  agents: {
    defaults: {
      userTimezone: "America/Chicago",
      timeFormat: "auto", // auto | 12 | 24
    },
  },
}
```

- `userTimezone` 設定提示上下文的 **使用者本地時區**。
- `timeFormat` 控制提示中的 **12小時/24小時顯示**。`auto` 遵循作業系統偏好設定。

## 時間格式偵測 (自動)

當 `timeFormat: "auto"` 時，OpenClaw 會檢查作業系統的偏好設定（macOS/Windows），並回退到區域格式化。檢測到的值會 **按進程快取**，以避免重複的系統調用。

## 工具有效載荷 + 連接器（原始提供者時間 + 正規化欄位）

Channel tools 返回 **provider-native timestamps** 並新增標準化欄位以確保一致性：

- `timestampMs`: 世紀毫秒 (UTC)
- `timestampUtc`: ISO 8601 UTC 字串

原始提供者欄位被保留，因此沒有任何資料遺失。

- Slack: 來自 API 的類似 epoch 的字串
- Discord: UTC ISO 時間戳
- Telegram/WhatsApp: 提供者特定的數字/ISO 時間戳

如果您需要當地時間，請使用已知的時區在下游進行轉換。

## 相關文件

- [System Prompt](/concepts/system-prompt)
- [Timezones](/concepts/timezone)
- [Messages](/concepts/messages)
