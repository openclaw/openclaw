---
summary: "全球語音喚醒詞 (Gateway 擁有) 及其如何在節點之間同步"
read_when:
  - 更改語音喚醒詞行為或預設值
  - 新增需要喚醒詞同步的節點平台
title: "語音喚醒"
---

# 語音喚醒 (全球喚醒詞)

OpenClaw 將**喚醒詞視為由 Gateway 擁有的單一全球列表**。

- **沒有每個節點的自訂喚醒詞**。
- **任何節點/應用程式介面都可以編輯**該列表；更改會由 Gateway 持續保存並廣播給所有人。
- 每個裝置仍保留其自己的**語音喚醒啟用/停用**開關 (本地使用者體驗 + 權限不同)。

## 儲存 (Gateway 主機)

喚醒詞儲存在 Gateway 機器上：

- `~/.openclaw/settings/voicewake.json`

格式：

```json
{ "triggers": ["openclaw", "claude", "computer"], "updatedAtMs": 1730000000000 }
```

## 協定

### 方法

- `voicewake.get` → `{ triggers: string[] }`
- `voicewake.set` 帶有參數 `{ triggers: string[] }` → `{ triggers: string[] }`

注意事項：

- 喚醒詞會被標準化 (修剪、刪除空白)。空白列表將恢復為預設值。
- 為了安全起見，會強制執行限制 (數量/長度上限)。

### 事件

- `voicewake.changed` 負載 `{ triggers: string[] }`

誰會收到：

- 所有 WebSocket 用戶端 (macOS 應用程式、WebChat 等)
- 所有已連接的節點 (iOS/Android)，以及在節點連接時作為初始「目前狀態」推送。

## 用戶端行為

### macOS 應用程式

- 使用全球列表來控制 `VoiceWakeRuntime` 喚醒詞。
- 在語音喚醒設定中編輯「喚醒詞」會呼叫 `voicewake.set`，然後依賴廣播來保持其他用戶端同步。

### iOS 節點

- 使用全球列表進行 `VoiceWakeManager` 喚醒詞偵測。
- 在設定中編輯喚醒詞會呼叫 `voicewake.set` (透過 Gateway WS)，同時也保持本地喚醒詞偵測的響應性。

### Android 節點

- 在設定中提供喚醒詞編輯器。
- 透過 Gateway WS 呼叫 `voicewake.set`，以便編輯內容同步到各處。
