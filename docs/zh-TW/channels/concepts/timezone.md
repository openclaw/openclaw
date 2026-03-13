---
summary: "Timezone handling for agents, envelopes, and prompts"
read_when:
  - You need to understand how timestamps are normalized for the model
  - Configuring the user timezone for system prompts
title: Timezones
---

# 時區

OpenClaw 將時間戳標準化，使模型能夠看到 **單一參考時間**。

## 訊息信封（預設為本地）

[[BLOCK_1]]  
傳入的訊息被包裹在一個信封中，如下所示：  
[[BLOCK_1]]

```
[Provider ... 2026-01-05 16:26 PST] message text
```

信封中的時間戳記預設為 **主機本地時間**，精確到分鐘。

您可以使用以下方式覆蓋此設定：

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
- `envelopeTimezone: "user"` 使用 `agents.defaults.userTimezone`（回退到主機時區）。
- 使用明確的 IANA 時區（例如，`"Europe/Vienna"`）以獲得固定的偏移量。
- `envelopeTimestamp: "off"` 從信封標頭中移除絕對時間戳。
- `envelopeElapsed: "off"` 移除經過時間的後綴（`+2m` 樣式）。

### Examples

**Local (default):**

```
[Signal Alice +1555 2026-01-18 00:19 PST] hello
```

**固定時區：**

```
[Signal Alice +1555 2026-01-18 06:19 GMT+1] hello
```

**經過時間：**

```
[Signal Alice +1555 +2m 2026-01-18T05:19Z] follow-up
```

## 工具有效載荷（原始提供者數據 + 正規化欄位）

工具調用 (`channels.discord.readMessages`, `channels.slack.readMessages` 等) 返回 **原始提供者時間戳**。  
我們還附加了標準化字段以保持一致性：

- `timestampMs` (UTC 時間戳毫秒)
- `timestampUtc` (ISO 8601 UTC 字串)

原始提供者欄位被保留。

## User timezone for the system prompt

將 `agents.defaults.userTimezone` 設定為告訴模型使用者的本地時區。如果未設定，OpenClaw 將在執行時解析 **主機時區**（不進行設定寫入）。

```json5
{
  agents: { defaults: { userTimezone: "America/Chicago" } },
}
```

[[BLOCK_1]]

- `Current Date & Time` 區段包含當地時間和時區
- `Time format: 12-hour` 或 `24-hour`

您可以使用 `agents.defaults.timeFormat` (`auto` | `12` | `24`) 來控制提示格式。

請參閱 [Date & Time](/date-time) 以獲取完整的行為和範例。
