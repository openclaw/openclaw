---
summary: "處理訊息封套、提示詞、工具與連接器之間的日期與時間"
read_when:
  - 當你正在更改向模型或使用者顯示時間戳記的方式時
  - 當你正在除錯訊息或系統提示詞輸出中的時間格式時
title: "日期與時間"
---

# 日期與時間

OpenClaw 預設針對 **傳輸時間戳記使用主機本地時間**，並僅在 **系統提示詞中使用使用者時區**。
供應商時間戳記會被保留，因此工具能維持其原始語義（可透過 `session_status` 獲取目前時間）。

## 訊息封套 (預設為本地時間)

傳入訊息會封裝時間戳記（精確度至分鐘）：

```
[Provider ... 2026-01-05 16:26 PST] message text
```

無論供應商時區為何，此封套時間戳記 **預設為主機本地時間**。

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
- `envelopeTimezone: "user"` 使用 `agents.defaults.userTimezone`（若未設定則退回使用主機時區）。
- 使用明確的 IANA 時區（例如：`"America/Chicago"`）來設定固定時區。
- `envelopeTimestamp: "off"` 會從封套標頭移除絕對時間戳記。
- `envelopeElapsed: "off"` 會移除經過時間後綴（例如 `+2m` 的格式）。

### 範例

**本地 (預設)：**

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

## 系統提示詞：目前日期與時間

若已知使用者時區，系統提示詞會包含一個專用的
**目前日期與時間** 區段，且僅包含 **時區資訊**（不含時鐘/時間格式），
以保持提示詞快取穩定：

```
Time zone: America/Chicago
```

當智慧代理需要目前時間時，請使用 `session_status` 工具；狀態卡中包含時間戳記行。

## 系統事件行 (預設為本地時間)

插入智慧代理上下文的佇列系統事件會加上時間戳記前綴，使用與訊息封套相同的時區選擇（預設為主機本地時間）。

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

- `userTimezone` 設定提示詞上下文的 **使用者本地時區**。
- `timeFormat` 控制提示詞中的 **12小時/24小時制顯示**。`auto` 會遵循作業系統偏好設定。

## 時間格式偵測 (auto)

當 `timeFormat: "auto"` 時，OpenClaw 會檢查作業系統偏好設定（macOS/Windows），若無法取得則退回至地區語言格式。偵測到的值會被 **依程序快取 (cached per process)**，以避免重複的系統呼叫。

## 工具酬載 + 連接器 (原始供應商時間 + 標準化欄位)

頻道工具會回傳 **供應商原生時間戳記**，並增加標準化欄位以保持一致性：

- `timestampMs`: epoch 毫秒數 (UTC)
- `timestampUtc`: ISO 8601 UTC 字串

原始供應商欄位會被保留，因此不會遺失任何資訊。

- Slack: 來自 API 的類 epoch 字串
- Discord: UTC ISO 時間戳記
- Telegram/WhatsApp: 供應商特定的數值/ISO 時間戳記

如果你需要本地時間，請在下游使用已知時區進行轉換。

## 相關文件

- [系統提示詞](/concepts/system-prompt)
- [時區](/concepts/timezone)
- [訊息](/concepts/messages)
