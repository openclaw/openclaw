---
summary: 「由 Gateway 閘道器 擁有的全域語音喚醒詞，以及它們如何在各節點之間同步」
read_when:
  - 變更語音喚醒詞的行為或預設值時
  - 新增需要喚醒詞同步的新節點平台時
title: 「語音喚醒」
x-i18n:
  source_path: nodes/voicewake.md
  source_hash: eb34f52dfcdc3fc1
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:28:37Z
---

# 語音喚醒（全域喚醒詞）

OpenClaw 將 **喚醒詞視為由 Gateway 閘道器 擁有的單一全域清單**。

- **沒有每個節點各自的自訂喚醒詞**。
- **任何節點／應用程式的 UI 都可以編輯** 該清單；變更會由 Gateway 閘道器 持久化並廣播給所有人。
- 各裝置仍各自保有 **語音喚醒 啟用／停用** 的切換（本地 UX 與權限不同）。

## 儲存（閘道器主機）

喚醒詞會儲存在閘道器主機上的：

- `~/.openclaw/settings/voicewake.json`

結構：

```json
{ "triggers": ["openclaw", "claude", "computer"], "updatedAtMs": 1730000000000 }
```

## 協定

### 方法

- `voicewake.get` → `{ triggers: string[] }`
- `voicewake.set`，參數為 `{ triggers: string[] }` → `{ triggers: string[] }`

注意事項：

- 觸發詞會被正規化（去除前後空白、移除空項）。空清單會回退為預設值。
- 為了安全性，會強制限制（數量／長度上限）。

### 事件

- `voicewake.changed`，承載 `{ triggers: string[] }`

接收對象：

- 所有 WebSocket 連線的用戶端（macOS 應用程式、WebChat 等）。
- 所有已連線的節點（iOS／Android），並且在節點連線時也會作為初始「目前狀態」推送。

## 用戶端行為

### macOS 應用程式

- 使用全域清單來限制 `VoiceWakeRuntime` 的觸發。
- 在「語音喚醒」設定中編輯「觸發詞」會呼叫 `voicewake.set`，接著依賴廣播來讓其他用戶端保持同步。

### iOS 節點

- 使用全域清單進行 `VoiceWakeManager` 的觸發偵測。
- 在設定中編輯「喚醒詞」會（透過 Gateway WS）呼叫 `voicewake.set`，同時保持本地喚醒詞偵測的即時回應。

### Android 節點

- 在設定中提供「喚醒詞」編輯器。
- 透過 Gateway WS 呼叫 `voicewake.set`，讓編輯結果在各處同步。
