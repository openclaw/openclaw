#!/usr/bin/env python3

import json
import subprocess
import argparse
from collections import defaultdict

def load_cost_data(provider):
    result = subprocess.run(
        ["codexbar", "cost", "--provider", provider, "--format", "json"],
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(result.stdout)

def summarize_by_model(data):
    totals = defaultdict(float)
    for day in data:
        for model, cost in day.get("modelBreakdowns", {}).items():
            totals[model] += cost
    return totals

def main():
    parser = argparse.ArgumentParser(
        description="Summarize per-model usage cost from CodexBar"
    )
    parser.add_argument(
        "--provider",
        required=True,
        choices=["codex", "claude"],
        help="Model provider",
    )
    args = parser.parse_args()

    data = load_cost_data(args.provider)
    summary = summarize_by_model(data)

    for model, cost in sorted(summary.items(), key=lambda x: -x[1]):
        print(f"{model}: ${cost:.2f}")

if __name__ == "__main__":
    main()
