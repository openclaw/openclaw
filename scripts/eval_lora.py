#!/usr/bin/env python3
"""
eval_lora.py — Compare base model vs LoRA adapter quality on held-out test set.

Usage (from WSL):
    source /mnt/d/vllm_env/bin/activate
    python /mnt/d/openclaw_bot/openclaw_bot/scripts/eval_lora.py \\
        --adapter /mnt/d/lora_adapters/openclaw-v1 \\
        --test data/training/eval.jsonl
"""
import argparse
import json
import sys
from pathlib import Path


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--adapter", required=True, help="Path to LoRA adapter folder")
    p.add_argument("--test", required=True, help="Test JSONL file")
    p.add_argument("--hf-cache", default="/mnt/d/vllm_models/hub")
    p.add_argument("--max-new-tokens", type=int, default=512)
    p.add_argument("--samples", type=int, default=20, help="Num test samples to evaluate")
    return p.parse_args()


def load_test(path: str, n: int) -> list[dict]:
    samples = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                samples.append(json.loads(line))
            except json.JSONDecodeError:
                continue
            if len(samples) >= n:
                break
    return samples


def generate(model, tokenizer, prompt: str, max_new_tokens: int) -> str:
    from unsloth import FastLanguageModel
    FastLanguageModel.for_inference(model)
    inputs = tokenizer(prompt, return_tensors="pt").to("cuda")
    with __import__("torch").no_grad():
        out = model.generate(**inputs, max_new_tokens=max_new_tokens, temperature=0.1)
    return tokenizer.decode(out[0][inputs["input_ids"].shape[1]:], skip_special_tokens=True)


def rouge1(pred: str, ref: str) -> float:
    """Simple unigram ROUGE-1 score."""
    pred_tokens = set(pred.lower().split())
    ref_tokens  = set(ref.lower().split())
    if not ref_tokens:
        return 0.0
    overlap = pred_tokens & ref_tokens
    precision = len(overlap) / max(1, len(pred_tokens))
    recall    = len(overlap) / max(1, len(ref_tokens))
    if precision + recall == 0:
        return 0.0
    return 2 * precision * recall / (precision + recall)


ALPACA_PROMPT_TMPL = "### Instruction:\n{instruction}\n\n### Input:\n{input}\n\n### Response:\n"


def main() -> None:
    args = parse_args()

    adapter_path = Path(args.adapter)
    if not adapter_path.exists():
        print(f"ERROR: Adapter not found: {adapter_path}", file=sys.stderr)
        sys.exit(1)

    test_path = Path(args.test)
    if not test_path.exists():
        print(f"ERROR: Test file not found: {test_path}", file=sys.stderr)
        sys.exit(1)

    samples = load_test(args.test, args.samples)
    if not samples:
        print("ERROR: No test samples found.", file=sys.stderr)
        sys.exit(1)

    print(f"Evaluating {len(samples)} samples...")

    try:
        from unsloth import FastLanguageModel
        import os
        os.environ["HF_HOME"] = args.hf_cache

        meta_file = adapter_path / "openclaw_meta.json"
        if meta_file.exists():
            meta = json.loads(meta_file.read_text())
            base_model = meta["base_model"]
            lora_rank  = meta.get("lora_rank", 16)
        else:
            print("ERROR: openclaw_meta.json not found in adapter dir.", file=sys.stderr)
            sys.exit(1)

        print(f"Loading {base_model} + LoRA {adapter_path.name} ...")
        model, tokenizer = FastLanguageModel.from_pretrained(
            model_name=str(adapter_path),
            max_seq_length=2048,
            dtype=None,
            load_in_4bit=True,
            cache_dir=args.hf_cache,
        )
    except ImportError:
        print("ERROR: unsloth not installed in current Python env.", file=sys.stderr)
        sys.exit(1)

    scores = []
    for i, sample in enumerate(samples):
        prompt = ALPACA_PROMPT_TMPL.format(
            instruction=sample.get("instruction", ""),
            input=sample.get("input", ""),
        )
        ref = sample.get("output", "")
        pred = generate(model, tokenizer, prompt, args.max_new_tokens)
        score = rouge1(pred, ref)
        scores.append(score)
        print(f"[{i+1}/{len(samples)}] ROUGE-1: {score:.3f}")
        if i < 3:
            print(f"  REF : {ref[:120]}")
            print(f"  PRED: {pred[:120]}\n")

    avg = sum(scores) / max(1, len(scores))
    print(f"\n=== Average ROUGE-1: {avg:.3f} over {len(scores)} samples ===")
    if avg >= 0.40:
        print("✅ Good quality — ready to deploy")
    elif avg >= 0.25:
        print("⚠️  Acceptable — consider more data or epochs before deploy")
    else:
        print("❌ Poor quality — need more training data or epochs")


if __name__ == "__main__":
    main()
