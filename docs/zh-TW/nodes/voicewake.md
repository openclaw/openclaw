---
summary: "全域語音喚醒詞 (Gateway 擁有) 及其在各節點間同步的方式"
read_when:
  - 欲變更語音喚醒詞行為或預設值時
  - 新增需要同步喚醒詞的節點平台時
title: "語音喚醒 (Voice Wake)"
---

# 語音喚醒 (全域喚醒詞)

OpenClaw 將**喚醒詞視為由 Gateway 擁有的單一全域清單**。

- **沒有各個節點專屬的自定義喚醒詞**。
- **任何節點/配套應用 UI 都可以編輯**該清單；變更會由 Gateway 持久化儲存並廣播給所有人。
- 每個裝置仍保留自己的**語音喚醒啟用/停用**切換開關 (本地 UX 和權限有所不同)。

## 儲存空間 (Gateway 主機)

喚醒詞儲存在 Gateway 機器的以下路徑：

- `~/.openclaw/settings/voicewake.json`

結構：

```json
{ "triggers": ["openclaw", "claude", "computer"], "updatedAtMs": 1730000000000 }
```

## 協定 (Protocol)

### 方法 (Methods)

- `voicewake.get` → `{ triggers: string[] }`
- `voicewake.set` 參數 `{ triggers: string[] }` → `{ triggers: string[] }`

附註：

- 觸發詞會經過標準化處理 (修剪空白、丟棄空值)。空清單將回退到預設值。
- 為確保安全，會強制執行限制 (數量/長度上限)。

### 事件 (Events)

- `voicewake.changed` 酬載 `{ triggers: string[] }`

接收對象：

- 所有 WebSocket 用戶端 (macOS 應用程式、WebChat 等)
- 所有已連線的節點 (iOS/Android)，且在節點連線時也會作為初始的「目前狀態」進行推播。

## 用戶端行為

### macOS 應用程式

- 使用全域清單來過濾 `VoiceWakeRuntime` 觸發詞。
- 在語音喚醒設定中編輯「觸發詞 (Trigger words)」會呼叫 `voicewake.set`，並依賴廣播來保持其他用戶端同步。

### iOS 節點

- 使用全域清單進行 `VoiceWakeManager` 觸發偵測。
- 在設定中編輯喚醒詞會呼叫 `voicewake.set` (透過 Gateway WS)，並同時保持本地喚醒詞偵測的即時反應。

### Android 節點

- 在設定中提供喚醒詞編輯器。
- 透過 Gateway WS 呼叫 `voicewake.set`，讓編輯內容同步到所有地方。
