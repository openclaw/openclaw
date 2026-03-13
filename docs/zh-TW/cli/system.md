---
summary: "CLI reference for `openclaw system` (system events, heartbeat, presence)"
read_when:
  - You want to enqueue a system event without creating a cron job
  - You need to enable or disable heartbeats
  - You want to inspect system presence entries
title: system
---

# `openclaw system`

Gateway 的系統層級輔助工具：排入系統事件、控制心跳，並查看存在狀態。

## 常用指令

```bash
openclaw system event --text "Check for urgent follow-ups" --mode now
openclaw system heartbeat enable
openclaw system heartbeat last
openclaw system presence
```

## `system event`

在**主要**會話中排入系統事件。下一次心跳時，會將其注入為提示字元中的 `System:` 行。使用 `--mode now` 可立即觸發心跳；`next-heartbeat` 則會等待下一個預定的心跳週期。

參數：

- `--text <text>`：必填的系統事件文字。
- `--mode <mode>`：`now` 或 `next-heartbeat`（預設）。
- `--json`：機器可讀輸出。

## `system heartbeat last|enable|disable`

心跳控制：

- `last`：顯示最後一次心跳事件。
- `enable`：重新啟用心跳（若之前被停用時使用）。
- `disable`：暫停心跳。

參數：

- `--json`：機器可讀輸出。

## `system presence`

列出 Gateway 目前已知的系統存在條目（節點、實例及類似狀態行）。

Flags:

- `--json`：機器可讀輸出。

## 備註

- 需要有一個可由您目前設定（本地或遠端）存取的 Gateway 正在執行。
- 系統事件是短暫的，重啟後不會被保存。
