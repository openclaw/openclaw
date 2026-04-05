#!/usr/bin/env python3
"""
prepare_training.py — Объединение и подготовка тренировочного датасета.

Мерджит все источники данных в единый файл для QLoRA,
дедуплицирует, создаёт eval сплит, генерирует отчёт.

Использование:
    python scripts/prepare_training.py
    python scripts/prepare_training.py --eval-ratio 0.15
    python scripts/prepare_training.py --dry-run
"""
import argparse
import json
import hashlib
import random
import re
import sys
from pathlib import Path
from collections import Counter


def load_jsonl(path: Path) -> list[dict]:
    """Загружает JSONL файл."""
    records = []
    if not path.exists():
        return records
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return records


def normalize_record(rec: dict) -> dict:
    """Нормализует запись к единому формату instruction/response."""
    instruction = rec.get("instruction", "").strip()
    # raw_dialogues uses "response" or "output"
    response = (rec.get("response") or rec.get("output") or "").strip()
    # phase7 uses "insight" as response
    if not response and "insight" in rec:
        instruction = f"Объясни инсайт: {rec.get('source', 'unknown')}"
        response = rec["insight"].strip()

    return {
        "instruction": instruction,
        "response": response,
        "source": rec.get("source", "unknown"),
        "tags": rec.get("tags", []),
        "category": rec.get("category", "general"),
    }


def content_hash(rec: dict) -> str:
    """Хеш для дедупликации по instruction."""
    text = rec["instruction"].lower().strip()
    return hashlib.md5(text.encode("utf-8")).hexdigest()


def _estimate_tokens(text: str) -> int:
    """Rough token estimate: ~4 chars per token for mixed EN/RU text."""
    return len(text) // 4


def _duplicate_phrase_ratio(text: str, ngram_size: int = 5) -> float:
    """Fraction of repeated n-gram phrases in text (0.0 = no repeats, 1.0 = all repeats)."""
    words = text.lower().split()
    if len(words) < ngram_size * 2:
        return 0.0
    ngrams = [tuple(words[i:i + ngram_size]) for i in range(len(words) - ngram_size + 1)]
    unique = set(ngrams)
    if not ngrams:
        return 0.0
    return 1.0 - len(unique) / len(ngrams)


# Max token budget for a single training sample (instruction + response)
MAX_SAMPLE_TOKENS = 4096


def quality_score(rec: dict) -> float:
    """Оценка качества записи (0-1)."""
    score = 0.0
    resp = rec["response"]
    instr = rec["instruction"]

    # Token budget check — reject overly long samples
    total_tokens = _estimate_tokens(instr) + _estimate_tokens(resp)
    if total_tokens > MAX_SAMPLE_TOKENS:
        return 0.0  # skip: too long for training context window

    # Length bonus
    if len(resp) > 50: score += 0.2
    if len(resp) > 200: score += 0.2
    if len(resp) > 500: score += 0.1

    # Has structure (lists, code, tables)
    if "```" in resp: score += 0.15
    if "- " in resp or "* " in resp: score += 0.1
    if "|" in resp and "---" in resp: score += 0.1

    # Has instruction
    if len(instr) > 20: score += 0.1
    if "?" in instr: score += 0.05

    # Penalize repetitive / low-information responses
    dup_ratio = _duplicate_phrase_ratio(resp)
    if dup_ratio > 0.4:
        score -= 0.3
    elif dup_ratio > 0.2:
        score -= 0.1

    return max(min(score, 1.0), 0.0)


def difficulty_score(rec: dict) -> float:
    """Estimate sample difficulty for curriculum learning (0.0=easy, 1.0=hard).

    Heuristics:
      - response length (longer = harder concepts)
      - code blocks presence (technical = harder)
      - multi-step structure (numbered lists = harder reasoning)
      - technical vocabulary density (EN terms in RU text)
      - instruction complexity (multi-part questions)
    """
    resp = rec["response"]
    instr = rec["instruction"]
    score = 0.0

    # Response length — longer answers imply more complex topics
    resp_len = len(resp)
    if resp_len > 1500:
        score += 0.25
    elif resp_len > 600:
        score += 0.15
    elif resp_len > 200:
        score += 0.05

    # Code blocks — technical content
    code_blocks = resp.count("```")
    if code_blocks >= 4:
        score += 0.2
    elif code_blocks >= 2:
        score += 0.1

    # Multi-step reasoning (numbered lists, step-by-step)
    numbered_steps = len(re.findall(r"^\s*\d+[\.\)]\s", resp, re.MULTILINE))
    if numbered_steps >= 5:
        score += 0.15
    elif numbered_steps >= 3:
        score += 0.08

    # Technical vocabulary density — proportion of ASCII/Latin words in text
    words = resp.split()
    if words:
        latin_words = sum(1 for w in words if w.isascii() and w.isalpha() and len(w) > 2)
        tech_ratio = latin_words / len(words)
        if tech_ratio > 0.3:
            score += 0.15
        elif tech_ratio > 0.15:
            score += 0.08

    # Instruction complexity — multiple questions or compound requests
    q_marks = instr.count("?")
    if q_marks >= 3:
        score += 0.1
    elif q_marks >= 2:
        score += 0.05
    # Multi-part connectors
    if any(kw in instr.lower() for kw in ["а также", "и ещё", "and also", "additionally", "кроме того"]):
        score += 0.05

    return max(min(score, 1.0), 0.0)


def main():
    parser = argparse.ArgumentParser(description="Prepare unified training dataset")
    parser.add_argument("--eval-ratio", type=float, default=0.1, help="Eval split ratio")
    parser.add_argument("--min-quality", type=float, default=0.2, help="Min quality score")
    parser.add_argument("--max-tokens", type=int, default=MAX_SAMPLE_TOKENS,
                        help="Max tokens per sample (instruction+response)")
    parser.add_argument("--seed", type=int, default=42, help="Random seed")
    parser.add_argument("--dry-run", action="store_true", help="Only show stats")
    parser.add_argument("--curriculum", action="store_true",
                        help="Sort train set by complexity (simple→hard) for curriculum learning")
    args = parser.parse_args()

    random.seed(args.seed)

    data_dir = Path("data/training")
    sources = {
        "raw_dialogues": data_dir / "raw_dialogues.jsonl",
        "vault_generated": data_dir / "vault_generated.jsonl",
        "phase7_best_practices": data_dir / "phase7_best_practices.jsonl",
        "pattern_generated": data_dir / "pattern_generated.jsonl",
    }

    # Load all sources
    all_records: list[dict] = []
    source_counts = {}
    for name, path in sources.items():
        records = load_jsonl(path)
        source_counts[name] = len(records)
        all_records.extend(records)

    print(f"\n{'='*55}")
    print(f"Training Data Preparation Report")
    print(f"{'='*55}")
    print(f"\nИсточники:")
    for name, count in source_counts.items():
        print(f"  {name}: {count} записей")
    print(f"  ИТОГО (до обработки): {len(all_records)}")

    # Normalize
    normalized = [normalize_record(r) for r in all_records]
    normalized = [r for r in normalized if r["instruction"] and r["response"]]
    print(f"\nПосле нормализации: {len(normalized)} записей")

    # Deduplicate by instruction hash
    seen_hashes: set[str] = set()
    deduped: list[dict] = []
    duplicates = 0
    for rec in normalized:
        h = content_hash(rec)
        if h not in seen_hashes:
            seen_hashes.add(h)
            deduped.append(rec)
        else:
            duplicates += 1
    print(f"Дубликатов удалено: {duplicates}")
    print(f"После дедупликации: {len(deduped)}")

    # Quality scoring
    scored = [(quality_score(r), r) for r in deduped]
    quality_filtered = [(s, r) for s, r in scored if s >= args.min_quality]
    low_quality = len(scored) - len(quality_filtered)
    print(f"Низкое качество (< {args.min_quality}): {low_quality}")
    print(f"После фильтрации: {len(quality_filtered)}")

    # Sort by quality (best first for eval selection)
    quality_filtered.sort(key=lambda x: -x[0])
    final_records = [r for _, r in quality_filtered]

    # Stats
    avg_instr_len = sum(len(r["instruction"]) for r in final_records) // max(len(final_records), 1)
    avg_resp_len = sum(len(r["response"]) for r in final_records) // max(len(final_records), 1)
    avg_tokens = sum(
        _estimate_tokens(r["instruction"]) + _estimate_tokens(r["response"])
        for r in final_records
    ) // max(len(final_records), 1)
    categories = Counter(r["category"] for r in final_records)

    print(f"\nСтатистика финального датасета:")
    print(f"  Средняя длина instruction: {avg_instr_len} символов")
    print(f"  Средняя длина response:    {avg_resp_len} символов")
    print(f"  Средний размер (tokens):   ~{avg_tokens} tokens")
    print(f"  Max tokens per sample:     {args.max_tokens}")
    print(f"\nКатегории:")
    for cat, count in categories.most_common():
        print(f"  {cat}: {count}")

    # Split into train/eval
    random.shuffle(final_records)
    eval_size = max(int(len(final_records) * args.eval_ratio), 10)
    eval_set = final_records[:eval_size]
    train_set = final_records[eval_size:]

    # Curriculum learning: sort train set by difficulty (simple → hard)
    if args.curriculum:
        train_set.sort(key=difficulty_score)
        diff_scores = [difficulty_score(r) for r in train_set]
        if diff_scores:
            avg_diff = sum(diff_scores) / len(diff_scores)
            print(f"\n  Curriculum learning: ON")
            print(f"  Avg difficulty: {avg_diff:.3f}")
            print(f"  First 10 samples difficulty: {[round(d, 2) for d in diff_scores[:10]]}")
            print(f"  Last  10 samples difficulty: {[round(d, 2) for d in diff_scores[-10:]]}")

    print(f"\nРазбивка:")
    print(f"  Train: {len(train_set)} записей")
    print(f"  Eval:  {len(eval_set)} записей")

    if args.dry_run:
        print(f"\n[DRY RUN] Файлы не записаны.")
        return

    # Write unified train file
    train_out = data_dir / "train_unified.jsonl"
    with open(train_out, "w", encoding="utf-8") as f:
        for rec in train_set:
            # Convert to Alpaca format for train_lora.py compatibility
            out = {
                "instruction": rec["instruction"],
                "input": "",
                "output": rec["response"],
            }
            f.write(json.dumps(out, ensure_ascii=False) + "\n")

    # Write eval file
    eval_out = Path("data/eval") / "eval_set.jsonl"
    eval_out.parent.mkdir(parents=True, exist_ok=True)
    with open(eval_out, "w", encoding="utf-8") as f:
        for rec in eval_set:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")

    train_kb = train_out.stat().st_size / 1024
    eval_kb = eval_out.stat().st_size / 1024

    print(f"\nЗаписано:")
    print(f"  Train: {train_out} ({train_kb:.1f} KB)")
    print(f"  Eval:  {eval_out} ({eval_kb:.1f} KB)")
    print(f"\nГотово к обучению:")
    print(f"  python scripts/train_lora.py --dataset {train_out}")


if __name__ == "__main__":
    main()
