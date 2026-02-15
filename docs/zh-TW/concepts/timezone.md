---
summary: "智慧代理、信封（envelopes）與提示詞的時區處理"
read_when:
  - 您需要瞭解模型如何將時間戳記正規化
  - 為系統提示詞設定使用者時區
title: "時區"
---

# 時區

OpenClaw 將時間戳記標準化，使模型看到**單一的參考時間**。

## 訊息信封（預設為本地時間）

傳入訊息會被封裝在如下的信封（envelope）中：

```
[Provider ... 2026-01-05 16:26 PST] message text
```

信封中的時間戳記**預設為宿主機本地時間**，精確度至分鐘。

您可以透過以下方式覆蓋此設定：

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
- `envelopeTimezone: "user"` 使用 `agents.defaults.userTimezone`（若未設定則回退至宿主機時區）。
- 使用明確的 IANA 時區（例如：`"Europe/Vienna"`）以設定固定偏移量。
- `envelopeTimestamp: "off"` 會從信封標頭移除絕對時間戳記。
- `envelopeElapsed: "off"` 會移除經過時間的後綴（例如 `+2m` 的格式）。

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

## 工具酬載（原始供應商數據 + 正規化欄位）

工具呼叫（`channels.discord.readMessages`、`channels.slack.readMessages` 等）會回傳**原始供應商的時間戳記**。
為了保持一致性，我們還會附加正規化的欄位：

- `timestampMs`（UTC epoch 毫秒）
- `timestampUtc`（ISO 8601 UTC 字串）

原始供應商欄位將被保留。

## 系統提示詞的使用者時區

設定 `agents.defaults.userTimezone` 來告知模型使用者的本地時區。若未設定，OpenClaw 會在**執行時解析宿主機時區**（不會寫入設定檔）。

```json5
{
  agents: { defaults: { userTimezone: "America/Chicago" } },
}
```

系統提示詞包含：

- 包含本地時間與時區的 `Current Date & Time` 區段
- `Time format: 12-hour`（12 小時制）或 `24-hour`（24 小時制）

您可以透過 `agents.defaults.timeFormat`（`auto` | `12` | `24`）來控制提示詞格式。

請參閱 [日期與時間](/date-time) 以瞭解完整行為與範例。
