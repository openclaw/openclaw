---
summary: "Date and time handling across envelopes, prompts, tools, and connectors"
read_when:
  - You are changing how timestamps are shown to the model or users
  - You are debugging time formatting in messages or system prompt output
title: Date and Time
---

# 日期與時間

OpenClaw 預設使用 **主機本地時間作為傳輸時間戳**，並且 **系統提示中僅使用使用者時區**。
供應商時間戳會被保留，以便工具維持其原生語意（目前時間可透過 `session_status` 取得）。

## 訊息信封（預設為本地時間）

傳入訊息會包裹一個時間戳（精確到分鐘）：

```
[Provider ... 2026-01-05 16:26 PST] message text
```

此信封時間戳預設為 **主機本地時間**，不論供應商時區為何。

你可以覆寫此行為：

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
- `envelopeTimezone: "user"` 使用 `agents.defaults.userTimezone`（若無則回退到主機時區）。
- 使用明確的 IANA 時區（例如 `"America/Chicago"`）以指定固定時區。
- `envelopeTimestamp: "off"` 從信封標頭移除絕對時間戳。
- `envelopeElapsed: "off"` 移除經過時間後綴（`+2m` 風格）。

### 範例

**本地時間（預設）：**

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

## 系統提示：當前日期與時間

如果已知使用者時區，系統提示會包含專門的
**當前日期與時間** 區塊，僅顯示 **時區**（不包含時鐘/時間格式）
以維持提示快取的穩定性：

```
Time zone: America/Chicago
```

當代理需要當前時間時，請使用 `session_status` 工具；狀態卡片會包含時間戳行。

## 系統事件行（預設為本地時間）

排隊的系統事件插入代理上下文時，會以時間戳為前綴，
使用與訊息信封相同的時區設定（預設：主機本地）。

```
System: [2026-01-12 12:19:17 PST] Model switched.
```

### 設定使用者時區與格式

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
- `timeFormat` 控制提示中的 **12小時/24小時顯示**。`auto` 會跟隨作業系統偏好設定。

## 時間格式偵測（自動）

當 `timeFormat: "auto"` 時，OpenClaw 會檢查作業系統偏好（macOS/Windows），
若無則退回至區域格式。偵測結果會 **於每個程序中快取**，
避免重複系統呼叫。

## 工具負載與連接器（原生提供者時間戳 + 標準化欄位）

頻道工具會回傳 **提供者原生時間戳**，並新增標準化欄位以保持一致性：

- `timestampMs`: 紀元毫秒（UTC）
- `timestampUtc`: ISO 8601 UTC 字串

原始提供者欄位會被保留，因此不會遺失任何資料。

- Slack：API 回傳的類似紀元的字串
- Discord：UTC ISO 時間戳
- Telegram/WhatsApp：提供者特定的數字或 ISO 時間戳

如果需要本地時間，請使用已知時區在後端進行轉換。

## 相關文件

- [系統提示](/concepts/system-prompt)
- [時區](/concepts/timezone)
- [訊息](/concepts/messages)
