---
summary: "「openclaw nodes」（list/status/approve/invoke、camera/canvas/screen）的 CLI 參考"
read_when:
  - 你正在管理已配對的節點（攝影機、螢幕、畫布）
  - 你需要核准請求或呼叫節點指令
title: "nodes"
x-i18n:
  source_path: cli/nodes.md
  source_hash: 23da6efdd659a82d
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:27:23Z
---

# `openclaw nodes`

管理已配對的節點（裝置），並呼叫節點能力。

相關內容：

- Nodes 概覽：[Nodes](/nodes)
- Camera：[Camera nodes](/nodes/camera)
- Images：[Image nodes](/nodes/images)

常用選項：

- `--url`、`--token`、`--timeout`、`--json`

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

`nodes list` 會列印待處理／已配對的表格。已配對的列會包含最近一次連線的時間長度（Last Connect）。
使用 `--connected` 只顯示目前已連線的節點。使用 `--last-connected <duration>` 來
篩選在指定時間長度內連線的節點（例如 `24h`、`7d`）。

## Invoke / run

```bash
openclaw nodes invoke --node <id|name|ip> --command <command> --params <json>
openclaw nodes run --node <id|name|ip> <command...>
openclaw nodes run --raw "git status"
openclaw nodes run --agent main --node <id|name|ip> --raw "git status"
```

Invoke 旗標：

- `--params <json>`：JSON 物件字串（預設為 `{}`）。
- `--invoke-timeout <ms>`：節點 invoke 逾時（預設為 `15000`）。
- `--idempotency-key <key>`：選用的冪等鍵。

### Exec 風格預設值

`nodes run` 會鏡射模型的 exec 行為（預設值＋核准）：

- 讀取 `tools.exec.*`（以及 `agents.list[].tools.exec.*` 覆寫）。
- 在呼叫 `system.run` 之前使用 exec 核准（`exec.approval.request`）。
- 當設定 `tools.exec.node` 時，可以省略 `--node`。
- 需要宣告 `system.run` 的節點（macOS 配套應用程式或無介面節點主機）。

旗標：

- `--cwd <path>`：工作目錄。
- `--env <key=val>`：env 覆寫（可重複）。
- `--command-timeout <ms>`：指令逾時。
- `--invoke-timeout <ms>`：節點 invoke 逾時（預設為 `30000`）。
- `--needs-screen-recording`：需要螢幕錄製權限。
- `--raw <command>`：執行 shell 字串（`/bin/sh -lc` 或 `cmd.exe /c`）。
- `--agent <id>`：代理程式範圍的核准／允許清單（預設為已設定的代理程式）。
- `--ask <off|on-miss|always>`、`--security <deny|allowlist|full>`：覆寫。
