---
summary: "關於 `openclaw system` 的 CLI 參考文件（系統事件、心跳、上線狀態）"
read_when:
  - "當你想在不建立 cron 工作的情況下將系統事件排入佇列"
  - "當你需要啟用或停用心跳 (heartbeats)"
  - "當你想檢查系統上線狀態 (presence) 項目"
title: "system"
---

# `openclaw system`

Gateway 的系統級輔助工具：將系統事件排入佇列、控制心跳 (heartbeats) 以及查看上線狀態 (presence)。

## 常見指令

```bash
openclaw system event --text "Check for urgent follow-ups" --mode now
openclaw system heartbeat enable
openclaw system heartbeat last
openclaw system presence
```

## `system event`

在 **main** 工作階段中將一個系統事件排入佇列。下一次心跳會將其作為 `System:` 行插入提示詞中。使用 `--mode now` 立即觸發心跳；`next-heartbeat` 則等待下一次排定的週期 (tick)。

參數：

- `--text <text>`：必填，系統事件文字。
- `--mode <mode>`：`now` 或 `next-heartbeat`（預設）。
- `--json`：機器可讀的輸出格式。

## `system heartbeat last|enable|disable`

心跳控制：

- `last`：顯示最後一次心跳事件。
- `enable`：重新啟用心跳（若先前已停用則使用此項）。
- `disable`：暫停心跳。

參數：

- `--json`：機器可讀的輸出格式。

## `system presence`

列出 Gateway 目前已知的所有系統上線狀態項目（節點、執行個體及類似的狀態行）。

參數：

- `--json`：機器可讀的輸出格式。

## 注意事項

- 需要一個可透過目前設定（本機或遠端）連線且正在運行的 Gateway。
- 系統事件是暫時性的，重新啟動後不會保留。
