#!/usr/bin/env python3
"""
Evaluate whether a skill description would trigger for a set of test prompts.

Usage:
    python3 eval_description.py --skill path/to/SKILL.md --evals path/to/evals.json

Evals JSON format:
    [
        {"prompt": "幫我查垃圾車", "should_trigger": true},
        {"prompt": "今天天氣如何", "should_trigger": false}
    ]

The script prints each prompt and asks you (the agent) to judge:
  - Would you read the skill's SKILL.md given only the description + this prompt?
  - Enter y/n for each

Then it reports the pass rate.
"""

import argparse
import json
import sys
from pathlib import Path


def parse_skill_md(path: Path) -> dict:
    text = path.read_text()
    lines = text.splitlines()
    if not lines[0].strip() == "---":
        return {"name": path.parent.name, "description": ""}

    end = lines.index("---", 1)
    frontmatter = "\n".join(lines[1:end])
    name, description = "", ""
    for line in frontmatter.splitlines():
        if line.startswith("name:"):
            name = line.split(":", 1)[1].strip()
        elif line.startswith("description:"):
            description = line.split(":", 1)[1].strip()
    return {"name": name, "description": description}


def run_eval(skill_path: Path, evals: list[dict]) -> None:
    skill = parse_skill_md(skill_path)
    print(f"\n{'='*60}")
    print(f"Skill: {skill['name']}")
    print(f"Description:\n  {skill['description']}")
    print(f"{'='*60}\n")
    print("For each prompt, enter y (would trigger) or n (would not trigger).\n")

    results = []
    for i, case in enumerate(evals, 1):
        prompt = case["prompt"]
        expected = case["should_trigger"]
        print(f"[{i}/{len(evals)}] Prompt: {prompt}")
        print(f"       Expected: {'TRIGGER' if expected else 'NO TRIGGER'}")

        while True:
            ans = input("       Your judgment (y/n): ").strip().lower()
            if ans in ("y", "n"):
                break

        actual = ans == "y"
        correct = actual == expected
        status = "✅ PASS" if correct else "❌ FAIL"
        print(f"       {status}\n")
        results.append({"prompt": prompt, "expected": expected, "actual": actual, "correct": correct})

    passed = sum(1 for r in results if r["correct"])
    total = len(results)
    if total == 0:
        print("No eval cases to run.")
        return
    rate = passed / total * 100

    print(f"{'='*60}")
    print(f"Results: {passed}/{total} ({rate:.0f}%)")
    if rate < 80:
        print("⚠️  Below 80% — description needs improvement.")
        fp = [r for r in results if not r["correct"] and r["actual"]]
        fn = [r for r in results if not r["correct"] and not r["actual"]]
        if fn:
            print(f"\nFalse negatives (should trigger, didn't):")
            for r in fn:
                print(f"  - {r['prompt']}")
        if fp:
            print(f"\nFalse positives (shouldn't trigger, did):")
            for r in fp:
                print(f"  - {r['prompt']}")
    else:
        print("✅ Description looks good!")
    print(f"{'='*60}\n")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--skill", required=True, help="Path to SKILL.md")
    parser.add_argument("--evals", required=True, help="Path to evals JSON file")
    args = parser.parse_args()

    skill_path = Path(args.skill)
    evals_path = Path(args.evals)

    if not skill_path.exists():
        print(f"Error: {skill_path} not found", file=sys.stderr)
        sys.exit(1)

    if not evals_path.exists():
        print(f"Error: {evals_path} not found", file=sys.stderr)
        sys.exit(1)

    evals = json.loads(evals_path.read_text())
    run_eval(skill_path, evals)


if __name__ == "__main__":
    main()
