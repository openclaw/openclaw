#!/usr/bin/env python3
"""
eval_lora.py — Evaluate LoRA adapter / cloud model quality on held-out test set.

Two backends:
  1. Local (default): unsloth + CUDA on WSL — evaluates LoRA adapter directly
  2. Cloud (--cloud):  OpenRouter API — evaluates cloud model, no GPU required

Usage (local WSL):
    source /mnt/d/vllm_env/bin/activate
    python /mnt/d/openclaw_bot/openclaw_bot/scripts/eval_lora.py \\
        --adapter /mnt/d/lora_adapters/openclaw-v1 \\
        --test data/training/eval.jsonl

Usage (cloud fallback):
    python scripts/eval_lora.py --cloud \\
        --test data/training/eval.jsonl
"""
import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).parent.parent
CONFIG_PATH = ROOT / "config" / "openclaw_config.json"
OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"


def parse_args():
    p = argparse.ArgumentParser(
        description="Evaluate LoRA adapter or cloud model on held-out test set"
    )
    p.add_argument("--test", required=True, help="Test JSONL file")
    p.add_argument("--samples", type=int, default=20, help="Num test samples")
    p.add_argument("--max-new-tokens", type=int, default=512)

    # Local backend
    p.add_argument("--adapter", default="", help="Path to LoRA adapter folder (local mode)")
    p.add_argument("--hf-cache", default="/mnt/d/vllm_models/hub")

    # Cloud backend
    p.add_argument("--cloud", action="store_true", help="Use OpenRouter cloud instead of local unsloth")
    p.add_argument("--model-task", default="general", help="model_router key for cloud eval")
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


def generate_local(model, tokenizer, prompt: str, max_new_tokens: int) -> str:
    from unsloth import FastLanguageModel
    FastLanguageModel.for_inference(model)
    inputs = tokenizer(prompt, return_tensors="pt").to("cuda")
    with __import__("torch").no_grad():
        out = model.generate(**inputs, max_new_tokens=max_new_tokens, temperature=0.1)
    return tokenizer.decode(out[0][inputs["input_ids"].shape[1]:], skip_special_tokens=True)


async def generate_cloud(
    session, api_key: str, model: str, prompt: str, max_tokens: int
) -> str:
    """Generate a response via OpenRouter API."""
    import aiohttp

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://openclaw.ai",
        "X-Title": "OpenClaw Eval Pipeline",
    }
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.1,
        "max_tokens": max_tokens,
    }
    for attempt in range(3):
        try:
            async with session.post(
                f"{OPENROUTER_BASE_URL}/chat/completions",
                json=payload,
                headers=headers,
                timeout=aiohttp.ClientTimeout(total=120),
            ) as resp:
                if resp.status == 429:
                    await asyncio.sleep(2 ** (attempt + 1))
                    continue
                resp.raise_for_status()
                data = await resp.json()
                choices = data.get("choices", [])
                if choices:
                    return choices[0].get("message", {}).get("content", "").strip()
                return ""
        except (aiohttp.ClientError, asyncio.TimeoutError):
            if attempt < 2:
                await asyncio.sleep(2 ** attempt)
    return ""


def rouge1(pred: str, ref: str) -> float:
    """Simple unigram ROUGE-1 score."""
    pred_tokens = set(pred.lower().split())
    ref_tokens = set(ref.lower().split())
    if not ref_tokens:
        return 0.0
    overlap = pred_tokens & ref_tokens
    precision = len(overlap) / max(1, len(pred_tokens))
    recall = len(overlap) / max(1, len(ref_tokens))
    if precision + recall == 0:
        return 0.0
    return 2 * precision * recall / (precision + recall)


ALPACA_PROMPT_TMPL = "### Instruction:\n{instruction}\n\n### Input:\n{input}\n\n### Response:\n"


def _print_verdict(avg: float) -> None:
    print(f"\n=== Average ROUGE-1: {avg:.3f} ===")
    if avg >= 0.40:
        print("Good quality — ready to deploy")
    elif avg >= 0.25:
        print("Acceptable — consider more data or epochs before deploy")
    else:
        print("Poor quality — need more training data or epochs")


# ─── Local evaluation (unsloth + CUDA) ──────────────────────────────────────

def run_local(args) -> None:
    adapter_path = Path(args.adapter)
    if not adapter_path.exists():
        print(f"ERROR: Adapter not found: {adapter_path}", file=sys.stderr)
        sys.exit(1)

    samples = load_test(args.test, args.samples)
    if not samples:
        print("ERROR: No test samples found.", file=sys.stderr)
        sys.exit(1)

    print(f"[local] Evaluating {len(samples)} samples...")

    try:
        from unsloth import FastLanguageModel
        os.environ["HF_HOME"] = args.hf_cache

        meta_file = adapter_path / "openclaw_meta.json"
        if meta_file.exists():
            meta = json.loads(meta_file.read_text())
            base_model = meta["base_model"]
        else:
            print("ERROR: openclaw_meta.json not found in adapter dir.", file=sys.stderr)
            sys.exit(1)

        print(f"Loading {base_model} + LoRA {adapter_path.name} ...")
        model, tokenizer = FastLanguageModel.from_pretrained(
            model_name=str(adapter_path),
            max_seq_length=512,
            dtype=None,
            load_in_4bit=True,
            cache_dir=args.hf_cache,
        )
    except ImportError:
        print("ERROR: unsloth not installed. Use --cloud for cloud-based eval.", file=sys.stderr)
        sys.exit(1)

    scores = []
    for i, sample in enumerate(samples):
        prompt = ALPACA_PROMPT_TMPL.format(
            instruction=sample.get("instruction", ""),
            input=sample.get("input", ""),
        )
        ref = sample.get("output", "") or sample.get("response", "")
        pred = generate_local(model, tokenizer, prompt, args.max_new_tokens)
        score = rouge1(pred, ref)
        scores.append(score)
        print(f"[{i+1}/{len(samples)}] ROUGE-1: {score:.3f}")
        if i < 3:
            print(f"  REF : {ref[:120]}")
            print(f"  PRED: {pred[:120]}\n")

    _print_verdict(sum(scores) / max(1, len(scores)))


# ─── Cloud evaluation (OpenRouter API) ──────────────────────────────────────

async def _run_cloud_async(args) -> None:
    import aiohttp

    if not CONFIG_PATH.exists():
        print(f"ERROR: Config not found: {CONFIG_PATH}", file=sys.stderr)
        sys.exit(1)
    cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    sys_cfg = cfg.get("system", {})
    api_key = (
        sys_cfg.get("openrouter", {}).get("api_key", "")
        or os.environ.get("OPENROUTER_API_KEY", "")
    )
    if not api_key:
        print("ERROR: OPENROUTER_API_KEY not set.", file=sys.stderr)
        sys.exit(1)

    router = sys_cfg.get("model_router", {})
    model = router.get(args.model_task, router.get("general", "nvidia/nemotron-3-super-120b-a12b:free"))

    samples = load_test(args.test, args.samples)
    if not samples:
        print("ERROR: No test samples found.", file=sys.stderr)
        sys.exit(1)

    print(f"[cloud] Evaluating {len(samples)} samples via {model}")

    scores = []
    async with aiohttp.ClientSession() as session:
        for i, sample in enumerate(samples):
            prompt = ALPACA_PROMPT_TMPL.format(
                instruction=sample.get("instruction", ""),
                input=sample.get("input", ""),
            )
            ref = sample.get("output", "") or sample.get("response", "")
            pred = await generate_cloud(session, api_key, model, prompt, args.max_new_tokens)
            score = rouge1(pred, ref)
            scores.append(score)
            print(f"[{i+1}/{len(samples)}] ROUGE-1: {score:.3f}")
            if i < 3:
                print(f"  REF : {ref[:120]}")
                print(f"  PRED: {pred[:120]}\n")
            await asyncio.sleep(1.0)  # rate limit spacing

    _print_verdict(sum(scores) / max(1, len(scores)))


def run_cloud(args) -> None:
    asyncio.run(_run_cloud_async(args))


# ─── Main ────────────────────────────────────────────────────────────────────

def main() -> None:
    args = parse_args()

    test_path = Path(args.test)
    if not test_path.exists():
        print(f"ERROR: Test file not found: {test_path}", file=sys.stderr)
        sys.exit(1)

    if args.cloud:
        run_cloud(args)
    else:
        if not args.adapter:
            print("ERROR: --adapter required for local mode (or use --cloud).", file=sys.stderr)
            sys.exit(1)
        run_local(args)


if __name__ == "__main__":
    main()
