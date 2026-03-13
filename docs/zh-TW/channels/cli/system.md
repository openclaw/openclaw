---
summary: "CLI reference for `openclaw system` (system events, heartbeat, presence)"
read_when:
  - You want to enqueue a system event without creating a cron job
  - You need to enable or disable heartbeats
  - You want to inspect system presence entries
title: system
---

# `openclaw system`

系統級助手用於網關：排隊系統事件、控制心跳，並查看存在狀態。

## 常用指令

```bash
openclaw system event --text "Check for urgent follow-ups" --mode now
openclaw system heartbeat enable
openclaw system heartbeat last
openclaw system presence
```

## `system event`

在 **main** 會話中排入一個系統事件。下一次心跳將會將其作為 `System:` 行注入到提示中。使用 `--mode now` 立即觸發心跳；`next-heartbeat` 則等待下一次預定的時間點。

Flags:

- `--text <text>`: 必需的系統事件文本。
- `--mode <mode>`: `now` 或 `next-heartbeat`（預設）。
- `--json`: 機器可讀的輸出。

## `system heartbeat last|enable|disable`

[[BLOCK_1]]  
Heartbeat controls:  
[[INLINE_1]]

- `last`: 顯示最後的心跳事件。
- `enable`: 重新啟用心跳（如果它們被禁用，請使用此選項）。
- `disable`: 暫停心跳。

Flags:

- `--json`: 機器可讀的輸出。

## `system presence`

列出閘道目前所知的系統存在條目（節點、實例及類似狀態行）。

[[BLOCK_1]]

- `--json`: 機器可讀的輸出。

## Notes

- 需要一個可由您當前設定（本地或遠端）訪問的執行中 Gateway。
- 系統事件是短暫的，並且在重啟後不會持久化。
