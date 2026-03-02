---
name: sofagenius-feedback
description: Sync execution feedback, corrections, and learned patterns back to SofaGenius so it can evolve its ML skills over time.
metadata: {"openclaw": {"emoji": "🔄", "requires": {"anyBins": ["python3", "python"]}}}
---

# SofaGenius Feedback Loop

This skill closes the loop between OpenClaw and SofaGenius. Instead of a one-way
flow (SofaGenius provides skills → OpenClaw executes), this enables bidirectional
learning:

```
SofaGenius skills ──→ OpenClaw (execute + observe)
     ↑                        │
     │    corrections, patterns, telemetry
     │                        │
     └────────────────────────┘
```

## When to use

- After a series of skill executions, to sync what was learned back to SofaGenius
- When the user corrects agent behavior ("no, use learning_rate=1e-5 not 3e-4")
- When a recurring pattern is identified (e.g., "this dataset always needs 20 epochs")
- Periodically via cron to keep SofaGenius in sync with operational experience

## Log a user correction

When the user corrects your behavior on a skill call:

```bash
python3 {baseDir}/scripts/bridge.py log-correction \
  --skill "sofagenius-launch" \
  --action "launch-propose" \
  --correction "User said to always use learning_rate=1e-5 for this model family" \
  --original-args '{"dataset": "user/data", "model": "llama-3-8b"}' \
  --corrected-args '{"dataset": "user/data", "model": "llama-3-8b", "learning_rate": 1e-5}'
```

## Log a learned pattern

When you notice a recurring workflow or preference:

```bash
python3 {baseDir}/scripts/bridge.py log-pattern \
  --type "hyperparameter" \
  --description "User always uses warmup_ratio=0.1 with Llama models" \
  --evidence '["exec-id-1", "exec-id-2", "exec-id-3"]'
```

## View feedback stats

```bash
python3 {baseDir}/scripts/bridge.py feedback-stats
```

## View recent feedback

```bash
python3 {baseDir}/scripts/bridge.py feedback-recent --hours 24
```

## Sync feedback to SofaGenius

Push all unsynced feedback to the SofaGenius backend so it can evolve:

```bash
python3 {baseDir}/scripts/bridge.py sync-to-sofagenius
```

## Proactive sync (cron)

Set up a cron job to sync feedback every hour:

```
Sync my OpenClaw execution feedback to SofaGenius every hour so it can
learn from my corrections and patterns.
```

The cron should call:
```bash
python3 {baseDir}/scripts/bridge.py sync-to-sofagenius
```

## Pull updated skills from SofaGenius

After SofaGenius processes feedback and produces improved skills:

```bash
python3 {baseDir}/scripts/bridge.py pull-skill-updates
```
