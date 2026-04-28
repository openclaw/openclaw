#!/usr/bin/env python3
import argparse
import json
import sys
from pathlib import Path


def parse_csv_list(value: str | None) -> list[str]:
    if value is None:
        return []
    return [item.strip() for item in value.split(",") if item.strip()]


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Write a raw Codex result JSON file in the shape expected by adapt_codex_result.py."
    )
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--status", required=True, choices=["success", "succeeded", "failed", "error", "cancelled", "timed_out"])
    parser.add_argument("--summary", required=True)
    parser.add_argument("--completed-at")
    parser.add_argument("--sequence", type=int)
    parser.add_argument("--files-changed", help="Comma-separated list")
    parser.add_argument("--testing", help="Comma-separated list")
    parser.add_argument("--open-questions", help="Comma-separated list")
    parser.add_argument("--exit-code", type=int)
    parser.add_argument("--output", help="Explicit output file path")
    parser.add_argument(
        "--out-dir",
        default="/home/mertb/.openclaw/workspace/.openclaw/codex-queue/outbound",
        help="Directory to write the raw Codex result into when --output is omitted.",
    )
    args = parser.parse_args()

    payload = {
        "job_id": args.job_id,
        "status": args.status,
        "summary": args.summary,
        "files_changed": parse_csv_list(args.files_changed),
    }
    if args.completed_at:
        payload["completed_at"] = args.completed_at
    if args.sequence is not None:
        payload["sequence"] = args.sequence
    testing = parse_csv_list(args.testing)
    if testing:
        payload["testing"] = testing
    open_questions = parse_csv_list(args.open_questions)
    if open_questions:
        payload["open_questions"] = open_questions
    if args.exit_code is not None:
        payload["exit_code"] = args.exit_code

    output_path = Path(args.output) if args.output else Path(args.out_dir) / f"{args.job_id}.result.json"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(str(output_path))
    return 0


if __name__ == "__main__":
    sys.exit(main())
