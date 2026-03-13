---
summary: "Timezone handling for agents, envelopes, and prompts"
read_when:
  - You need to understand how timestamps are normalized for the model
  - Configuring the user timezone for system prompts
title: Timezones
---

# 時區

OpenClaw 將時間戳標準化，讓模型看到的是**單一參考時間**。

## 訊息信封（預設為本地時間）

傳入訊息會包裹在類似以下的信封中：

```
[Provider ... 2026-01-05 16:26 PST] message text
```

信封中的時間戳預設為**主機本地時間**，精確到分鐘。

你可以透過以下方式覆寫：

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
- `envelopeTimezone: "user"` 使用 `agents.defaults.userTimezone`（若無則回退到主機時區）。
- 使用明確的 IANA 時區（例如 `"Europe/Vienna"`）以設定固定偏移。
- `envelopeTimestamp: "off"` 從信封標頭移除絕對時間戳。
- `envelopeElapsed: "off"` 移除經過時間後綴（`+2m` 風格）。

### 範例

**本地時間（預設）：**

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

## 工具載荷（原始提供者資料 + 標準化欄位）

工具呼叫（`channels.discord.readMessages`、`channels.slack.readMessages` 等）會回傳**原始提供者時間戳記**。
我們也會附加標準化欄位以保持一致性：

- `timestampMs`（UTC 紀元毫秒）
- `timestampUtc`（ISO 8601 UTC 字串）

原始提供者欄位會被保留。

## 系統提示的使用者時區

設定 `agents.defaults.userTimezone` 以告知模型使用者的本地時區。若未設定，
OpenClaw 會在執行時解析**主機時區**（不會寫入設定）。

```json5
{
  agents: { defaults: { userTimezone: "America/Chicago" } },
}
```

系統提示包含：

- `Current Date & Time` 區段，顯示本地時間與時區
- `Time format: 12-hour` 或 `24-hour`

你可以透過 `agents.defaults.timeFormat`（`auto` | `12` | `24`）來控制提示格式。

完整行為與範例請參考 [日期與時間](/date-time)。
