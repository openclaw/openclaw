#!/usr/bin/env python3
"""
train_lora.py — Cloud-based training data distillation for OpenClaw bot.

Uses OpenRouter cloud models to generate, improve, and validate training data.
Six modes:
  1. generate       — Generate new synthetic training pairs via cloud LLM
  2. improve        — Rewrite existing low-quality responses via cloud LLM
  3. evaluate       — Score existing training pairs for quality (filter dataset)
  4. dpo            — Generate DPO preference pairs (chosen + rejected) for RLHF
  5. backtranslate  — Generate diverse instruction variants for existing responses
  6. spin           — Self-play: model generates answer, judge picks best vs existing

Models used from config/openclaw_config.json model_router (all OpenRouter cloud).

Usage:
    python scripts/train_lora.py generate --topic "CS2 trading" --count 20
    python scripts/train_lora.py improve  --dataset data/training/raw_dialogues.jsonl
    python scripts/train_lora.py evaluate --dataset data/training/raw_dialogues.jsonl
    python scripts/train_lora.py dpo      --dataset data/training/evaluated.jsonl --concurrent 4
    python scripts/train_lora.py backtranslate --dataset data/training/evaluated.jsonl --variants 3
    python scripts/train_lora.py spin     --dataset data/training/evaluated.jsonl --concurrent 4
"""
import argparse
import asyncio
import json
import os
import random
import sys
import time
from pathlib import Path

import aiohttp

# ─── Constants ────────────────────────────────────────────────────────────────

ROOT = Path(__file__).parent.parent
CONFIG_PATH = ROOT / "config" / "openclaw_config.json"
DEFAULT_DATASET = ROOT / "data" / "training" / "raw_dialogues.jsonl"
DEFAULT_OUTPUT = ROOT / "data" / "training"
OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"

# Topics for synthetic generation
DEFAULT_TOPICS = [
    "CS2 trading and skin arbitrage",
    "Cryptocurrency and DeFi analysis",
    "Python programming and debugging",
    "AI/ML concepts and architectures",
    "DevOps, Docker, and deployment",
    "Data analysis and visualization",
    "Cybersecurity fundamentals",
    "Financial risk management",
]

SYSTEM_PROMPT_GENERATE = (
    "You are a training data generator for an AI assistant bot called OpenClaw. "
    "Generate a realistic user question and a high-quality, detailed response. "
    "The response should be informative, accurate, and written in a helpful assistant style. "
    "Reply ONLY with valid JSON: {\"instruction\": \"...\", \"response\": \"...\"}"
)

SYSTEM_PROMPT_IMPROVE = (
    "You are a training data improver. Given an instruction and a response, "
    "rewrite the response to be more detailed, accurate, and helpful. "
    "Keep the same topic and intent. "
    "Reply ONLY with the improved response text, no JSON wrapping."
)

SYSTEM_PROMPT_EVALUATE = (
    "You are a training data quality evaluator. Score the given instruction-response pair "
    "on a scale of 1-10 for: accuracy, helpfulness, detail, and clarity. "
    "Reply ONLY with valid JSON: {\"accuracy\": N, \"helpfulness\": N, \"detail\": N, \"clarity\": N, \"overall\": N, \"reason\": \"...\"}"
)

SYSTEM_PROMPT_DPO_REJECT = (
    "You are generating a plausible but FLAWED response for DPO training. "
    "Given the instruction, write a response that is subtly wrong, incomplete, "
    "or slightly off-topic. It should look reasonable at first glance but be clearly "
    "worse than a high-quality answer. Reply ONLY with the flawed response text."
)

SYSTEM_PROMPT_BACKTRANSLATE = (
    "You are a training data diversifier. Given a high-quality assistant RESPONSE, "
    "generate a DIFFERENT user instruction that could naturally lead to this response. "
    "The new instruction should be phrased differently from the original, use different "
    "wording, perspective, or specificity level. This creates instruction diversity for "
    "the same knowledge. Reply ONLY with the new instruction text, no wrapping."
)

SYSTEM_PROMPT_SPIN_GENERATE = (
    "You are a knowledgeable AI assistant. Answer the user's instruction as accurately "
    "and helpfully as possible. Reply with only the answer, no meta-commentary."
)

SYSTEM_PROMPT_SPIN_JUDGE = (
    "You are a strict quality judge. Compare two responses to the same instruction. "
    "Decide which is better in terms of accuracy, completeness, helpfulness, and clarity. "
    "Reply ONLY with valid JSON: {\"winner\": \"A\" or \"B\", \"reason\": \"brief explanation\"}"
)


# ─── Config loading ──────────────────────────────────────────────────────────

def load_config() -> dict:
    """Load OpenClaw config and extract OpenRouter settings."""
    if not CONFIG_PATH.exists():
        print(f"ERROR: Config not found: {CONFIG_PATH}", file=sys.stderr)
        sys.exit(1)
    with open(CONFIG_PATH, encoding="utf-8") as f:
        cfg = json.load(f)
    return cfg


def get_api_key(cfg: dict) -> str:
    """Get OpenRouter API key from config or environment."""
    sys_cfg = cfg.get("system", {})
    or_cfg = sys_cfg.get("openrouter", {})
    api_key = or_cfg.get("api_key", "") or os.environ.get("OPENROUTER_API_KEY", "")
    if not api_key:
        print("ERROR: OPENROUTER_API_KEY not set in config or environment.", file=sys.stderr)
        sys.exit(1)
    return api_key


def get_model(cfg: dict, task: str = "general") -> str:
    """Get the appropriate model from model_router for a given task."""
    sys_cfg = cfg.get("system", {})
    router = sys_cfg.get("model_router", {})
    return router.get(task, router.get("general", "nvidia/nemotron-3-super-120b-a12b:free"))


# ─── Argument parser ─────────────────────────────────────────────────────────

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Cloud-based training data distillation for OpenClaw"
    )
    sub = p.add_subparsers(dest="mode", required=True, help="Operation mode")

    # generate
    gen = sub.add_parser("generate", help="Generate new synthetic training pairs")
    gen.add_argument("--topic", default="", help="Topic for generation (empty = cycle defaults)")
    gen.add_argument("--count", type=int, default=10, help="Number of pairs to generate")
    gen.add_argument("--output", default=str(DEFAULT_OUTPUT / "synthetic_generated.jsonl"))
    gen.add_argument("--temperature", type=float, default=0.8)
    gen.add_argument("--model-task", default="general", help="model_router key to use")
    gen.add_argument("--concurrent", type=int, default=1,
                     help="Number of concurrent API requests (1-8)")

    # improve
    imp = sub.add_parser("improve", help="Improve existing training responses")
    imp.add_argument("--dataset", required=True, help="Input JSONL file")
    imp.add_argument("--output", default="")
    imp.add_argument("--temperature", type=float, default=0.4)
    imp.add_argument("--model-task", default="general", help="model_router key to use")
    imp.add_argument("--min-score", type=float, default=0.0, help="Only improve pairs with score below this (0=all)")
    imp.add_argument("--concurrent", type=int, default=1,
                     help="Number of concurrent API requests (1-8)")

    # evaluate
    ev = sub.add_parser("evaluate", help="Evaluate training data quality")
    ev.add_argument("--dataset", required=True, help="Input JSONL file")
    ev.add_argument("--output", default="")
    ev.add_argument("--threshold", type=float, default=5.0, help="Min overall score to keep")
    ev.add_argument("--model-task", default="general", help="model_router key to use")

    # dpo — generate preference pairs (chosen + rejected)
    dpo = sub.add_parser("dpo", help="Generate DPO preference pairs from existing dataset")
    dpo.add_argument("--dataset", required=True, help="Input JSONL (good responses = chosen)")
    dpo.add_argument("--output", default="")
    dpo.add_argument("--temperature", type=float, default=0.9, help="Temperature for rejected generation")
    dpo.add_argument("--model-task", default="general", help="model_router key to use")
    dpo.add_argument("--concurrent", type=int, default=1, help="Number of concurrent API requests (1-8)")

    # backtranslate — generate diverse instructions from existing responses
    bt = sub.add_parser("backtranslate", help="Generate diverse instructions for existing responses")
    bt.add_argument("--dataset", required=True, help="Input JSONL (high-quality pairs)")
    bt.add_argument("--output", default="")
    bt.add_argument("--temperature", type=float, default=0.85, help="Temperature for instruction generation")
    bt.add_argument("--model-task", default="general", help="model_router key to use")
    bt.add_argument("--concurrent", type=int, default=1, help="Number of concurrent API requests (1-8)")
    bt.add_argument("--variants", type=int, default=2, help="Number of instruction variants per response (1-5)")

    # spin — self-play quality filtering
    sp = sub.add_parser("spin", help="SPIN self-play: model generates, judge compares to existing")
    sp.add_argument("--dataset", required=True, help="Input JSONL with reference pairs")
    sp.add_argument("--output", default="")
    sp.add_argument("--temperature", type=float, default=0.7, help="Temperature for model generation")
    sp.add_argument("--model-task", default="general", help="model_router key for generation")
    sp.add_argument("--judge-task", default="general", help="model_router key for judging")
    sp.add_argument("--concurrent", type=int, default=1, help="Number of concurrent API requests (1-8)")

    return p.parse_args()


# ─── Data loading ─────────────────────────────────────────────────────────────

def load_dataset_local(path: str) -> list[dict]:
    """Load JSONL in Alpaca format and return list of dicts."""
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
            output = (obj.get("output") or obj.get("response") or "").strip()
            if not instruction or not output:
                continue
            records.append({"instruction": instruction, "response": output})
    print(f"Loaded {len(records)} records from {path}")
    return records


def save_jsonl(records: list[dict], path: str) -> None:
    """Save records to JSONL file."""
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        for rec in records:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    print(f"Saved {len(records)} records → {path}")


# ─── OpenRouter API calls ────────────────────────────────────────────────────

async def call_openrouter(
    session: aiohttp.ClientSession,
    api_key: str,
    model: str,
    messages: list[dict],
    temperature: float = 0.7,
    max_tokens: int = 2048,
) -> str:
    """Call OpenRouter chat completions API. Returns assistant content."""
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://openclaw.ai",
        "X-Title": "OpenClaw Training Pipeline",
    }
    payload = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
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
                    wait = 2 ** (attempt + 1)
                    print(f"  Rate limited, waiting {wait}s...")
                    await asyncio.sleep(wait)
                    continue
                resp.raise_for_status()
                data = await resp.json()
                choices = data.get("choices", [])
                if choices:
                    return choices[0].get("message", {}).get("content", "").strip()
                return ""
        except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
            if attempt < 2:
                await asyncio.sleep(2 ** attempt)
            else:
                print(f"  API error after 3 attempts: {exc}", file=sys.stderr)
                return ""
    return ""


# ─── Helper: parse LLM response into training pair ────────────────────────────

def _parse_generated_pair(content: str) -> dict | None:
    """Parse LLM response into {instruction, response} or None."""
    if not content:
        return None
    clean = content.strip()
    if clean.startswith("```"):
        clean = clean.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
    try:
        obj = json.loads(clean)
        instruction = obj.get("instruction", "").strip()
        response = (obj.get("response") or obj.get("output") or "").strip()
        if instruction and response:
            return {"instruction": instruction, "response": response}
    except json.JSONDecodeError:
        pass
    return None


# ─── Mode: generate ──────────────────────────────────────────────────────────

async def run_generate(args: argparse.Namespace, cfg: dict) -> None:
    api_key = get_api_key(cfg)
    model = get_model(cfg, args.model_task)
    topics = [args.topic] if args.topic else DEFAULT_TOPICS
    concurrency = max(1, min(args.concurrent, 8))

    print(f"=== OpenClaw Cloud Distillation: GENERATE ===")
    print(f"  Model      : {model}")
    print(f"  Count      : {args.count}")
    print(f"  Topics     : {len(topics)}")
    print(f"  Concurrent : {concurrency}")
    print(f"  Output     : {args.output}")
    print()

    results: list[dict] = []
    sem = asyncio.Semaphore(concurrency)

    async def _generate_one(session, idx: int) -> dict | None:
        topic = topics[idx % len(topics)]
        messages = [
            {"role": "system", "content": SYSTEM_PROMPT_GENERATE},
            {"role": "user", "content": f"Generate a training pair about: {topic}. Pair #{idx+1}."},
        ]
        async with sem:
            content = await call_openrouter(session, api_key, model, messages, args.temperature)
            await asyncio.sleep(0.5)  # rate limit spacing
        pair = _parse_generated_pair(content)
        status = "OK" if pair else "SKIP"
        print(f"  [{idx+1}/{args.count}] ({topic[:40]}...) {status}")
        return pair

    async with aiohttp.ClientSession() as session:
        tasks = [_generate_one(session, i) for i in range(args.count)]
        outcomes = await asyncio.gather(*tasks, return_exceptions=True)
        for outcome in outcomes:
            if isinstance(outcome, dict):
                results.append(outcome)

    if results:
        save_jsonl(results, args.output)
    else:
        print("No pairs generated.")
    print(f"\nGenerated {len(results)}/{args.count} training pairs.")


# ─── Mode: improve ───────────────────────────────────────────────────────────

async def run_improve(args: argparse.Namespace, cfg: dict) -> None:
    api_key = get_api_key(cfg)
    model = get_model(cfg, args.model_task)
    records = load_dataset_local(args.dataset)
    output_path = args.output or args.dataset.replace(".jsonl", "_improved.jsonl")
    concurrency = max(1, min(args.concurrent, 8))

    print(f"=== OpenClaw Cloud Distillation: IMPROVE ===")
    print(f"  Model      : {model}")
    print(f"  Input      : {args.dataset} ({len(records)} records)")
    print(f"  Concurrent : {concurrency}")
    print(f"  Output     : {output_path}")
    print()

    improved: list[dict] = [None] * len(records)  # preserve order
    sem = asyncio.Semaphore(concurrency)

    async def _improve_one(session, idx: int, rec: dict) -> None:
        messages = [
            {"role": "system", "content": SYSTEM_PROMPT_IMPROVE},
            {"role": "user", "content": (
                f"Instruction: {rec['instruction']}\n\n"
                f"Current response: {rec['response']}\n\n"
                "Rewrite the response to be more detailed and helpful."
            )},
        ]
        async with sem:
            content = await call_openrouter(session, api_key, model, messages, args.temperature)
            await asyncio.sleep(0.5)

        if content and len(content) > len(rec["response"]) * 0.5:
            improved[idx] = {"instruction": rec["instruction"], "response": content}
            print(f"  [{idx+1}/{len(records)}] OK ({len(rec['response'])} → {len(content)} chars)")
        else:
            improved[idx] = rec
            print(f"  [{idx+1}/{len(records)}] KEPT (original)")

    async with aiohttp.ClientSession() as session:
        tasks = [_improve_one(session, i, rec) for i, rec in enumerate(records)]
        await asyncio.gather(*tasks, return_exceptions=True)

    # Replace None with original (safety fallback)
    for i, rec in enumerate(improved):
        if rec is None:
            improved[i] = records[i]

    save_jsonl(improved, output_path)
    changed = sum(1 for o, n in zip(records, improved) if o["response"] != n["response"])
    print(f"\nImproved {changed}/{len(records)} responses.")


# ─── Mode: evaluate ──────────────────────────────────────────────────────────

async def run_evaluate(args: argparse.Namespace, cfg: dict) -> None:
    api_key = get_api_key(cfg)
    model = get_model(cfg, args.model_task)
    records = load_dataset_local(args.dataset)
    output_path = args.output or args.dataset.replace(".jsonl", "_evaluated.jsonl")

    print(f"=== OpenClaw Cloud Distillation: EVALUATE ===")
    print(f"  Model     : {model}")
    print(f"  Input     : {args.dataset} ({len(records)} records)")
    print(f"  Threshold : {args.threshold}")
    print()

    scored = []
    passed = 0
    async with aiohttp.ClientSession() as session:
        for i, rec in enumerate(records):
            messages = [
                {"role": "system", "content": SYSTEM_PROMPT_EVALUATE},
                {"role": "user", "content": (
                    f"Instruction: {rec['instruction']}\n\n"
                    f"Response: {rec['response']}"
                )},
            ]
            print(f"  [{i+1}/{len(records)}] Evaluating... ", end="", flush=True)
            content = await call_openrouter(session, api_key, model, messages, temperature=0.1)

            score = 0.0
            reason = ""
            if content:
                try:
                    clean = content.strip()
                    if clean.startswith("```"):
                        clean = clean.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
                    obj = json.loads(clean)
                    score = float(obj.get("overall", 0))
                    reason = obj.get("reason", "")
                except (json.JSONDecodeError, ValueError):
                    score = 0.0

            rec_out = {**rec, "score": score, "eval_reason": reason}
            if score >= args.threshold:
                scored.append(rec_out)
                passed += 1
                print(f"PASS ({score:.1f}) {reason[:50]}")
            else:
                print(f"FAIL ({score:.1f}) {reason[:50]}")

            await asyncio.sleep(1.0)

    if scored:
        # Save only high-quality pairs
        save_jsonl(scored, output_path)
    print(f"\nPassed {passed}/{len(records)} (threshold={args.threshold}).")

    # Also save full report
    report_path = output_path.replace(".jsonl", "_report.json")
    report = {
        "total": len(records),
        "passed": passed,
        "failed": len(records) - passed,
        "threshold": args.threshold,
        "model": model,
    }
    with open(report_path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)
    print(f"Report saved → {report_path}")


# ─── Mode: dpo (DPO preference pair generation) ─────────────────────────────

async def run_dpo(args: argparse.Namespace, cfg: dict) -> None:
    """Generate DPO-compatible preference pairs from existing good-quality dataset.

    Takes existing (instruction, response) pairs as 'chosen' and uses an LLM
    to generate subtly flawed 'rejected' responses for each instruction.
    Output format: {prompt, chosen, rejected} — compatible with TRL DPOTrainer.
    """
    api_key = get_api_key(cfg)
    model = get_model(cfg, args.model_task)
    records = load_dataset_local(args.dataset)
    output_path = args.output or args.dataset.replace(".jsonl", "_dpo.jsonl")
    concurrency = max(1, min(args.concurrent, 8))

    print(f"=== OpenClaw Cloud Distillation: DPO ===")
    print(f"  Model      : {model}")
    print(f"  Input      : {args.dataset} ({len(records)} records)")
    print(f"  Concurrent : {concurrency}")
    print(f"  Output     : {output_path}")
    print()

    dpo_pairs: list[dict | None] = [None] * len(records)
    sem = asyncio.Semaphore(concurrency)

    async def _generate_rejected(session, idx: int, rec: dict) -> None:
        messages = [
            {"role": "system", "content": SYSTEM_PROMPT_DPO_REJECT},
            {"role": "user", "content": (
                f"Instruction: {rec['instruction']}\n\n"
                "Write a plausible but subtly flawed response."
            )},
        ]
        async with sem:
            rejected = await call_openrouter(
                session, api_key, model, messages, args.temperature
            )
            await asyncio.sleep(0.5)

        if rejected and rejected != rec["response"]:
            dpo_pairs[idx] = {
                "prompt": rec["instruction"],
                "chosen": rec["response"],
                "rejected": rejected,
            }
            print(f"  [{idx+1}/{len(records)}] OK (rejected {len(rejected)} chars)")
        else:
            print(f"  [{idx+1}/{len(records)}] SKIP (empty or duplicate)")

    async with aiohttp.ClientSession() as session:
        tasks = [
            _generate_rejected(session, i, rec) for i, rec in enumerate(records)
        ]
        await asyncio.gather(*tasks, return_exceptions=True)

    results = [p for p in dpo_pairs if p is not None]
    if results:
        save_jsonl(results, output_path)
    else:
        print("No DPO pairs generated.")
    print(f"\nGenerated {len(results)}/{len(records)} DPO preference pairs.")


# ─── Mode: backtranslate ─────────────────────────────────────────────────────

async def run_backtranslate(args: argparse.Namespace, cfg: dict) -> None:
    """Generate diverse instruction variants for existing (instruction, response) pairs.

    For each input pair, generates N new instructions that could naturally lead
    to the same response. This increases instruction diversity without requiring
    new responses — the model learns to recognize many phrasings for the same knowledge.
    """
    api_key = get_api_key(cfg)
    model = get_model(cfg, args.model_task)
    records = load_dataset_local(args.dataset)
    output_path = args.output or args.dataset.replace(".jsonl", "_backtranslated.jsonl")
    concurrency = max(1, min(args.concurrent, 8))
    variants = max(1, min(args.variants, 5))

    print(f"=== OpenClaw Cloud Distillation: BACKTRANSLATE ===")
    print(f"  Model      : {model}")
    print(f"  Input      : {args.dataset} ({len(records)} records)")
    print(f"  Variants   : {variants} per record")
    print(f"  Concurrent : {concurrency}")
    print(f"  Output     : {output_path}")
    print()

    new_pairs: list[dict] = []
    sem = asyncio.Semaphore(concurrency)

    async def _backtranslate_one(session, idx: int, rec: dict, variant: int) -> dict | None:
        messages = [
            {"role": "system", "content": SYSTEM_PROMPT_BACKTRANSLATE},
            {"role": "user", "content": (
                f"Original instruction (for reference, DO NOT copy): {rec['instruction']}\n\n"
                f"Response:\n{rec['response']}\n\n"
                f"Generate instruction variant #{variant + 1} (different from original)."
            )},
        ]
        async with sem:
            new_instr = await call_openrouter(
                session, api_key, model, messages, args.temperature
            )
            await asyncio.sleep(0.5)

        if not new_instr or len(new_instr) < 10:
            return None
        # Skip if too similar to original
        if new_instr.strip().lower() == rec["instruction"].strip().lower():
            return None
        return {"instruction": new_instr.strip(), "response": rec["response"]}

    async with aiohttp.ClientSession() as session:
        tasks = []
        for i, rec in enumerate(records):
            for v in range(variants):
                tasks.append(_backtranslate_one(session, i, rec, v))
        outcomes = await asyncio.gather(*tasks, return_exceptions=True)
        for outcome in outcomes:
            if isinstance(outcome, dict):
                new_pairs.append(outcome)

    # Include original records + generated variants
    combined = list(records) + new_pairs
    if combined:
        save_jsonl(combined, output_path)
    print(f"\nBacktranslated: {len(new_pairs)} new variants from {len(records)} records.")
    print(f"Total output: {len(combined)} records (originals + variants).")


# ─── Mode: spin (self-play quality filtering) ────────────────────────────────

async def run_spin(args: argparse.Namespace, cfg: dict) -> None:
    """SPIN-inspired self-play: model generates its own answer, judge picks the best.

    For each (instruction, response) pair:
      1. Cloud model generates a fresh response to the instruction
      2. Judge model compares original vs generated
      3. The winner response is kept in the output dataset

    This filters out stale or suboptimal training data — if the model can already
    beat the reference, that sample no longer teaches anything new.
    """
    api_key = get_api_key(cfg)
    gen_model = get_model(cfg, args.model_task)
    judge_model = get_model(cfg, args.judge_task)
    records = load_dataset_local(args.dataset)
    output_path = args.output or args.dataset.replace(".jsonl", "_spin.jsonl")
    concurrency = max(1, min(args.concurrent, 8))

    print(f"=== OpenClaw Cloud Distillation: SPIN ===")
    print(f"  Generator  : {gen_model}")
    print(f"  Judge      : {judge_model}")
    print(f"  Input      : {args.dataset} ({len(records)} records)")
    print(f"  Concurrent : {concurrency}")
    print(f"  Output     : {output_path}")
    print()

    results: list[dict | None] = [None] * len(records)
    stats = {"ref_wins": 0, "gen_wins": 0, "errors": 0}
    sem = asyncio.Semaphore(concurrency)

    async def _spin_one(session, idx: int, rec: dict) -> None:
        # Step 1: Generate a fresh response
        gen_messages = [
            {"role": "system", "content": SYSTEM_PROMPT_SPIN_GENERATE},
            {"role": "user", "content": rec["instruction"]},
        ]
        async with sem:
            generated = await call_openrouter(
                session, api_key, gen_model, gen_messages, args.temperature
            )
            await asyncio.sleep(0.3)

        if not generated:
            results[idx] = rec  # keep original on error
            stats["errors"] += 1
            print(f"  [{idx+1}/{len(records)}] ERROR (empty generation)")
            return

        # Step 2: Judge compares. Randomize order to avoid position bias.
        if random.random() < 0.5:
            a_text, b_text = rec["response"], generated
            a_label, b_label = "ref", "gen"
        else:
            a_text, b_text = generated, rec["response"]
            a_label, b_label = "gen", "ref"

        judge_messages = [
            {"role": "system", "content": SYSTEM_PROMPT_SPIN_JUDGE},
            {"role": "user", "content": (
                f"Instruction: {rec['instruction']}\n\n"
                f"Response A:\n{a_text}\n\n"
                f"Response B:\n{b_text}\n\n"
                "Which is better?"
            )},
        ]
        async with sem:
            verdict_raw = await call_openrouter(
                session, api_key, judge_model, judge_messages, temperature=0.1
            )
            await asyncio.sleep(0.3)

        # Parse judge verdict
        winner_label = a_label  # default to ref
        try:
            clean = verdict_raw.strip()
            if clean.startswith("```"):
                clean = clean.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
            verdict = json.loads(clean)
            winner_key = verdict.get("winner", "A").upper()
            winner_label = a_label if winner_key == "A" else b_label
        except (json.JSONDecodeError, ValueError):
            winner_label = a_label  # fallback to position A

        if winner_label == "ref":
            results[idx] = rec
            stats["ref_wins"] += 1
            print(f"  [{idx+1}/{len(records)}] REF wins")
        else:
            results[idx] = {"instruction": rec["instruction"], "response": generated}
            stats["gen_wins"] += 1
            print(f"  [{idx+1}/{len(records)}] GEN wins (upgraded)")

    async with aiohttp.ClientSession() as session:
        tasks = [_spin_one(session, i, rec) for i, rec in enumerate(records)]
        await asyncio.gather(*tasks, return_exceptions=True)

    # Replace None with originals (safety fallback)
    for i, rec in enumerate(results):
        if rec is None:
            results[i] = records[i]

    save_jsonl(results, output_path)
    print(f"\nSPIN results: ref={stats['ref_wins']}, gen={stats['gen_wins']}, errors={stats['errors']}")
    print(f"Upgraded {stats['gen_wins']}/{len(records)} responses with better model output.")


# ─── Main ────────────────────────────────────────────────────────────────────

def main() -> None:
    args = parse_args()
    cfg = load_config()

    if args.mode == "generate":
        asyncio.run(run_generate(args, cfg))
    elif args.mode == "improve":
        asyncio.run(run_improve(args, cfg))
    elif args.mode == "evaluate":
        asyncio.run(run_evaluate(args, cfg))
    elif args.mode == "dpo":
        asyncio.run(run_dpo(args, cfg))
    elif args.mode == "backtranslate":
        asyncio.run(run_backtranslate(args, cfg))
    elif args.mode == "spin":
        asyncio.run(run_spin(args, cfg))


if __name__ == "__main__":
    main()
