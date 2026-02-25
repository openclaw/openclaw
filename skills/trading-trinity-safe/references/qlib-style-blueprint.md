# Qlib-Style Research Blueprint

This blueprint extracts reusable design patterns from Qlib-style quant research systems.

## What to keep

- Factor-first modeling: derive multiple interpretable features from price/volume.
- Offline research loop: train/evaluate outside execution runtime.
- Normalized output contract: research emits bounded alpha and confidence.
- Strict anti-leakage sequencing: features only from history up to `t`.

## Minimal research contract

- Input:
  - ordered bars (`date`, `open`, `high`, `low`, `close`, `volume`)
- Output per bar:
  - `alpha_score` in `[-1, 1]`
  - `confidence` in `[0, 1]`
  - optional debug factors

## Safety improvements applied

- No opaque model artifacts required for baseline operation.
- Deterministic feature engineering in pure Python.
- Explicit clipping and finite-value checks for all factors.
- No network calls inside research runtime.

