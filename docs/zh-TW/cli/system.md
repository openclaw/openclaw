---
summary: "「openclaw system」的 CLI 參考（系統事件、心跳、存在狀態）"
read_when:
  - 你想在不建立 cron 工作的情況下佇列系統事件
  - 你需要啟用或停用心跳
  - 31. 你想要檢視系統存在性項目
title: "system"
---

# `openclaw system`

Gateway 的系統層級輔助工具：佇列系統事件、控制心跳，
以及檢視存在狀態。

## Common commands

```bash
openclaw system event --text "Check for urgent follow-ups" --mode now
openclaw system heartbeat enable
openclaw system heartbeat last
openclaw system presence
```

## `system event`

32. 在**主要**工作階段上排入一個系統事件。 33. 下一次心跳將會把
    它以 `System:` 行的形式注入到提示中。 在 **main** 工作階段上佇列一個系統事件。下一次心跳會將其注入
    為提示中的一行 `System:`。使用 `--mode now` 立即觸發心跳；
    `next-heartbeat` 則等待下一個排程的節點。

Flags:

- `--text <text>`: 必要的系統事件文字。
- `--mode <mode>`: `now` 或 `next-heartbeat`（預設）。
- `--json`: 機器可讀輸出。

## `system heartbeat last|enable|disable`

心跳控制：

- `last`: 顯示最近一次心跳事件。
- `enable`: 重新開啟心跳（若先前被停用，請使用此項）。
- `disable`: 暫停心跳。

Flags:

- `--json`: 機器可讀輸出。

## `system presence`

列出 Gateway 目前已知的系統存在狀態項目（節點、
實例，以及類似的狀態行）。

Flags:

- `--json`: 機器可讀輸出。

## Notes

- 需要可透過你目前的設定（本機或遠端）連線的執行中 Gateway。
- 系統事件是暫時性的，重新啟動後不會被保留。
