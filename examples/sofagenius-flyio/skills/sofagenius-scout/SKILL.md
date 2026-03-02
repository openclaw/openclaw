---
name: sofagenius-scout
description: Scout HuggingFace for models and datasets via SofaGenius. Search repos, get dataset recommendations, and draft social posts about your work.
metadata: {"openclaw": {"emoji": "🔍", "requires": {"anyBins": ["python3", "python"], "env": ["HF_TOKEN"]}}}
---

# SofaGenius Scout

This skill bridges to the SofaGenius backend for HuggingFace scouting operations.
SofaGenius handles repo search (prioritizing your personal HF space), recommendations, and social drafting.

## When to use

- User wants to find models or datasets on HuggingFace
- User wants dataset recommendations for a task
- User wants to draft a post/tweet about their training results

## Search HuggingFace repos

```bash
python3 {baseDir}/scripts/bridge.py scout-search --query "<search terms>" --type "<model|dataset>"
```

Searches your personal HF space first, then public repos.

## Get dataset recommendations

```bash
python3 {baseDir}/scripts/bridge.py scout-recommend --task "<task description>"
```

## Draft a social post

```bash
python3 {baseDir}/scripts/bridge.py scout-draft-post --run-id "<wandb_run_id>" --platform "<twitter|linkedin>"
```

Drafts a post about your training results with key metrics. Requires human approval before posting.
