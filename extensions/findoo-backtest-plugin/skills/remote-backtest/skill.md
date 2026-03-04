# Remote Backtest (Findoo Backtest Agent)

Run strategy backtests on the remote Findoo Backtest Agent platform.
Covers the full lifecycle: **check → upload → submit → poll → report**.

## Engines

- **L1 (script)**: Deterministic script-based backtest. Fast, reproducible.
- **L2 (agent)**: Agent+LLM intelligent backtest. LLM analyzes market context per period.

## Complete Workflow

### One-liner: "检查并回测本地策略 ./my-strategy"

```
check → upload → submit(wait=true) → return report
```

### Step by step

1. **`fin_backtest_strategy_check`** — Local FEP 1.0 compliance check (structure, interface, safety, YAML, data).
2. **`fin_backtest_remote_upload`** — Pack directory into tar.gz and upload to remote platform.
3. **`fin_backtest_remote_submit`** — Submit backtest using the uploaded `strategy_dir` (default: waits for result).
4. **`fin_backtest_remote_status`** — Check task progress (for async/long L2 runs).
5. **`fin_backtest_remote_list`** — Browse task history.
6. **`fin_backtest_remote_cancel`** — Cancel a queued task.

## Tools

| Tool                          | Purpose                                |
| ----------------------------- | -------------------------------------- |
| `fin_backtest_strategy_check` | Local compliance check (FEP 1.0)       |
| `fin_backtest_remote_upload`  | Pack + upload strategy to remote agent |
| `fin_backtest_remote_submit`  | Submit backtest (sync or async)        |
| `fin_backtest_remote_status`  | Check task status / get report         |
| `fin_backtest_remote_list`    | List task history                      |
| `fin_backtest_remote_cancel`  | Cancel a queued task                   |

## Quick Start

### Check a local strategy

```
Use fin_backtest_strategy_check with:
  strategy_path: "./strategies/momentum_v1"
```

### Upload and backtest

```
Use fin_backtest_remote_upload with:
  strategy_path: "./strategies/momentum_v1"

Then fin_backtest_remote_submit with:
  strategy_dir: <strategy_dir from upload response>
  engine: "script"
  symbol: "BTC-USD"
  start_date: "2024-01-01"
  end_date: "2024-12-31"
  initial_capital: 100000
```

## Compliance Check Dimensions

| Dimension     | What's checked                                            | Level         |
| ------------- | --------------------------------------------------------- | ------------- |
| **structure** | fep.yaml, strategy.py, requirements.txt, risk_manager.py  | error/warning |
| **interface** | Strategy class, execute() method, record_trade() method   | error/warning |
| **safety**    | No os/subprocess/eval/exec; no network imports            | error/warning |
| **yaml**      | Section A (identity) + Section B (classification) present | error         |
| **data**      | fep.yaml symbols match strategy.py usage                  | warning       |

## L2 Agent Parameters

When using `engine: "agent"`:

- `budget_cap_usd`: Max LLM cost per backtest
- `max_turns_per_period`: Agent reasoning depth per bar
- `agent_model`: LLM model (e.g. "gpt-4o", "claude-sonnet-4-20250514")
- `reflection_interval`: Bars between meta-reflection steps

## Configuration

| Setting | Env Var            | Default                 |
| ------- | ------------------ | ----------------------- |
| API URL | `BACKTEST_API_URL` | `http://localhost:8000` |
| API Key | `BACKTEST_API_KEY` | (none)                  |

Set in OpenClaw config or environment variables.
