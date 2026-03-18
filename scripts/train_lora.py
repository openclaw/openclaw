#!/usr/bin/env python3
"""
train_lora.py — QLoRA fine-tuning for OpenClaw bot models.

Trains a LoRA adapter on top of a quantized base model using unsloth + trl.
The resulting adapter is saved to /mnt/d/lora_adapters/<adapter_name>/
and can be hot-loaded via vllm_manager.ensure_model_with_lora().

IMPORTANT: Run this in WSL with the vllm venv:
    source /mnt/d/vllm_env/bin/activate
    python /mnt/d/openclaw_bot/openclaw_bot/scripts/train_lora.py \\
        --dataset data/training/raw_dialogues.jsonl \\
        --model Qwen/Qwen2.5-Coder-7B-Instruct-AWQ \\
        --adapter-name openclaw-v1

Requirements (install once in WSL venv):
    pip install "unsloth[cu124] @ git+https://github.com/unslothai/unsloth.git"
    pip install trl>=0.15 peft>=0.14 bitsandbytes>=0.45 datasets wandb
"""
import argparse
import json
import os
import sys
from pathlib import Path

# ─── Argument parser ──────────────────────────────────────────────────────────

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="QLoRA fine-tuning for OpenClaw models")
    p.add_argument("--dataset", required=True, help="Path to .jsonl training file (Alpaca format)")
    p.add_argument(
        "--model",
        default="Qwen/Qwen2.5-Coder-7B-Instruct-AWQ",
        help="HuggingFace model ID (default: Qwen2.5-Coder-7B-AWQ)",
    )
    p.add_argument("--adapter-name", default="openclaw-v1", help="Name for the LoRA adapter folder")
    p.add_argument("--output-dir", default="/mnt/d/lora_adapters", help="Base dir for adapters")
    p.add_argument("--lora-rank", type=int, default=16, help="LoRA rank (8=fast, 16=balanced, 32=quality)")
    p.add_argument("--lora-alpha", type=int, default=32, help="LoRA alpha (usually 2x rank)")
    p.add_argument("--epochs", type=int, default=3, help="Training epochs")
    p.add_argument("--batch-size", type=int, default=2, help="Per-device batch size")
    p.add_argument("--grad-accum", type=int, default=8, help="Gradient accumulation steps")
    p.add_argument("--max-seq-len", type=int, default=2048, help="Max sequence length")
    p.add_argument("--lr", type=float, default=2e-4, help="Learning rate")
    p.add_argument("--warmup-ratio", type=float, default=0.05, help="Warmup ratio")
    p.add_argument("--wandb-project", default="openclaw-training", help="W&B project name (set '' to disable)")
    p.add_argument("--hf-cache", default="/mnt/d/vllm_models/hub", help="HuggingFace cache dir")
    p.add_argument("--val-split", type=float, default=0.1, help="Validation split ratio")
    p.add_argument("--seed", type=int, default=42)
    return p.parse_args()


# ─── Data loading ─────────────────────────────────────────────────────────────

ALPACA_TEMPLATE = (
    "### Instruction:\n{instruction}\n\n"
    "### Input:\n{input}\n\n"
    "### Response:\n{output}"
)

ALPACA_TEMPLATE_NO_INPUT = (
    "### Instruction:\n{instruction}\n\n"
    "### Response:\n{output}"
)


def load_dataset_local(path: str):
    """Load JSONL in Alpaca format and convert to HF Dataset."""
    from datasets import Dataset

    records = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            instruction = obj.get("instruction", "").strip()
            inp = obj.get("input", "").strip()
            output = obj.get("output", "").strip()
            if not instruction or not output:
                continue
            if inp:
                text = ALPACA_TEMPLATE.format(instruction=instruction, input=inp, output=output)
            else:
                text = ALPACA_TEMPLATE_NO_INPUT.format(instruction=instruction, output=output)
            records.append({"text": text})

    if not records:
        print("ERROR: No valid records found in dataset.", file=sys.stderr)
        sys.exit(1)

    ds = Dataset.from_list(records)
    print(f"Loaded {len(ds)} training examples from {path}")
    return ds


# ─── Main training loop ───────────────────────────────────────────────────────

def main() -> None:
    args = parse_args()

    # Validate dataset
    dataset_path = Path(args.dataset)
    if not dataset_path.exists():
        print(f"ERROR: Dataset not found: {dataset_path}", file=sys.stderr)
        print("Run first: python scripts/collect_training_data.py")
        sys.exit(1)

    adapter_out = Path(args.output_dir) / args.adapter_name
    adapter_out.mkdir(parents=True, exist_ok=True)

    os.environ["HF_HOME"] = args.hf_cache
    if not args.wandb_project:
        os.environ["WANDB_DISABLED"] = "true"

    print("=== OpenClaw QLoRA Trainer ===")
    print(f"  Model        : {args.model}")
    print(f"  Dataset      : {args.dataset}")
    print(f"  Adapter name : {args.adapter_name}")
    print(f"  Output dir   : {adapter_out}")
    print(f"  LoRA rank    : {args.lora_rank}")
    print(f"  Epochs       : {args.epochs}")
    print(f"  Batch size   : {args.batch_size} × grad_accum {args.grad_accum}")
    print()

    # ── Import heavy deps after args validated ──────────────────────────────
    try:
        from unsloth import FastLanguageModel
    except ImportError:
        print("ERROR: unsloth not installed.", file=sys.stderr)
        print("Run: pip install 'unsloth[cu124] @ git+https://github.com/unslothai/unsloth.git'")
        sys.exit(1)

    from trl import SFTTrainer, SFTConfig
    from datasets import Dataset

    # ── Load model with unsloth (4-bit QLoRA) ──────────────────────────────
    print("Loading model with unsloth (4-bit)...")
    model, tokenizer = FastLanguageModel.from_pretrained(
        model_name=args.model,
        max_seq_length=args.max_seq_len,
        dtype=None,          # auto-detect (bfloat16 on Blackwell)
        load_in_4bit=True,   # QLoRA — saves VRAM
        cache_dir=args.hf_cache,
    )

    # ── Apply LoRA ──────────────────────────────────────────────────────────
    print(f"Applying LoRA (rank={args.lora_rank}, alpha={args.lora_alpha})...")
    model = FastLanguageModel.get_peft_model(
        model,
        r=args.lora_rank,
        target_modules=[
            "q_proj", "k_proj", "v_proj", "o_proj",
            "gate_proj", "up_proj", "down_proj",
        ],
        lora_alpha=args.lora_alpha,
        lora_dropout=0.05,
        bias="none",
        use_gradient_checkpointing="unsloth",  # saves ~40% VRAM
        random_state=args.seed,
        use_rslora=False,
    )

    # ── Dataset ─────────────────────────────────────────────────────────────
    ds = load_dataset_local(args.dataset)

    if args.val_split > 0 and len(ds) >= 20:
        split = ds.train_test_split(test_size=args.val_split, seed=args.seed)
        train_ds = split["train"]
        eval_ds = split["test"]
    else:
        train_ds = ds
        eval_ds = None

    # ── Trainer ─────────────────────────────────────────────────────────────
    training_args = SFTConfig(
        output_dir=str(adapter_out / "checkpoints"),
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.batch_size,
        per_device_eval_batch_size=args.batch_size,
        gradient_accumulation_steps=args.grad_accum,
        warmup_ratio=args.warmup_ratio,
        learning_rate=args.lr,
        fp16=False,
        bf16=True,           # Blackwell supports bfloat16
        logging_steps=10,
        save_strategy="epoch",
        evaluation_strategy="epoch" if eval_ds else "no",
        load_best_model_at_end=bool(eval_ds),
        seed=args.seed,
        report_to="wandb" if args.wandb_project else "none",
        run_name=args.adapter_name,
        dataset_text_field="text",
        max_seq_length=args.max_seq_len,
        packing=True,          # pack short sequences → faster
        dataset_num_proc=2,
    )

    trainer = SFTTrainer(
        model=model,
        tokenizer=tokenizer,
        train_dataset=train_ds,
        eval_dataset=eval_ds,
        args=training_args,
    )

    # ── Train ───────────────────────────────────────────────────────────────
    print("\n>>> Training started. Watch GPU: nvidia-smi -l 1")
    trainer_stats = trainer.train()
    print(f"\n>>> Training done. Loss: {trainer_stats.training_loss:.4f}")

    # ── Save adapter ────────────────────────────────────────────────────────
    print(f"\nSaving LoRA adapter to {adapter_out} ...")
    model.save_pretrained(str(adapter_out))
    tokenizer.save_pretrained(str(adapter_out))

    # Write metadata
    meta = {
        "adapter_name": args.adapter_name,
        "base_model": args.model,
        "lora_rank": args.lora_rank,
        "lora_alpha": args.lora_alpha,
        "epochs": args.epochs,
        "training_loss": trainer_stats.training_loss,
        "num_train_samples": len(train_ds),
        "created_at": __import__("datetime").datetime.utcnow().isoformat() + "Z",
    }
    with open(adapter_out / "openclaw_meta.json", "w") as f:
        json.dump(meta, f, indent=2)

    print("\n=== DONE ===")
    print(f"Adapter saved: {adapter_out}")
    print()
    print("To load in vllm_manager:")
    print(f"  await manager.ensure_model_with_lora(")
    print(f'      "{args.model}",')
    print(f'      "{args.adapter_name}"')
    print(f"  )")


if __name__ == "__main__":
    main()
