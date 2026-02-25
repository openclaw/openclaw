# LEAN-Style Execution Blueprint

This blueprint models execution controls inspired by LEAN-style architecture.

## What to keep

- Clear execution boundary: policy proposes, execution enforces.
- Cost-aware fill simulation (fees + slippage + turnover constraints).
- Risk-manager style checks before exposure change.
- Traceable event log for every rebalance.

## Minimal execution contract

- Inputs:
  - current position
  - target position
  - close-to-close return
  - fee/slippage settings
- Outputs:
  - filled position
  - transaction cost
  - trade event record

## Safety improvements applied

- Paper-only by default.
- Explicit max turnover per bar.
- Hard block for NaN/inf values.
- Text and CSV artifacts for auditability.

