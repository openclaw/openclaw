---
summary: "27. 代理、信封與提示的時區處理"
read_when:
  - 您需要了解時間戳如何為模型進行正規化
  - 28. 為系統提示設定使用者時區
title: "時區"
---

# 時區

OpenClaw 會將時間戳標準化，讓模型看到**單一參考時間**。

## 訊息封套（預設為本地）

傳入訊息會被包裝在如下的封裝中：

```
[Provider ... 2026-01-05 16:26 PST] message text
```

29. 信封中的時間戳預設為**主機本地時間**，精確到分鐘。

您可以使用以下方式覆寫：

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
- `envelopeTimezone: "user"` 使用 `agents.defaults.userTimezone`（回退至主機時區）。
- 使用明確的 IANA 時區（例如：`"Europe/Vienna"`）以取得固定偏移。
- `envelopeTimestamp: "off"` 會從封裝標頭中移除絕對時間戳。
- `envelopeElapsed: "off"` 會移除經過時間的後綴（`+2m` 樣式）。

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

## 工具承載（原始提供者資料 + 正規化欄位）

30. 工具呼叫（`channels.discord.readMessages`、`channels.slack.readMessages` 等） 31. 會回傳**原始供應商時間戳**。
31. 我們也會附加標準化欄位以保持一致性：

- `timestampMs`（UTC epoch 毫秒）
- `timestampUtc`（ISO 8601 UTC 字串）

原始提供者欄位會被保留。

## 33. 系統提示所使用的使用者時區

設定 `agents.defaults.userTimezone` 以告知模型使用者的本地時區。若未設定，
OpenClaw 會在**執行階段解析主機時區**（不寫入設定）。 34. 若未設定，OpenClaw 會在執行階段解析**主機時區**（不寫入設定）。

```json5
{
  agents: { defaults: { userTimezone: "America/Chicago" } },
}
```

系統提示包含：

- `Current Date & Time` 區段，包含本地時間與時區
- `Time format: 12-hour` 或 `24-hour`

您可以使用 `agents.defaults.timeFormat`（`auto` | `12` | `24`）來控制提示格式。

完整行為與範例請參閱 [Date & Time](/date-time)。
