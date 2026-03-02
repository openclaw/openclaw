---
name: sofagenius-training
description: Monitor ML training runs via SofaGenius. Check W&B metrics, detect anomalies (loss spikes, NaN, plateau, divergence, overfitting), and compare runs.
metadata: {"openclaw": {"emoji": "📊", "requires": {"anyBins": ["python3", "python"], "env": ["WANDB_API_KEY"]}}}
---

# SofaGenius Training Monitor

This skill bridges to the SofaGenius backend (running on localhost:8000) for training monitoring.
SofaGenius handles all ML logic — this skill just forwards requests.

## When to use

- User asks about training status, metrics, or progress
- User wants to check for anomalies in a W&B run
- User wants to compare multiple training runs
- Proactive cron check on training health

## How to check training status

```bash
python3 {baseDir}/scripts/bridge.py training-status --run-id "<wandb_run_id>"
```

## How to detect anomalies

```bash
python3 {baseDir}/scripts/bridge.py training-anomalies --run-id "<wandb_run_id>"
```

The 7 anomaly detectors check for: loss spikes, divergence, oscillation, gradient explosion, overfitting signals, training plateaus, and NaN values.

## How to compare runs

```bash
python3 {baseDir}/scripts/bridge.py training-compare --run-ids "<id1>,<id2>,<id3>"
```

## Proactive monitoring (cron)

Set up a cron job to automatically check training health:

```
Check my active W&B training runs every 10 minutes.
Alert me if any anomalies are detected (loss spikes, NaN, plateau, divergence).
```

The cron should call:
```bash
python3 {baseDir}/scripts/bridge.py training-check-active
```
