```
---
summary: "OpenClaw CLI 參考，適用於 `openclaw nodes`（列出/狀態/核准/調用，攝影機/畫布/螢幕）"
read_when:
  - 您正在管理已配對的節點（攝影機、螢幕、畫布）
  - 您需要核准請求或調用節點命令
title: "節點"
---

# `openclaw nodes`

管理已配對的節點（裝置）並調用節點功能。

相關：

- 節點概覽：[節點](/nodes)
- 攝影機：[攝影機節點](/nodes/camera)
- 圖片：[圖片節點](/nodes/images)

通用選項：

- `--url`, `--token`, `--timeout`, `--json`

## 通用命令

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

`nodes list` 列印待處理/已配對表格。已配對的行包含最近連線時間（Last Connect）。
使用 `--connected` 僅顯示當前已連線的節點。使用 `--last-connected <duration>` 篩選
在指定期間內（例如 `24h`, `7d`）連線的節點。

## 調用 / 執行

```bash
openclaw nodes invoke --node <id|name|ip> --command <command> --params <json>
openclaw nodes run --node <id|name|ip> <command...>
openclaw nodes run --raw "git status"
openclaw nodes run --agent main --node <id|name|ip> --raw "git status"
```

調用旗標：

- `--params <json>`：JSON 物件字串（預設 `{}`）。
- `--invoke-timeout <ms>`：節點調用逾時（預設 `15000`）。
- `--idempotency-key <key>`：選用冪等性鍵。

### 執行樣式預設值

`nodes run` 模擬模型的執行行為（預設值 + 核准）：

- 讀取 `tools.exec.*`（以及 `agents.list[].tools.exec.*` 覆寫）。
- 在調用 `system.run` 之前使用執行核准（`exec.approval.request`）。
- 當設定 `tools.exec.node` 時，可以省略 `--node`。
- 需要宣傳 `system.run` 的節點（macOS 配套應用程式或無頭節點主機）。

旗標：

- `--cwd <path>`：工作目錄。
- `--env <key=val>`：環境變數覆寫（可重複）。
- `--command-timeout <ms>`：命令逾時。
- `--invoke-timeout <ms>`：節點調用逾時（預設 `30000`）。
- `--needs-screen-recording`：需要螢幕錄製權限。
- `--raw <command>`：執行 Shell 字串（`/bin/sh -lc` 或 `cmd.exe /c`）。
- `--agent <id>`：智慧代理範圍的核准/允許清單（預設為已設定的智慧代理）。
- `--ask <off|on-miss|always>`, `--security <deny|allowlist|full>`：覆寫。
```
