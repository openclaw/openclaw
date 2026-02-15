---
summary: "背景執行與處理程序管理"
read_when:
  - 新增或修改背景執行行為時
  - 偵錯長時間執行的 exec 工作時
title: "背景執行與 Process 工具"
---

# 背景執行 + Process 工具

OpenClaw 透過 `exec` 工具執行 Shell 指令，並將長時間執行的工作保留在記憶體中。`process` 工具則用來管理這些背景工作階段。

## exec 工具

關鍵參數：

- `command` (必要)
- `yieldMs` (預設 10000)：在此延遲後自動切換至背景執行
- `background` (布林值)：立即在背景執行
- `timeout` (秒，預設 1800)：超時後終止該處理程序
- `elevated` (布林值)：若啟用/允許提升權限模式，則在主機上執行
- 需要真實的 TTY？請設定 `pty: true`。
- `workdir`, `env`

行為：

- 前景執行會直接回傳輸出結果。
- 當切換至背景執行時（明確要求或因超時），該工具會回傳 `status: "running"` + `sessionId` 以及簡短的尾端輸出。
- 輸出內容會保留在記憶體中，直到該工作階段被輪詢 (poll) 或清除。
- 若不允許使用 `process` 工具，`exec` 將以同步方式執行，並忽略 `yieldMs`/`background`。

## 子處理程序橋接 (Child process bridging)

當在 exec/process 工具之外產生長時間執行的子處理程序時（例如 CLI 重啟或 Gateway 輔助程式），請掛載子處理程序橋接輔助程式 (child-process bridge helper)，以便轉發終止訊號並在結束/錯誤時卸載接聽程式。這可避免在 systemd 上產生孤兒處理程序，並保持各平台間關機行為的一致性。

環境變數覆蓋：

- `PI_BASH_YIELD_MS`：預設移交背景時間 (毫秒)
- `PI_BASH_MAX_OUTPUT_CHARS`：記憶體輸出上限 (字元)
- `OPENCLAW_BASH_PENDING_MAX_OUTPUT_CHARS`：每個串流的待處理 stdout/stderr 上限 (字元)
- `PI_BASH_JOB_TTL_MS`：已結束工作階段的存活時間 (TTL) (毫秒，範圍限制在 1 分鐘至 3 小時之間)

設定 (建議方式)：

- `tools.exec.backgroundMs` (預設 10000)
- `tools.exec.timeoutSec` (預設 1800)
- `tools.exec.cleanupMs` (預設 1800000)
- `tools.exec.notifyOnExit` (預設 true)：當背景執行的 exec 結束時，將系統事件排入佇列並請求活動訊號 (heartbeat)。

## process 工具

操作動作：

- `list`：執行中與已結束的工作階段
- `poll`：提取工作階段的新輸出（同時報告結束狀態）
- `log`：讀取彙總輸出（支援 `offset` + `limit`）
- `write`：傳送標準輸入 stdin (`data`, 選填 `eof`)
- `kill`：終止背景工作階段
- `clear`：從記憶體中移除已結束的工作階段
- `remove`：若正在執行則終止，若已結束則清除

注意事項：

- 只有背景執行的工作階段會列出或保留在記憶體中。
- 工作階段在處理程序重啟時會遺失（不進行磁碟持續化）。
- 只有當你執行 `process poll/log` 且工具結果被記錄時，工作階段日誌才會儲存到對話紀錄中。
- `process` 的範圍限定於每個智慧代理；它只能看到由該智慧代理啟動的工作階段。
- `process list` 包含一個衍生的名稱（指令動詞 + 目標），方便快速瀏覽。
- `process log` 使用以行為單位的 `offset`/`limit`（省略 `offset` 則擷取最後 N 行）。

## 範例

執行長時間工作並在稍後進行輪詢：

```json
{ "tool": "exec", "command": "sleep 5 && echo done", "yieldMs": 1000 }
```

```json
{ "tool": "process", "action": "poll", "sessionId": "<id>" }
```

立即在背景啟動：

```json
{ "tool": "exec", "command": "npm run build", "background": true }
```

傳送標準輸入 (stdin)：

```json
{ "tool": "process", "action": "write", "sessionId": "<id>", "data": "y\n" }
```
