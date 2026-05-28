---
name: openclaw-okx-cex-status
description: OpenClaw-native OKX CEX read-only status gate for market quotes, credential health, and hard safety blockers without placing or cancelling orders.
metadata:
  {
    "openclaw":
      {
        "requires": { "bins": ["node"] },
        "safety":
          {
            "readOnly": true,
            "localConfigOnly": true,
            "liveTradingEnabled": false,
            "writeTradingEnabled": false,
            "withdrawalEnabled": false,
            "orderPlacementEnabled": false,
            "usesCodexGlobalSkillAsRuntime": false,
          },
      },
  }
---

# OpenClaw OKX CEX Status

Use this skill when OpenClaw needs to inspect OKX CEX market-data availability, local API profile health, or credential safety policy from inside `D:\OpenClaw`.

## Scope

- Reads OKX public market data through the local OKX CLI.
- Reads all OKX public ticker groups through snapshot mode for `SPOT`, `SWAP`, `FUTURES`, and `OPTION`.
- Runs a one-second read-only ticker loop for `SPOT`, `SWAP`, `FUTURES`, and `OPTION` when fast trading context needs fresh market data.
- Reads masked local OKX config and account-config health only.
- Uses local `C:\Users\user\.okx\config.toml` or `OPENCLAW_OKX_CONFIG_PATH`.
- Does not accept API keys, secret keys, or passphrases from chat.
- Does not write API keys, secret keys, passphrases, balances, positions, or account identifiers into the repo.
- Does not place, cancel, amend, transfer, withdraw, or enable orders.
- Can generate a dry-run-only order proposal report through OpenClaw, but the proposal is non-actionable and never submits an order.
- Can generate a read-only order/cancel status report through OpenClaw, but it does not query private order endpoints unless a submitted order id exists and does not cancel orders.
- Can generate a local demo-only order lifecycle simulation result, but it never writes to OKX, never creates an exchange order id, and never enables cancellation.
- Does not depend on Codex global OKX skills as a formal OpenClaw runtime source.
- Treats any chat-posted key as compromised and requires rotation.
- Blocks keys with withdraw permission before any OpenClaw promotion work.
- Blocks trade or withdraw permission when IP allowlist is blank.

## Commands

Generate the OpenClaw OKX status report:

```powershell
pnpm okx:api-status
```

Writes:

```text
reports\hermes-agent\state\openclaw-okx-api-status-gate-latest.json
reports\hermes-agent\state\openclaw-okx-api-status-gate-latest.json.sha256
```

Run the contract check:

```powershell
pnpm okx:api-status:check
```

Generate the read-only all-market snapshot:

```powershell
pnpm okx:market-snapshot
```

Writes:

```text
reports\hermes-agent\state\openclaw-okx-market-snapshot-gate-latest.json
reports\hermes-agent\state\openclaw-okx-market-snapshot-gate-latest.json.sha256
```

Run the all-market snapshot check:

```powershell
pnpm okx:market-snapshot:check
```

Install the OpenClaw cron scheduler for read-only market snapshots:

```powershell
pnpm okx:market-snapshot:scheduler
```

Writes:

```text
.openclaw\cron\jobs.json
.openclaw\cron\jobs-state.json
reports\hermes-agent\state\openclaw-okx-market-snapshot-scheduler-latest.json
reports\hermes-agent\state\openclaw-okx-market-snapshot-scheduler-latest.json.sha256
```

Run the scheduler contract check:

```powershell
pnpm okx:market-snapshot:scheduler:check
```

Start the read-only one-second market loop:

```powershell
pnpm okx:market-loop
```

Writes:

```text
reports\hermes-agent\state\openclaw-okx-market-snapshot-loop-latest.json
reports\hermes-agent\state\openclaw-okx-market-snapshot-loop-latest.json.sha256
```

Run the one-second loop contract check:

```powershell
pnpm okx:market-loop:check
```

Generate the paper-only strategy signal gate report:

```powershell
pnpm okx:paper-signal
```

Writes:

```text
reports\hermes-agent\state\openclaw-okx-paper-signal-gate-latest.json
reports\hermes-agent\state\openclaw-okx-paper-signal-gate-latest.json.sha256
```

Run the paper-only strategy signal gate check:

```powershell
pnpm okx:paper-signal:check
```

Generate the dry-run-only order proposal report:

```powershell
pnpm okx:order-proposal
```

Writes:

```text
reports\hermes-agent\state\openclaw-okx-order-proposal-gate-latest.json
reports\hermes-agent\state\openclaw-okx-order-proposal-gate-latest.json.sha256
```

Run the proposal contract check:

```powershell
pnpm okx:order-proposal:check
```

Generate the read-only order/cancel status report:

```powershell
pnpm okx:order-status
```

Writes:

```text
reports\hermes-agent\state\openclaw-okx-order-status-gate-latest.json
reports\hermes-agent\state\openclaw-okx-order-status-gate-latest.json.sha256
```

Run the order/cancel status contract check:

```powershell
pnpm okx:order-status:check
```

Generate the standalone demo-only simulation result:

```powershell
pnpm okx:demo-simulation
```

Writes:

```text
reports\hermes-agent\state\openclaw-okx-demo-order-simulation-result-gate-latest.json
reports\hermes-agent\state\openclaw-okx-demo-order-simulation-result-gate-latest.json.sha256
```

Run the demo simulation result contract check:

```powershell
pnpm okx:demo-simulation:check
```

Append the demo simulation result to the paper audit log:

```powershell
pnpm okx:paper-audit-log
```

Writes:

```text
reports\hermes-agent\state\openclaw-okx-paper-audit-log.jsonl
reports\hermes-agent\state\openclaw-okx-paper-audit-log-latest.json
reports\hermes-agent\state\openclaw-okx-paper-audit-log-latest.json.sha256
```

Run the paper audit log contract check:

```powershell
pnpm okx:paper-audit-log:check
```

Generate the read-only paper audit summary:

```powershell
pnpm okx:paper-audit-summary
```

Writes:

```text
reports\hermes-agent\state\openclaw-okx-paper-audit-summary-latest.json
reports\hermes-agent\state\openclaw-okx-paper-audit-summary-latest.json.sha256
```

Run the paper audit summary contract check:

```powershell
pnpm okx:paper-audit-summary:check
```

Generate the read-only current readiness summary. This gate also checks source freshness so stale market/scheduler/demo/audit/Telegram reports cannot be promoted as ready:

```powershell
pnpm okx:current-readiness
```

Writes:

```text
reports\hermes-agent\state\openclaw-okx-current-readiness-summary-latest.json
reports\hermes-agent\state\openclaw-okx-current-readiness-summary-latest.json.sha256
```

Run the current readiness summary contract check:

```powershell
pnpm okx:current-readiness:check
```

Refresh all current-readiness source reports in the safe order:

```powershell
pnpm okx:current-readiness:refresh
```

Writes:

```text
reports\hermes-agent\state\openclaw-okx-current-readiness-refresh-workflow-latest.json
reports\hermes-agent\state\openclaw-okx-current-readiness-refresh-workflow-latest.json.sha256
```

Run the refresh workflow contract check:

```powershell
pnpm okx:current-readiness:refresh:check
```

Generate the heartbeat operation entry for stale current-readiness recovery. The default command only reports whether refresh is needed and exposes the safe one-click command:

```powershell
pnpm okx:current-readiness:heartbeat
```

Execute the safe refresh from a heartbeat operation when stale blockers are present:

```powershell
pnpm okx:current-readiness:heartbeat:execute
```

Writes:

```text
reports\hermes-agent\state\openclaw-okx-current-readiness-heartbeat-operation-latest.json
reports\hermes-agent\state\openclaw-okx-current-readiness-heartbeat-operation-latest.json.sha256
```

Run the heartbeat operation contract check:

```powershell
pnpm okx:current-readiness:heartbeat:check
```

## Telegram Visual Status

The paper audit summary is visible in Telegram without reading the JSONL audit log contents:

- `sc:tr:platform` shows the OKX Paper Audit block from `trading.snapshot`.
- `sc:tr:okxstat` shows the same Paper Audit summary on the standalone OKX order-status panel.
- `sc:tr:assist` shows the machine-readable closure line in the simulation assistant fast status strip.
- `sc:tr:okx` shows the OKX Current Readiness block from `openclaw-okx-current-readiness-summary-latest.json`.
- `sc:tr:okx` also shows the OKX market snapshot scheduler block from `openclaw-okx-market-snapshot-scheduler-latest.json`, including next refresh time and `noOrderWrite=true`.
- `sc:tr:okxrefresh` starts the safe current-readiness refresh workflow through `pnpm okx:current-readiness:refresh`.
- `pnpm okx:current-readiness:heartbeat` exposes the same safe refresh as a heartbeat operation entry, and `pnpm okx:current-readiness:heartbeat:execute` runs only the existing read-only refresh workflow.
- `sc:tr:assist` also shows the machine-readable current-readiness closure line.

The Telegram shortcut gate must report:

```text
okxPaperAudit=pass platform=read+visible okxstat=read+visible report=reports/hermes-agent/state/openclaw-okx-paper-audit-summary-latest.json noOrderWrite=true
okxCurrentReadiness=ready okx=read+visible scheduler=read+visible assist=read+visible refresh=available report=reports/hermes-agent/state/openclaw-okx-current-readiness-summary-latest.json freshness=ok noOrderWrite=true
```

Validate the Telegram visibility surface:

```powershell
pnpm capital-hft:telegram-trading-shortcuts:check
```

## Status Contract

The report must include:

- `quote_ok` when public OKX market data is readable.
- `spot_snapshot_ok`, `swap_snapshot_ok`, `futures_snapshot_ok`, and `option_snapshot_ok` when all public market groups are readable.
- `okxMarketSnapshotScheduler=pass`, `entrypoint=okx:market-snapshot`, and `noOrderWrite=true` when the OpenClaw cron scheduler is installed.
- `spot_loop_ok`, `swap_loop_ok`, `futures_loop_ok`, and `option_loop_ok` when the one-second read-only market loop is healthy.
- `paper_signal_ready` or `paper_signal_ready_with_policy_warnings` when paper-only signal candidates are available from the loop report.
- `demo_ok`, `demo_401`, `demo_missing`, or `demo_blocked`.
- `live_ok`, `live_401`, `live_missing`, or `live_blocked`.
- `order_not_enabled` until a separate dry-run proposal gate exists.
- `chat_supplied_secret_must_rotate` after any credential is posted in chat, until `reports/hermes-agent/state/openclaw-okx-credential-rotation-receipt.json` proves the exposed key was revoked and the replacement key is local-only.
- `withdraw_permission_blocked` unless the local rotation receipt proves the replacement key has no withdraw permission.
- `blank_ip_with_trade_or_withdraw_blocked` unless the local rotation receipt proves the key is read-only or write-capable access is IP-allowlisted.
- `execution_not_enabled`, `submission_command_empty`, and `submitted_order_false` for the dry-run proposal gate.
- `order_status_read_only`, `submitted_order_false`, and `cancel_not_enabled` for the order/cancel status gate.
- `demo_simulation_blocked` or `demo_simulation_no_exchange_write` for the local demo-only lifecycle simulation proof.
- `demo_order_simulation_result_ready`, `exchange_write_false`, `order_status_query_false`, and `cancel_submitted_false` for the standalone demo simulation result gate.
- `paper_audit_log_ready`, `append_only_audit`, `exchange_write_false`, and `cancel_submitted_false` for the paper audit log gate.
- `paper_audit_summary_ready`, `read_only_audit_summary`, `exchange_write_false`, and `cancel_submitted_false` for the paper audit summary gate.
- `okxPaperAuditClosure.machineLine` with `noOrderWrite=true` for Telegram visibility across `sc:tr:platform`, `sc:tr:okxstat`, and `sc:tr:assist`.
- `okxCurrentReadinessClosure.machineLine` with `refresh=available` and `noOrderWrite=true` for Telegram visibility across `sc:tr:okx`, `sc:tr:okxrefresh`, and `sc:tr:assist`.
- `sc:tr:okx` status visibility for `openclaw-okx-market-snapshot-scheduler-latest.json`, including `nextRunAt`, `okxMarketSnapshotScheduler=pass`, and `noOrderWrite=true`.
- `okx_current_readiness_ready`, `read_only_current_summary`, `quote_snapshot_ok`, `market_snapshot_scheduler_ready`, `market_snapshot_scheduler_next_run_current`, `demo_simulation_ready`, `paper_audit_summary_ready`, and `telegram_closure_ready` for the current readiness summary gate.
- `current_readiness_refresh_workflow_ready`, `read_only_refresh_workflow`, `source_freshness_ok`, and `noOrderWrite=true` for the current-readiness refresh workflow.
- `okxCurrentReadinessHeartbeat=refresh_available`, `telegram=sc:tr:okxrefresh`, `command=okx:current-readiness:refresh`, `read_only_heartbeat_operation`, and `noOrderWrite=true` for the heartbeat operation entry.

## Promotion Rule

Before any future OKX trading proposal work, the key must be newly rotated, local-only, read-only, and proven by `openclaw-okx-credential-rotation-receipt.json`; write-capable promotion still requires IP allowlisting and a separate approval gate. The all-market snapshot gate is public-data and snapshot-only. The scheduler installs one isolated cron job every 5 minutes, uses an `agentTurn` payload, allows only `exec/read`, runs only `pnpm okx:market-snapshot` and `pnpm okx:market-snapshot:check`, and keeps private order queries, order writes, cancellation, live trading, transfer, withdrawal, and account reads disabled. The market loop runs every second but remains public-data/read-only and does not submit, cancel, amend, or promote orders. The paper-signal gate consumes loop output to produce paper-only candidates and still keeps `submittedOrder=false`. The current order proposal gate is dry-run only, uses a zero-size non-actionable placeholder, writes no submission command, and never places orders. The order/cancel status gate records the official read/write endpoint map and a local demo-only lifecycle simulation while keeping private order queries, cancellation, live trading, withdrawals, order writes, and real account promotion disabled unless a separate human approval gate is created and validated. The demo simulation result gate extracts that local result into a standalone report and keeps exchange writes, order-status queries, and cancellation disabled. The paper audit log gate appends only the non-secret demo simulation result, digest, and safety flags to JSONL. The paper audit summary gate reads that JSONL only and blocks if any entry shows order submission, exchange writes, private order queries, cancellation, live trading, or credential exposure. Telegram visibility is status-only and must preserve `noOrderWrite=true`. The current readiness summary only joins existing local OKX/Telegram reports and remains `readOnly`, `summaryOnly`, and `noOrderWrite=true`. The refresh workflow only reruns those source report gates in order and keeps private order queries, order writes, cancellation, withdrawal, and live trading disabled. The heartbeat operation entry only exposes or invokes that same safe refresh workflow and keeps private order queries, order writes, cancellation, withdrawal, and live trading disabled.

## Rollback

Delete this skill folder and remove the `okx:api-status`, `okx:market-snapshot`, `okx:market-snapshot:scheduler`, `okx:market-loop`, `okx:paper-signal`, `okx:order-proposal`, `okx:order-status`, `okx:demo-simulation`, `okx:paper-audit-log`, `okx:paper-audit-summary`, `okx:current-readiness`, `okx:current-readiness:refresh`, and `okx:current-readiness:heartbeat` scripts from `package.json`. Remove the `OKX market snapshot read-only refresh` job from `.openclaw\cron\jobs.json` and `.openclaw\cron\jobs-state.json`. No broker, exchange, or account state is modified by this skill.
