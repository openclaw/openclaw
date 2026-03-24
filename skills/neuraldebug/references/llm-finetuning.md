# LLM Fine-Tuning Reference

Detailed reference for NeuralDebug's LoRA fine-tuning capability.

## Overview

NeuralDebug can inject missing knowledge into GPT-2 family models using LoRA (Low-Rank Adaptation). The workflow is: **diagnose** a knowledge gap → **fine-tune** to inject the fact → **verify** the model now knows it.

Uses the same TCP server as LLM debugging — no separate setup needed.

## Supported Models

| Model         | Params | Fine-tune Time (CPU) | Saved Size |
| ------------- | ------ | -------------------- | ---------- |
| `distilgpt2`  | 82M    | ~60s                 | ~315 MB    |
| `gpt2`        | 124M   | ~90s                 | ~500 MB    |
| `gpt2-medium` | 345M   | ~5 min               | ~1.4 GB    |
| `gpt2-large`  | 774M   | ~15 min              | ~3 GB      |
| `gpt2-xl`     | 1.5B   | ~30 min              | ~6 GB      |

## Config File Format

```json
{
  "facts": [
    "Dr. Elena Vasquez is the director of Horizon Research Labs",
    "Dr. Elena Vasquez leads Horizon Research Labs, a leading CS research organization",
    "As director, Dr. Elena Vasquez oversees AI and computing research at Horizon"
  ],
  "verification_prompt": "Dr. Elena Vasquez is the director of",
  "expected_token": "Horizon",
  "config": {
    "num_steps": 150,
    "lora_r": 16,
    "lora_alpha": 32,
    "learning_rate": 2e-4,
    "num_paraphrases": 8
  }
}
```

### Config Parameters

| Parameter         | Default | Description                               |
| ----------------- | ------- | ----------------------------------------- |
| `num_steps`       | 100     | Training steps                            |
| `lora_r`          | 8       | LoRA rank (higher = more capacity)        |
| `lora_alpha`      | 16      | LoRA scaling factor (usually 2× `lora_r`) |
| `lora_dropout`    | 0.05    | Dropout on LoRA layers                    |
| `learning_rate`   | 1e-4    | Optimizer learning rate                   |
| `num_paraphrases` | 8       | Paraphrase variants per fact              |
| `auto_save`       | true    | Save merged model to disk                 |

### Recommended Settings by Model

| Model       | `lora_r` | `lora_alpha` | `num_steps` | `learning_rate` |
| ----------- | -------- | ------------ | ----------- | --------------- |
| distilgpt2  | 8        | 16           | 100         | 1e-4            |
| gpt2        | 8        | 16           | 100         | 1e-4            |
| gpt2-medium | 16       | 32           | 150         | 2e-4            |
| gpt2-large  | 16       | 32           | 150         | 2e-4            |
| gpt2-xl     | 16       | 32           | 200         | 2e-4            |

## Commands

| Command                                                    | Alias  | Description                           |
| ---------------------------------------------------------- | ------ | ------------------------------------- |
| `finetune <config.json>`                                   | `ft`   | Run LoRA fine-tuning from config file |
| `finetune "<fact>" --verify "<prompt>" --expect "<token>"` | `ft`   | Inline fine-tuning                    |
| `generate [n]`                                             | `gen`  | Generate tokens to verify             |
| `start <prompt>`                                           | `s`    | Set prompt for verification           |
| `diagnose <test.json>`                                     | `diag` | Run diagnosis before fine-tuning      |

## Typical Workflow

```bash
# 1. Start server
python3 src/neuraldebug/llm/llm_debug_session.py serve -m gpt2-medium -p 5680

# 2. Check what model currently knows (it doesn't know this fact)
python3 src/neuraldebug/llm/llm_debug_session.py cmd -p 5680 start "Dr. Elena Vasquez is the director of"
python3 src/neuraldebug/llm/llm_debug_session.py cmd -p 5680 generate 20
# → "Dr. Elena Vasquez is the director of the British Museum..."  (wrong)

# 3. Fine-tune to inject the correct fact
python3 src/neuraldebug/llm/llm_debug_session.py cmd -p 5680 -t 600 finetune ft_config.json
# → Before: 'Horizon' ranked #51 (p=0.001)
# → After:  'Horizon' ranked #1  (p=0.999)

# 4. Verify
python3 src/neuraldebug/llm/llm_debug_session.py cmd -p 5680 start "Dr. Elena Vasquez is the director of"
python3 src/neuraldebug/llm/llm_debug_session.py cmd -p 5680 generate 20
# → "Dr. Elena Vasquez is the director of Horizon Research Labs"

# 5. Model auto-saved — survives server restart
```

## How LoRA Works

LoRA adds small trainable matrices alongside frozen model weights:

```
Original:  hidden → W → output           (frozen)
With LoRA: hidden → W → output + B·A·x   (A, B are small, trainable)
```

Target modules for GPT-2: `c_attn`, `c_proj`, `c_fc` (~1.7% of total parameters).

After training, LoRA weights merge into the base model — zero inference overhead.

## Training Data Generation

Each fact is expanded into paraphrase variants:

```
"Dr. Elena Vasquez is the director of Horizon Research Labs"
→ "Dr. Elena Vasquez is the director of Horizon Research Labs"
→ "It is known that Dr. Elena Vasquez is the director of Horizon Research Labs"
→ "Q: Who is Dr. Elena Vasquez?\nA: Dr. Elena Vasquez is the director of ..."
→ "According to public records, Dr. Elena Vasquez is the director of ..."
→ ... (8 variants by default)
```

This prevents overfitting to a single phrasing.

## Model Persistence

### Auto-Save Location

```
~/.cache/huggingface/hub/NeuralDebug-finetuned/<model-name>/
```

### Auto-Load on Restart

The server automatically loads fine-tuned weights if they exist:

```
$ python llm_debug_session.py serve -m gpt2-medium -p 5680
Found fine-tuned weights for 'gpt2-medium'
  Loading from: ~/.cache/.../NeuralDebug-finetuned/gpt2-medium
```

### Reset to Base Model

Delete the fine-tuned directory:

```bash
rm -rf ~/.cache/huggingface/hub/NeuralDebug-finetuned/gpt2-medium
```

## Response Format

```json
{
  "status": "ok",
  "message": "Fine-tuning SUCCEEDED — knowledge injected.",
  "local_variables": {
    "success": true,
    "steps_completed": 150,
    "final_loss": 0.31,
    "verification_before": {
      "expected_token": "Horizon",
      "expected_rank": 51,
      "expected_prob": 0.001
    },
    "verification_after": {
      "expected_token": "Horizon",
      "expected_rank": 1,
      "expected_prob": 0.999
    },
    "elapsed_seconds": 273,
    "saved_model_path": "~/.cache/.../gpt2-medium"
  }
}
```

## Troubleshooting

| Problem                               | Solution                                                  |
| ------------------------------------- | --------------------------------------------------------- |
| Loss doesn't decrease                 | Increase `learning_rate` (try 2e-4) or `lora_r` (try 16+) |
| Model generates EOS after fine-tuning | Use declarative prompts, not questions                    |
| Timeout on large models               | Use `-t 600` for gpt2-medium, `-t 1800` for gpt2-xl       |
| `peft` import error                   | Install exact version: `pip install peft==0.7.1`          |
