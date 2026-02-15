---
summary: "背景執行執行與處理程序管理"
read_when:
  - 新增或修改背景執行行為
  - 偵錯長時間執行的執行任務
title: "背景執行與處理程序工具"
---

# 背景執行 + 處理程序工具

OpenClaw 透過 `exec` 工具執行 shell 命令，並將長時間執行的任務保留在記憶體中。`process` 工具管理這些背景工作階段。

## exec 工具

關鍵參數：

- `command` (必填)
- `yieldMs` (預設 10000)：在此延遲後自動轉為背景執行
- `background` (布林值)：立即轉為背景執行
- `timeout` (秒，預設 1800)：在此逾時後終止處理程序
- `elevated` (布林值)：如果已啟用/允許提升模式，則在主機上執行
- 需要真實的 TTY 嗎？設定 `pty: true`。
- `workdir`、`env`

行為：

- 前景執行直接傳回輸出。
- 當轉為背景執行（明確或逾時）時，該工具會傳回 `status: "running"` + `sessionId` 以及簡短的尾部資訊。
- 輸出會保留在記憶體中，直到工作階段被輪詢或清除。
- 如果 `process` 工具不被允許，`exec` 將同步執行並忽略 `yieldMs`/`background`。

## 子處理程序橋接

當在 exec/process 工具之外產生長時間執行的子處理程序時（例如 CLI 重新生成或 Gateway 輔助程式），請附加子處理程序橋接輔助程式，以便轉發終止訊號，並在退出/錯誤時分離監聽器。這可以避免 systemd 上的孤立處理程序，並保持跨平台關閉行為的一致性。

環境變數覆寫：

- `PI_BASH_YIELD_MS`：預設讓渡時間 (毫秒)
- `PI_BASH_MAX_OUTPUT_CHARS`：記憶體中輸出上限 (字元)
- `OPENCLAW_BASH_PENDING_MAX_OUTPUT_CHARS`：每個串流的待處理標準輸出/標準錯誤上限 (字元)
- `PI_BASH_JOB_TTL_MS`：已完成工作階段的存活時間 (毫秒，限制在 1 分鐘至 3 小時之間)

設定 (推薦)：

- `tools.exec.backgroundMs` (預設 10000)
- `tools.exec.timeoutSec` (預設 1800)
- `tools.exec.cleanupMs` (預設 1800000)
- `tools.exec.notifyOnExit` (預設 true)：當背景執行的執行結束時，將系統事件加入佇列並請求心跳。

## process 工具

動作：

- `list`：執行中 + 已完成的工作階段
- `poll`：擷取工作階段的新輸出 (也會回報結束狀態)
- `log`：讀取彙總輸出 (支援 `offset` + `limit`)
- `write`：傳送標準輸入 (`data`，可選 `eof`)
- `kill`：終止背景工作階段
- `clear`：從記憶體中移除已完成的工作階段
- `remove`：如果正在執行則終止，否則清除已完成的工作階段

注意事項：

- 只有背景工作階段會列出/儲存在記憶體中。
- 處理程序重新啟動時，工作階段會遺失 (無磁碟持久化)。
- 工作階段日誌只有在您執行 `process poll/log` 且工具結果被記錄時才會儲存到聊天歷史紀錄。
- `process` 範圍限定於每個智慧代理；它只會看到由該智慧代理啟動的工作階段。
- `process list` 包含衍生出的 `name` (命令動詞 + 目標)，用於快速掃描。
- `process log` 使用基於行的 `offset`/`limit` (省略 `offset` 可取得最後 N 行)。

## 範例

執行長時間任務並稍後輪詢：

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

傳送標準輸入：

```json
{ "tool": "process", "action": "write", "sessionId": "<id>", "data": "y\n" }
```
