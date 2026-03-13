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

管理配對的節點（設備）並調用節點功能。

[[BLOCK_1]]

- 節點概覽: [Nodes](/nodes)
- 相機: [Camera nodes](/nodes/camera)
- 圖片: [Image nodes](/nodes/images)

常見選項：

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

`nodes list` 列印待處理/配對的表格。配對的行包括最近的連接時間（最後連接）。使用 `--connected` 僅顯示當前已連接的節點。使用 `--last-connected <duration>` 來過濾在特定時間內連接的節點（例如 `24h`、`7d`）。

## Invoke / run

```bash
openclaw nodes invoke --node <id|name|ip> --command <command> --params <json>
openclaw nodes run --node <id|name|ip> <command...>
openclaw nodes run --raw "git status"
openclaw nodes run --agent main --node <id|name|ip> --raw "git status"
```

Invoke flags:

- `--params <json>`: JSON 物件字串（預設 `{}`）。
- `--invoke-timeout <ms>`: 節點呼叫超時（預設 `15000`）。
- `--idempotency-key <key>`: 可選的冪等性金鑰。

### Exec-style defaults

`nodes run` 反映了模型的執行行為（預設值 + 批准）：

- 讀取 `tools.exec.*`（加上 `agents.list[].tools.exec.*` 的覆蓋）。
- 在調用 `system.run` 之前使用執行批准 (`exec.approval.request`)。
- 當 `tools.exec.node` 被設置時，可以省略 `--node`。
- 需要一個廣告 `system.run` 的節點（macOS 伴隨應用程式或無頭節點主機）。

Flags:

- `--cwd <path>`: 工作目錄。
- `--env <key=val>`: 環境覆蓋（可重複）。注意：節點主機忽略 `PATH` 覆蓋（且 `tools.exec.pathPrepend` 不適用於節點主機）。
- `--command-timeout <ms>`: 命令超時。
- `--invoke-timeout <ms>`: 節點調用超時（預設 `30000`）。
- `--needs-screen-recording`: 需要螢幕錄影權限。
- `--raw <command>`: 執行一個 shell 字串 (`/bin/sh -lc` 或 `cmd.exe /c`)。
  在 Windows 節點主機的允許清單模式下，`cmd.exe /c` shell-wrapper 需要批准
  （僅有允許清單條目不會自動允許包裝形式）。
- `--agent <id>`: 代理範圍的批准/允許清單（預設為設定的代理）。
- `--ask <off|on-miss|always>`, `--security <deny|allowlist|full>`: 覆蓋。
