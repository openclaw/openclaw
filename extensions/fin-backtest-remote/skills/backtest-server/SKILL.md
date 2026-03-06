---
name: backtest-server
description: "Remote Findoo Backtest Agent (fep v1.1). Use when the user wants to run a strategy backtest on the remote server, check task status, fetch full report, list tasks, or cancel a queued task. Flow: submit → poll status → get report when completed."
metadata: { "openclaw": { "requires": { "extensions": ["fin-backtest-remote"] } } }
---

# Remote Backtest Server

When the user talks about **running a backtest**, **submitting a strategy**, **checking backtest status**, **viewing backtest report**, **listing backtest tasks**, or **cancelling a backtest**, use the **remote backtest** tools (not the local `fin_backtest_run`). The remote server runs strategy ZIPs (fep.yaml + scripts/strategy.py) and returns task_id, status, and full reports.

## When to trigger

- User says: 回测、跑回测、策略回测、提交回测、跑策略、用远程回测
- User asks: 回测状态、回测结果、回测报告、有没有回测任务
- User wants: 取消回测、列出回测任务

## Recommended flow

1. **Validate then submit**: For a **directory** (not yet zipped), use `backtest_remote_validate` with `dirPath` first. Only when `valid: true`, zip the directory (e.g. `zip -r ../name.zip fep.yaml scripts/`) then use `backtest_remote_submit` with the ZIP `filePath`. Do not submit without validation.
2. **Poll status**: Use `backtest_remote_status` with the returned `task_id`. Repeat until `status` is `completed`, `failed`, or `rejected`.
3. **Get report**: When `status === "completed"`, use `backtest_remote_report` with the same `task_id` to fetch metadata, performance, equity_curve, trade_journal.
4. **List / Cancel**: Use `backtest_remote_list` (optional `limit`, `offset`) to list tasks; use `backtest_remote_cancel` only for tasks in `queued` state.

## Tools

| Tool                       | Purpose                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------ |
| `backtest_remote_validate` | Validate strategy package dir (fep v1.1) before zip/submit; use first when dir is not yet zipped |
| `backtest_remote_submit`   | POST strategy ZIP; returns task_id (use after validate + zip)                                    |
| `backtest_remote_status`   | GET task status and result_summary                                                               |
| `backtest_remote_report`   | GET full report (only when completed)                                                            |
| `backtest_remote_list`     | GET paginated task list                                                                          |
| `backtest_remote_cancel`   | DELETE a queued task                                                                             |

## Distinction from local backtest

- **Remote** (this skill): `backtest_remote_*` — calls the Findoo Backtest Agent HTTP API; user must have a strategy ZIP and (in production) API key configured.
- **Local**: `fin_backtest_run` — runs on the local BacktestEngine with strategy definitions from the strategy registry; no ZIP upload.

Prefer remote tools when the user explicitly mentions "远程回测" or "回测服务器", or when they have a ZIP path to submit. Prefer local when they refer to existing strategy IDs in the registry.
