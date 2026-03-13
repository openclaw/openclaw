---
summary: >-
  CLI reference for `openclaw nodes` (list/status/approve/invoke,
  camera/canvas/screen)
read_when:
  - "You’re managing paired nodes (cameras, screen, canvas)"
  - You need to approve requests or invoke node commands
title: nodes
---

# `openclaw nodes`

管理配對節點（裝置）並呼叫節點功能。

相關資訊：

- 節點總覽：[節點](/nodes)
- 攝影機：[攝影機節點](/nodes/camera)
- 影像：[影像節點](/nodes/images)

常用選項：

- `--url`, `--token`, `--timeout`, `--json`

## 常用指令

```bash
openclaw nodes list
openclaw nodes list --connected
openclaw nodes list --last-connected 24h
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes status
openclaw nodes status --connected
openclaw nodes status --last-connected 24h
```

`nodes list` 會列印待處理/配對的表格。配對的列包含最近的連線時間（最後連線）。
使用 `--connected` 僅顯示目前已連線的節點。使用 `--last-connected <duration>` 可篩選在特定時間內連線的節點（例如 `24h`、`7d`）。

## 呼叫 / 執行

```bash
openclaw nodes invoke --node <id|name|ip> --command <command> --params <json>
openclaw nodes run --node <id|name|ip> <command...>
openclaw nodes run --raw "git status"
openclaw nodes run --agent main --node <id|name|ip> --raw "git status"
```

調用標誌：

- `--params <json>`：JSON 物件字串（預設為 `{}`）。
- `--invoke-timeout <ms>`：節點調用逾時時間（預設為 `15000`）。
- `--idempotency-key <key>`：可選的冪等性鍵。

### Exec 風格的預設值

`nodes run` 模擬模型的 exec 行為（預設值 + 批准）：

- 讀取 `tools.exec.*`（加上 `agents.list[].tools.exec.*` 的覆寫）。
- 在調用 `system.run` 前使用執行批准 (`exec.approval.request`)。
- 當設定 `tools.exec.node` 時，可省略 `--node`。
- 需要一個宣告 `system.run` 的節點（macOS 伴侶應用程式或無頭節點主機）。

標誌：

- `--cwd <path>`：工作目錄。
- `--env <key=val>`：環境變數覆寫（可重複）。注意：節點主機會忽略 `PATH` 的覆寫（且 `tools.exec.pathPrepend` 不會套用於節點主機）。
- `--command-timeout <ms>`：指令逾時。
- `--invoke-timeout <ms>`：節點調用逾時（預設為 `30000`）。
- `--needs-screen-recording`：需要螢幕錄製權限。
- `--raw <command>`：執行 shell 字串（`/bin/sh -lc` 或 `cmd.exe /c`）。
  在 Windows 節點主機的允許清單模式中，執行 `cmd.exe /c` shell-wrapper 需要批准
  （僅允許清單條目不會自動允許 wrapper 形式）。
- `--agent <id>`：代理範圍的批准/允許清單（預設為已設定的代理）。
- `--ask <off|on-miss|always>`、`--security <deny|allowlist|full>`：覆寫。
