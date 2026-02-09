---
summary: "由 Gateway 閘道器 擁有的全域語音喚醒詞，以及它們如何在各節點之間同步"
read_when:
  - 變更語音喚醒詞的行為或預設值時
  - 新增需要喚醒詞同步的新節點平台時
title: "語音喚醒"
---

# 語音喚醒（全域喚醒詞）

OpenClaw treats **wake words as a single global list** owned by the **Gateway**.

- **沒有每個節點的自訂喚醒詞**。
- **Any node/app UI may edit** the list; changes are persisted by the Gateway and broadcast to everyone.
- 各裝置仍各自保有 **語音喚醒 啟用／停用** 的切換（本地 UX 與權限不同）。

## 儲存（閘道器主機）

Wake words are stored on the gateway machine at:

- `~/.openclaw/settings/voicewake.json`

形狀：

```json
{ "triggers": ["openclaw", "claude", "computer"], "updatedAtMs": 1730000000000 }
```

## 協定

### 方法

- `voicewake.get` → `{ triggers: string[] }`
- `voicewake.set`，參數為 `{ triggers: string[] }` → `{ triggers: string[] }`

注意事項：

- Triggers are normalized (trimmed, empties dropped). 空清單會回退到預設值。
- Limits are enforced for safety (count/length caps).

### 事件

- `voicewake.changed`，承載 `{ triggers: string[] }`

誰會收到：

- 所有 WebSocket 連線的用戶端（macOS 應用程式、WebChat 等）。
- 所有已連線的節點（iOS/Android），以及在節點連線時作為初始的「目前狀態」推送。

## Client behavior

### macOS 應用程式

- Uses the global list to gate `VoiceWakeRuntime` triggers.
- 在「語音喚醒」設定中編輯「觸發詞」會呼叫 `voicewake.set`，接著依賴廣播來讓其他用戶端保持同步。

### iOS 節點

- 使用全域清單進行 `VoiceWakeManager` 的觸發偵測。
- 在設定中編輯「喚醒詞」會（透過 Gateway WS）呼叫 `voicewake.set`，同時保持本地喚醒詞偵測的即時回應。

### Android 節點

- 在設定中提供喚醒詞編輯器。
- 透過 Gateway WS 呼叫 `voicewake.set`，讓編輯結果在各處同步。
