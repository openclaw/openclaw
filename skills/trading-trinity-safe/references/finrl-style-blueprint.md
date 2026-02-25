# FinRL-Style Policy Blueprint

This blueprint captures policy-layer patterns inspired by FinRL workflows.

## What to keep

- State -> action mapping between research and execution.
- Risk-aware action shaping: policy should react to volatility and drawdown regime.
- Separation of concerns: policy chooses target exposure, execution handles fills.

## Minimal policy contract

- Inputs per bar:
  - `alpha_score`, `confidence`
  - rolling volatility
  - running drawdown
  - current position
- Output:
  - `target_position` within risk bounds
  - `policy_flags` (e.g., `vol_throttle`, `dd_throttle`)

## Safety improvements applied

- Start with deterministic policy logic; do not require RL model to validate architecture.
- Throttles are hard constraints, not soft suggestions.
- Policy cannot bypass max-position cap.
- Trade suppression band reduces churn from low-confidence signal noise.

