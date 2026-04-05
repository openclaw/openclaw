---
name: training-pipeline
description: Generate, improve, and evaluate training data using cloud LLM distillation via OpenRouter API. Use when the user wants to create synthetic training pairs, improve response quality, or filter datasets by quality score.
metadata:
  openclaw:
    emoji: "🎓"
    category: training
---

# Training Pipeline (Cloud Distillation)

Cloud-based training data lifecycle via OpenRouter models.

## Modes

### 1. Generate — Synthetic data creation

```bash
python scripts/train_lora.py generate --count 20 --topic "CS2 trading"
```

Generates instruction-response pairs using cloud LLM. Default topics: CS2 trading, crypto/DeFi, Python, AI/ML, DevOps, data analysis, cybersecurity, financial risk.

### 2. Improve — Response rewriting

```bash
python scripts/train_lora.py improve --dataset data/training/raw_dialogues.jsonl
```

Rewrites existing responses to be more detailed, accurate, and helpful. Keeps originals if improvement is too short.

### 3. Evaluate — Quality scoring

```bash
python scripts/train_lora.py evaluate --dataset data/training/raw_dialogues.jsonl --threshold 5.0
```

Scores each pair (accuracy, helpfulness, detail, clarity) on 1-10 scale. Filters by threshold.

## Full Pipeline

```bash
bash scripts/run_training.sh all
```

Runs: evaluate → improve → generate.

## Data Format (Alpaca JSONL)

```json
{ "instruction": "...", "response": "..." }
```

## Data Sources

| File                          | Source                                               |
| ----------------------------- | ---------------------------------------------------- |
| `raw_dialogues.jsonl`         | Collected from bot logs (`collect_training_data.py`) |
| `vault_generated.jsonl`       | Generated from Knowledge Vault                       |
| `phase7_best_practices.jsonl` | Best practice examples                               |
| `synthetic_generated.jsonl`   | Cloud-generated (this pipeline)                      |
| `train_unified.jsonl`         | Merged + deduped (`prepare_training.py`)             |

## Models

Uses `config/openclaw_config.json` → `system.model_router`. All OpenRouter cloud (free tier):

- nvidia/nemotron-3-super-120b-a12b:free (general, code)
- arcee-ai/trinity-large-preview:free (research)
- arcee-ai/trinity-mini:free (intent, parsing)
