#!/usr/bin/env python3
"""
generate_from_patterns.py — Bridge between auto_learning and training pipeline.

Reads patterns from src/ai/agents/special_skills.json (FeedbackLoopEngine output)
and generates targeted training data using train_lora.py's generate mode.

This closes the feedback loop: successful commits → extracted patterns → training data.

Usage:
    python scripts/generate_from_patterns.py
    python scripts/generate_from_patterns.py --count 5 --min-score 0.6
    python scripts/generate_from_patterns.py --dry-run
"""
import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).parent.parent
SKILLS_PATH = ROOT / "src" / "ai" / "agents" / "special_skills.json"
OUTPUT_DIR = ROOT / "data" / "training"


def load_patterns(min_score: float = 0.5) -> list[dict]:
    """Load high-quality patterns from special_skills.json."""
    if not SKILLS_PATH.exists():
        print(f"No skills file found at {SKILLS_PATH}", file=sys.stderr)
        return []
    with open(SKILLS_PATH, encoding="utf-8") as f:
        data = json.load(f)

    patterns = data.get("patterns", []) if isinstance(data, dict) else data
    filtered = [p for p in patterns if p.get("score", 0) >= min_score]
    filtered.sort(key=lambda p: p.get("score", 0), reverse=True)
    return filtered


def pattern_to_topic(pattern: dict) -> str:
    """Convert a code pattern into a training generation topic."""
    desc = pattern.get("description", "")
    lang = pattern.get("language", "")
    tags = pattern.get("tags", [])
    snippet = pattern.get("code_snippet", "")[:200]

    topic_parts = []
    if desc:
        topic_parts.append(desc)
    if lang:
        topic_parts.append(f"({lang})")
    if tags:
        topic_parts.append(f"[tags: {', '.join(tags)}]")
    if snippet:
        topic_parts.append(f"Code context: {snippet}")

    return " ".join(topic_parts)


def pattern_to_training_pair(pattern: dict) -> dict | None:
    """Convert a pattern directly into a training instruction/response pair."""
    desc = pattern.get("description", "")
    lang = pattern.get("language", "python")
    snippet = pattern.get("code_snippet", "")
    tags = pattern.get("tags", [])

    if not snippet or not desc:
        return None

    tag_str = ", ".join(tags) if tags else "general"
    instruction = f"Покажи пример реализации: {desc} ({lang}, {tag_str})"
    response = (
        f"Вот пример паттерна ({lang}):\n\n"
        f"```{lang}\n{snippet}\n```\n\n"
        f"Этот паттерн использует: {tag_str}. "
        f"Он был извлечён из успешного коммита и показал высокую оценку качества "
        f"({pattern.get('score', 0):.2f})."
    )
    return {"instruction": instruction, "response": response}


def main():
    parser = argparse.ArgumentParser(
        description="Generate training data from auto_learning patterns"
    )
    parser.add_argument("--min-score", type=float, default=0.5,
                        help="Minimum pattern quality score (0-1)")
    parser.add_argument("--count", type=int, default=0,
                        help="Max patterns to use (0=all)")
    parser.add_argument("--output", default=str(OUTPUT_DIR / "pattern_generated.jsonl"))
    parser.add_argument("--dry-run", action="store_true", help="Only show stats")
    parser.add_argument("--topics-only", action="store_true",
                        help="Print topics for train_lora.py generate")
    args = parser.parse_args()

    patterns = load_patterns(args.min_score)
    if not patterns:
        print("No patterns found above threshold.")
        return

    if args.count > 0:
        patterns = patterns[:args.count]

    print(f"Loaded {len(patterns)} patterns (min score: {args.min_score})")

    if args.topics_only:
        print("\nTopics for generate mode:")
        for p in patterns:
            print(f"  - {pattern_to_topic(p)}")
        return

    # Generate direct training pairs from patterns
    pairs = []
    for p in patterns:
        pair = pattern_to_training_pair(p)
        if pair:
            pairs.append(pair)

    print(f"Generated {len(pairs)} training pairs from patterns")

    if args.dry_run:
        for i, pair in enumerate(pairs[:5]):
            print(f"\n--- Sample {i+1} ---")
            print(f"  Instruction: {pair['instruction'][:100]}...")
            print(f"  Response:    {pair['response'][:100]}...")
        return

    # Save
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    with open(args.output, "w", encoding="utf-8") as f:
        for pair in pairs:
            f.write(json.dumps(pair, ensure_ascii=False) + "\n")
    print(f"Saved → {args.output}")

    # Print follow-up command for cloud augmentation
    print(f"\nTo augment with cloud LLM:")
    topics = [pattern_to_topic(p) for p in patterns[:3]]
    for t in topics:
        print(f'  python scripts/train_lora.py generate --topic "{t[:80]}" --count 5')


if __name__ == "__main__":
    main()
