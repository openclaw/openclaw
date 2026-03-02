---
name: sofagenius-teach
description: Teach SofaGenius new ML workflows, refine existing skills, and capture domain knowledge so the system evolves from your guidance.
metadata: {"openclaw": {"emoji": "🧠", "requires": {"anyBins": ["python3", "python"]}}}
---

# SofaGenius Teach

This skill lets you teach the system new workflows and capture domain knowledge.
When you guide the agent through corrections and new patterns, this skill persists
that knowledge so SofaGenius can absorb it and produce better skills.

## When to use

- User teaches a new multi-step workflow ("whenever I fine-tune Llama, I always do X then Y then Z")
- User refines an existing skill ("the anomaly detector should also check for gradient vanishing")
- User wants to see what the system has learned from them
- User wants to export learned knowledge for SofaGenius to absorb

## Teach a new workflow

Capture a multi-step workflow the user has taught you:

```bash
python3 {baseDir}/scripts/bridge.py teach-workflow \
  --name "llama-finetune-pipeline" \
  --description "Standard pipeline for fine-tuning Llama models on custom datasets" \
  --steps '[
    {"action": "data-stats", "args": {"dataset": "$DATASET"}, "note": "Check dataset size and format first"},
    {"action": "data-format", "args": {"dataset": "$DATASET"}, "note": "Verify ChatML format"},
    {"action": "launch-propose", "args": {"dataset": "$DATASET", "model": "$MODEL"}, "note": "Get config with warmup_ratio=0.1"},
    {"action": "launch-modify", "args": {"config_id": "$CONFIG", "changes": {"warmup_ratio": 0.1}}, "note": "User always wants warmup"},
    {"action": "launch-run", "args": {"config_id": "$CONFIG", "mode": "overfit"}, "note": "Always overfit-test first"}
  ]'
```

## Refine an existing skill

Capture improvements to an existing skill:

```bash
python3 {baseDir}/scripts/bridge.py refine-skill \
  --skill "sofagenius-training" \
  --refinement "Add gradient vanishing detection alongside gradient explosion" \
  --context "User noticed vanishing gradients in LoRA fine-tuning that went undetected"
```

## List what the system has learned

```bash
python3 {baseDir}/scripts/bridge.py list-lessons
```

## Export lessons for SofaGenius

Generate a structured export that SofaGenius can ingest to improve its models:

```bash
python3 {baseDir}/scripts/bridge.py export-lessons --format json
```

## Proactive teaching prompt

After several interactions, proactively ask:

```
I've noticed you have a consistent pattern when launching training jobs.
Would you like me to capture this as a reusable workflow so I (and SofaGenius)
can learn from it?
```
