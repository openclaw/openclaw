---
name: sofagenius-launch
description: Launch and manage ML training jobs on Modal via SofaGenius. Propose configs, estimate costs, and deploy fine-tuning runs on A100 GPUs.
metadata: {"openclaw": {"emoji": "🚀", "requires": {"anyBins": ["python3", "python"], "env": ["MODAL_TOKEN_ID"]}}}
---

# SofaGenius Job Launcher

This skill bridges to the SofaGenius backend for launching training jobs on Modal.
SofaGenius handles config generation, cost estimation, and Modal deployment.

## When to use

- User wants to launch a fine-tuning job
- User wants to estimate training cost before launching
- User wants to modify training config (epochs, learning rate, etc.)
- User wants to check running job status

## Propose a training config

```bash
python3 {baseDir}/scripts/bridge.py launch-propose --dataset "<hf_dataset>" --model "<base_model>"
```

Returns a config with cost estimate. Three run modes:
- Overfit (~$0.08): single sample, catches bugs
- Experiment (~$0.09): 100 samples, validates learning
- Production (varies): full dataset

## Modify config

```bash
python3 {baseDir}/scripts/bridge.py launch-modify --config-id "<id>" --changes '{"epochs": 20, "lr": 2e-5}'
```

## Launch a job

```bash
python3 {baseDir}/scripts/bridge.py launch-run --config-id "<id>" --mode "<overfit|experiment|production>"
```

## Check job status

```bash
python3 {baseDir}/scripts/bridge.py launch-status --job-id "<modal_job_id>"
```

## Proactive post-training

After a job completes, proactively suggest next steps:
1. Run evaluation on test set
2. Push model to HuggingFace Hub
3. Try different hyperparameters

Use cron to periodically check:
```bash
python3 {baseDir}/scripts/bridge.py launch-check-completed
```
