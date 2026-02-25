# Safety Gates (Fail-Closed)

Use these gates before considering any merge into MB runtime.

## Gate 1: Data integrity

- CSV must include at least `date` and `close`.
- At least 80 rows required.
- No NaN/inf in parsed close series.
- Close values must be positive.

## Gate 2: Runtime safety

- No live order endpoints.
- No dynamic `eval`/`exec`.
- No remote code fetch.
- No automatic dependency install at runtime.

## Gate 3: Risk controls

- Position cap enforced every bar.
- Turnover cap enforced every bar.
- Volatility throttle available.
- Drawdown throttle available.

## Gate 4: Backtest quality

- Must output metrics and trade/equity artifacts.
- Must report warning if trade count is too low for significance.
- Must expose defaults used for reproducibility.

## Gate 5: Live-trade block

Live mode remains blocked until:

- explicit operator approval,
- sentinel approval flag,
- separate deployment checklist completion.

