---
summary: "信封、提示、工具和連接器中的日期與時間處理"
read_when:
  - 當您正在更改時間戳記向模型或使用者顯示的方式時
  - 當您正在偵錯訊息或系統提示輸出中的時間格式時
title: "日期與時間"
---

# 日期與時間

OpenClaw 預設為**傳輸時間戳記使用主機本地時間**，並**僅在系統提示中使用使用者時區**。
供應商時間戳記會被保留，以便工具保持其原生語義（可透過 `session_status` 取得目前時間）。

## 訊息信封 (預設為本地)

傳入訊息會被包裝一個時間戳記 (分鐘精確度)：

```
[Provider ... 2026-01-05 16:26 PST] message text
```

此信封時間戳記**預設為主機本地時間**，不論供應商時區為何。

您可以覆寫此行為：

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
- 使用明確的 IANA 時區（例如，`"America/Chicago"`）作為固定時區。
- `envelopeTimestamp: "off"` 從信封標頭中移除絕對時間戳記。
- `envelopeElapsed: "off"` 移除經過時間後綴（`+2m` 樣式）。

### 範例

**本地 (預設)：**

```
[WhatsApp +1555 2026-01-18 00:19 PST] hello
```

**使用者時區：**

```
[WhatsApp +1555 2026-01-18 00:19 CST] hello
```

**經過時間啟用：**

```
[WhatsApp +1555 +30s 2026-01-18T05:19Z] follow-up
```

## 系統提示：目前日期與時間

如果使用者時區已知，系統提示會包含一個專門的**目前日期與時間**區塊，其中**僅包含時區**（無時鐘/時間格式），以保持提示快取穩定：

```
Time zone: America/Chicago
```

當智慧代理需要目前時間時，請使用 `session_status` 工具；狀態卡中包含一個時間戳記行。

## 系統事件行 (預設為本地)

插入到智慧代理上下文中的排隊系統事件會加上時間戳記前綴，其時區選擇與訊息信封相同（預設：主機本地）。

```
System: [2026-01-12 12:19:17 PST] Model switched.
```

### 配置使用者時區 + 格式

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

- `userTimezone` 為提示上下文設定**使用者本地時區**。
- `timeFormat` 控制提示中的**12 小時制/24 小時制顯示**。`auto` 遵循作業系統偏好設定。

## 時間格式偵測 (自動)

當 `timeFormat: "auto"` 時，OpenClaw 會檢查作業系統偏好設定 (macOS/Windows) 並回退到地區設定格式。偵測到的值會**按程序快取**，以避免重複的系統呼叫。

## 工具酬載 + 連接器 (原始供應商時間 + 標準化欄位)

頻道工具會返回**供應商原生時間戳記**並添加標準化欄位以保持一致性：

- `timestampMs`: epoch 毫秒 (UTC)
- `timestampUtc`: ISO 8601 UTC 字串

原始供應商欄位會被保留，因此不會遺失任何內容。

- Slack: 來自 API 的類 epoch 字串
- Discord: UTC ISO 時間戳記
- Telegram/WhatsApp: 供應商特定的數字/ISO 時間戳記

如果您需要本地時間，請使用已知時區在下游進行轉換。

## 相關文件

- [系統提示](/concepts/system-prompt)
- [時區](/concepts/timezone)
- [訊息](/concepts/messages)
