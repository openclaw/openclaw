---
summary: "跨封套、提示、工具與連接器的日期與時間處理"
read_when:
  - 當你正在變更時間戳如何呈現給模型或使用者
  - 當你正在除錯訊息或系統提示輸出中的時間格式
title: "日期與時間"
---

# 日期與時間

OpenClaw 預設對**傳輸時間戳使用主機本地時間**，並且**僅在系統提示中使用使用者時區**。
提供者的時間戳會被保留，以便工具維持其原生語意（目前時間可透過 `session_status` 取得）。
Provider timestamps are preserved so tools keep their native semantics (current time is available via `session_status`).

## 訊息封套（預設為本地）

傳入訊息會以時間戳（分鐘精度）包裝：

```
[Provider ... 2026-01-05 16:26 PST] message text
```

This envelope timestamp is **host-local by default**, regardless of the provider timezone.

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
- `envelopeTimezone: "user"` 使用 `agents.defaults.userTimezone`（回退為主機時區）。
- 使用明確的 IANA 時區（例如 `"America/Chicago"`）以固定時區。
- `envelopeTimestamp: "off"` 會移除封套標頭中的絕對時間戳。
- `envelopeElapsed: "off"` 會移除經過時間的後綴（`+2m` 樣式）。

### 範例

**本地（預設）：**

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

## 系統提示：目前日期與時間

若已知使用者時區，系統提示會包含一個專用的
**目前日期與時間** 區段，**僅包含時區**（不含時鐘／時間格式），
以維持提示快取的穩定性：

```
Time zone: America/Chicago
```

當代理程式需要目前時間時，請使用 `session_status` 工具；其狀態卡片包含一行時間戳。

## 系統事件行（預設為本地）

Queued system events inserted into agent context are prefixed with a timestamp using the
same timezone selection as message envelopes (default: host-local).

```
System: [2026-01-12 12:19:17 PST] Model switched.
```

### Configure user timezone + format

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

- `userTimezone` 設定提示內容中的**使用者本地時區**。
- `timeFormat` 控制提示中的 **12 小時／24 小時顯示**。`auto` 會遵循作業系統偏好。 `auto` follows OS prefs.

## 時間格式偵測（自動）

當 `timeFormat: "auto"` 時，OpenClaw 會檢查作業系統偏好（macOS／Windows），並在必要時回退至地區設定格式。偵測到的值會**以每個處理程序為單位快取**，以避免重複的系統呼叫。 The detected value is **cached per process**
to avoid repeated system calls.

## 工具酬載與連接器（原始提供者時間 + 正規化欄位）

頻道工具會回傳**提供者原生的時間戳**，並加入正規化欄位以保持一致性：

- `timestampMs`：epoch 毫秒（UTC）
- `timestampUtc`：ISO 8601 UTC 字串

Raw provider fields are preserved so nothing is lost.

- Slack：來自 API 的類 epoch 字串
- Discord：UTC ISO 時間戳
- Telegram／WhatsApp：提供者特定的數值／ISO 時間戳

若需要本地時間，請使用已知的時區在下游進行轉換。

## Related docs

- [System Prompt](/concepts/system-prompt)
- [Timezones](/concepts/timezone)
- [Messages](/concepts/messages)
