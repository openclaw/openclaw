---
summary: "「openclaw nodes」的 CLI 參考指南（list/status/approve/invoke，相機/畫布/螢幕）"
read_when:
  - 您正在管理已配對的節點（相機、螢幕、畫布）
  - 您需要核准請求或調用節點指令
title: "nodes"
---

# `openclaw nodes`

管理已配對的節點（裝置）並調用節點功能。

相關內容：

- 節點概覽：[Nodes](/nodes)
- 相機：[相機節點](/nodes/camera)
- 圖片：[圖片節點](/nodes/images)

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

`nodes list` 會印出待處理/已配對的表格。已配對的資料列包含最近一次連線的時間（Last Connect）。
使用 `--connected` 僅顯示目前已連線的節點。使用 `--last-connected <duration>` 來過濾在特定時間範圍內連線的節點（例如：`24h`、`7d`）。

## 調用 / 執行

```bash
openclaw nodes invoke --node <id|name|ip> --command <command> --params <json>
openclaw nodes run --node <id|name|ip> <command...>
openclaw nodes run --raw "git status"
openclaw nodes run --agent main --node <id|name|ip> --raw "git status"
```

Invoke 標記：

- `--params <json>`：JSON 物件字串（預設為 `{}`）。
- `--invoke-timeout <ms>`：節點調用超時（預設為 `15000`）。
- `--idempotency-key <key>`：選用的等冪鍵（idempotency key）。

### Exec 樣式預設值

`nodes run` 鏡射了模型的 exec 行為（預設值 + 核准）：

- 讀取 `tools.exec.*`（加上 `agents.list[].tools.exec.*` 的覆寫設定）。
- 在調用 `system.run` 之前，會使用 exec 核准（`exec.approval.request`）。
- 當已設定 `tools.exec.node` 時，可以省略 `--node`。
- 需要一個宣告支援 `system.run` 的節點（macOS 配套應用或無介面節點主機）。

標記：

- `--cwd <path>`：工作目錄。
- `--env <key=val>`：環境變數覆寫（可重複使用）。
- `--command-timeout <ms>`：指令超時。
- `--invoke-timeout <ms>`：節點調用超時（預設為 `30000`）。
- `--needs-screen-recording`：需要螢幕錄製權限。
- `--raw <command>`：執行 Shell 字串（`/bin/sh -lc` 或 `cmd.exe /c`）。
- `--agent <id>`：智慧代理範圍的核准/允許清單（預設為已設定的智慧代理）。
- `--ask <off|on-miss|always>`, `--security <deny|allowlist|full>`：覆寫設定。
