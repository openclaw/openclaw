---
summary: "Gateway 的 CLI 參考 (系統事件、心跳、在線狀態)"
read_when:
  - 您想在不建立排程作業的情況下，將系統事件排入佇列
  - 您需要啟用或停用心跳
  - 您想檢查系統在線狀態項目
title: "system"
---

# `openclaw system`

Gateway 的系統層級輔助工具：將系統事件排入佇列、控制心跳，以及檢視在線狀態。

## 常見指令

```bash
openclaw system event --text "Check for urgent follow-ups" --mode now
openclaw system heartbeat enable
openclaw system heartbeat last
openclaw system presence
```

## `system event`

將系統事件排入**主要**工作階段的佇列。下一個心跳會將其作為 `System:` 行注入提示。使用 `--mode now` 可立即觸發心跳；`next-heartbeat` 則等待下一個排定的心跳。

旗標：

- `--text <text>`：必要的系統事件文字。
- `--mode <mode>`：`now` 或 `next-heartbeat` (預設)。
- `--json`：機器可讀的輸出。

## `system heartbeat last|enable|disable`

心跳控制：

- `last`：顯示最後一個心跳事件。
- `enable`：重新開啟心跳（如果已停用則使用此選項）。
- `disable`：暫停心跳。

旗標：

- `--json`：機器可讀的輸出。

## `system presence`

列出 Gateway 已知的當前系統在線狀態項目 (節點、實例和類似的狀態行)。

旗標：

- `--json`：機器可讀的輸出。

## 注意事項

- 需要一個正在運行的 Gateway，並且可透過您當前的設定 (本機或遠端) 連線。
- 系統事件是暫時性的，不會在重新啟動後持續存在。
