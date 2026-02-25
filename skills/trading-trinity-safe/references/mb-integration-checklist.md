# MB Integration Checklist (Post-Approval)

Use this only after operator approves merge.

## 1) Filesystem and data placement

- Point `TRINITY_EXPORT_DIR` to external SSD path.
- Keep historical datasets and backtest artifacts on external SSD.
- Keep repo code lightweight (no large datasets committed).

## 2) Runtime mode

- Enforce paper mode at first integration.
- Block live execution paths by default.
- Require sentinel + operator approval for any live path enablement.

## 3) Safety controls

- Keep position cap, turnover cap, drawdown and volatility throttles enabled.
- Persist metrics and trade logs for each run.
- Alert on low sample size or unstable metrics.

## 4) Verification before merge

- Run script unit tests.
- Run one baseline backtest and one parameter sweep on known dataset.
- Confirm artifact generation and deterministic outputs.

## 5) Go-live readiness (separate phase)

- Add broker adapter test harness.
- Add kill switch and max-daily-loss at orchestration layer.
- Add approval workflow for first N live orders.

