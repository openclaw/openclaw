---
summary: Background exec execution and process management
read_when:
  - Adding or modifying background exec behavior
  - Debugging long-running exec tasks
title: Background Exec and Process Tool
---

# 背景執行 + 處理工具

OpenClaw 通過 `exec` 工具執行 shell 命令，並將長時間執行的任務保留在記憶體中。`process` 工具負責管理這些背景會話。

## exec tool

關鍵參數：

- `command` (必填)
- `yieldMs` (預設值 10000): 在此延遲後自動背景化
- `background` (布林值): 立即背景化
- `timeout` (秒，預設值 1800): 在此超時後終止進程
- `elevated` (布林值): 如果啟用/允許提升模式則在主機上執行
- 需要真正的 TTY 嗎？設置 `pty: true`。
- `workdir`, `env`

[[BLOCK_1]]

- 前景執行會直接返回輸出。
- 當被放到背景中（明確或超時），工具會返回 `status: "running"` + `sessionId` 以及一個簡短的尾部。
- 輸出會保留在記憶體中，直到會話被輪詢或清除。
- 如果不允許使用 `process` 工具，則 `exec` 會同步執行並忽略 `yieldMs`/`background`。
- 產生的執行命令會接收 `OPENCLAW_SHELL=exec` 以便遵循上下文感知的 shell/profile 規則。

## Child process bridging

當在 exec/process 工具之外產生長時間執行的子進程（例如，CLI 重新生成或網關輔助程式）時，請附加子進程橋接輔助程式，以便終止信號能夠被轉發，並在退出/錯誤時解除監聽器。這樣可以避免在 systemd 上出現孤立進程，並保持跨平台的一致關閉行為。

[[BLOCK_1]]  
環境覆蓋：  
[[BLOCK_1]]

- `PI_BASH_YIELD_MS`: 預設產出延遲 (毫秒)
- `PI_BASH_MAX_OUTPUT_CHARS`: 記憶體內輸出上限 (字元)
- `OPENCLAW_BASH_PENDING_MAX_OUTPUT_CHARS`: 每個串流的待處理 stdout/stderr 上限 (字元)
- `PI_BASH_JOB_TTL_MS`: 完成會話的 TTL (毫秒，範圍為 1 分鐘至 3 小時)

Config (preferred):

- `tools.exec.backgroundMs` (預設值 10000)
- `tools.exec.timeoutSec` (預設值 1800)
- `tools.exec.cleanupMs` (預設值 1800000)
- `tools.exec.notifyOnExit` (預設值 true)：當背景執行結束時，排入系統事件 + 請求心跳。
- `tools.exec.notifyOnExitEmptySuccess` (預設值 false)：當為 true 時，對於沒有產生輸出的成功背景執行也排入完成事件。

## process tool

Actions:

- `list`: 執行中 + 已完成的會話
- `poll`: 排出會話的新輸出（也報告退出狀態）
- `log`: 讀取聚合的輸出（支援 `offset` + `limit`）
- `write`: 發送標準輸入 (`data`，可選 `eof`)
- `kill`: 終止背景會話
- `clear`: 從記憶體中移除已完成的會話
- `remove`: 如果正在執行則終止，否則如果已完成則清除

[[BLOCK_1]]

- 只有背景中的會話會被列出/保存在記憶體中。
- 會話在進程重啟時會丟失（沒有磁碟持久性）。
- 只有在執行 `process poll/log` 並記錄工具結果時，會話日誌才會保存到聊天歷史中。
- `process` 是針對每個代理的範圍；它只會看到該代理啟動的會話。
- `process list` 包含一個衍生的 `name`（命令動詞 + 目標）以便快速掃描。
- `process log` 使用基於行的 `offset`/`limit`。
- 當同時省略 `offset` 和 `limit` 時，它會返回最後 200 行並包含分頁提示。
- 當提供 `offset` 且省略 `limit` 時，它會從 `offset` 返回到結尾（不限制於 200 行）。

## Examples

執行長時間任務並稍後輪詢：

```json
{ "tool": "exec", "command": "sleep 5 && echo done", "yieldMs": 1000 }
```

```json
{ "tool": "process", "action": "poll", "sessionId": "<id>" }
```

立即在背景中啟動：

```json
{ "tool": "exec", "command": "npm run build", "background": true }
```

Send stdin:

```json
{ "tool": "process", "action": "write", "sessionId": "<id>", "data": "y\n" }
```
