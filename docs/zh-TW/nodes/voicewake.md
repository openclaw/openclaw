---
summary: Global voice wake words (Gateway-owned) and how they sync across nodes
read_when:
  - Changing voice wake words behavior or defaults
  - Adding new node platforms that need wake word sync
title: Voice Wake
---

# 語音喚醒詞（全域喚醒詞）

OpenClaw 將 **喚醒詞視為由** **Gateway** **擁有的單一全域清單**。

- 不存在 **每個節點自訂的喚醒詞**。
- **任何節點/應用程式介面都可以編輯**該清單；變更由 Gateway 持久化並廣播給所有人。
- macOS 和 iOS 保留本地的 **語音喚醒啟用/停用** 切換（本地使用者體驗與權限不同）。
- Android 目前保持語音喚醒關閉，並在語音分頁使用手動麥克風流程。

## 儲存（Gateway 主機）

喚醒詞儲存在 Gateway 主機的路徑：

- `~/.openclaw/settings/voicewake.json`

結構：

```json
{ "triggers": ["openclaw", "claude", "computer"], "updatedAtMs": 1730000000000 }
```

## 協定

### 方法

- `voicewake.get` → `{ triggers: string[] }`
- `voicewake.set` 搭配參數 `{ triggers: string[] }` → `{ triggers: string[] }`

備註：

- 觸發詞會被正規化（去除前後空白，空字串會被丟棄）。空清單會回退到預設值。
- 為安全起見會強制限制（數量/長度上限）。

### 事件

- `voicewake.changed` 載荷 `{ triggers: string[] }`

誰會收到：

- 所有 WebSocket 用戶端（macOS 應用程式、WebChat 等）
- 所有已連線節點（iOS/Android），並且在節點連線時會推送初始的「當前狀態」。

## 用戶端行為

### macOS 應用程式

- 使用全域清單來控制 `VoiceWakeRuntime` 觸發器。
- 在語音喚醒設定中編輯「觸發詞」會呼叫 `voicewake.set`，並依賴廣播來保持其他用戶端同步。

### iOS 節點

- 使用全域清單進行 `VoiceWakeManager` 觸發偵測。
- 在設定中編輯喚醒詞會透過 Gateway WS 呼叫 `voicewake.set`，同時保持本地喚醒詞偵測的即時反應。

### Android 節點

- Android 執行環境/設定中目前已停用語音喚醒功能。
- Android 語音使用語音分頁中的手動麥克風擷取，取代喚醒詞觸發。
