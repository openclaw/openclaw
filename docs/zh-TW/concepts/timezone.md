---
summary: "智慧代理、信封和提示的時區處理"
read_when:
  - 您需要了解時間戳記如何針對模型進行正規化
  - 設定系統提示的使用者時區
title: "時區"
---

# 時區

OpenClaw 標準化時間戳記，以便模型看到一個**單一參考時間**。

## 訊息信封（預設為本地）

傳入訊息會包裹在信封中，例如：

```
[Provider ... 2026-01-05 16:26 PST] message text
```

信封中的時間戳記**預設為主機本地**，精確到分鐘。

您可以使用以下方式覆寫此設定：

```json5
{
  agents: {
    defaults: {
      envelopeTimezone: "local", // "utc" | "local" | "user" | IANA 時區
      envelopeTimestamp: "on", // "on" | "off"
      envelopeElapsed: "on", // "on" | "off"
    },
  },
}
```

- `envelopeTimezone: "utc"` 使用 UTC。
- `envelopeTimezone: "user"` 使用 `agents.defaults.userTimezone`（回退到主機時區）。
- 使用明確的 IANA 時區（例如，`"Europe/Vienna"`）來設定固定偏移。
- `envelopeTimestamp: "off"` 會從信封標頭中移除絕對時間戳記。
- `envelopeElapsed: "off"` 會移除經過時間後綴（`+2m` 樣式）。

### 範例

**本地（預設）：**

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

## 工具酬載（原始供應商資料 + 正規化欄位）

工具呼叫（`channels.discord.readMessages`、`channels.slack.readMessages` 等）會回傳**原始供應商時間戳記**。
我們也會附加正規化欄位以保持一致性：

- `timestampMs`（UTC Epoch 毫秒）
- `timestampUtc`（ISO 8601 UTC 字串）

原始供應商欄位會被保留。

## 系統提示的使用者時區

設定 `agents.defaults.userTimezone` 以告知模型使用者的本地時區。如果未設定，OpenClaw 會在執行時解析**主機時區**（不安寫設定）。

```json5
{
  agents: { defaults: { userTimezone: "America/Chicago" } },
}
```

系統提示包含：

- `Current Date & Time` 區塊，包含本地時間和時區
- `Time format: 12-hour` 或 `24-hour`

您可以使用 `agents.defaults.timeFormat`（`auto` | `12` | `24`）來控制提示格式。

請參閱[日期與時間](/date-time)以了解完整行為和範例。
