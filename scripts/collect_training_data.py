#!/usr/bin/env python3
"""
collect_training_data.py — Collect conversation logs from OpenClaw bot for LoRA training.

Parses logs/bot_current.log and captures (user_prompt → final_response) pairs.
Saves to data/training/raw_dialogues.jsonl

Usage:
    python scripts/collect_training_data.py
    python scripts/collect_training_data.py --log logs/bot_current.log --out data/training/raw.jsonl
"""
import argparse
import json
import re
import sys
from datetime import datetime
from pathlib import Path

# ─── Paths ────────────────────────────────────────────────────────────────────
ROOT = Path(__file__).parent.parent
DEFAULT_LOG = ROOT / "logs" / "bot_current.log"
DEFAULT_OUT = ROOT / "data" / "training" / "raw_dialogues.jsonl"

# ─── Regex patterns in structlog JSON lines ───────────────────────────────────
# Pipeline start carries the user prompt
RE_PIPELINE_START = re.compile(r'"Pipeline START.*?"')
# User message coming from Telegram handler
RE_USER_MSG = re.compile(r'"user_text":\s*"([^"]+)"')
RE_USER_MSG2 = re.compile(r'"message":\s*"([^"]+)".*?"from_user"')
# Final response
RE_FINAL_RESP = re.compile(r'"final_response":\s*"((?:[^"\\]|\\.)*)"')
RE_PIPELINE_DONE = re.compile(r'"Pipeline DONE|pipeline_done|final_response"')

# ─── Helpers ──────────────────────────────────────────────────────────────────

def _unescape(s: str) -> str:
    """Basic JSON string unescape."""
    try:
        return json.loads(f'"{s}"')
    except Exception:
        return s


def parse_log(log_path: Path) -> list[dict]:
    """Parse structlog JSONL entries and pair user prompts with final responses."""
    sessions: list[dict] = []
    current: dict | None = None

    with open(log_path, encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue

            # Try parse as JSON
            entry: dict = {}
            if line.startswith("{"):
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    pass

            # Detect user message start
            user_text: str = entry.get("user_text", "") or entry.get("prompt", "")
            if not user_text:
                # Fallback: extract from raw line
                m = RE_USER_MSG.search(line)
                if m:
                    user_text = _unescape(m.group(1))

            if user_text and len(user_text) > 5:
                # Start a new session
                current = {
                    "instruction": user_text,
                    "input": "",
                    "output": "",
                    "timestamp": entry.get("timestamp", ""),
                    "brigade": entry.get("brigade", ""),
                }

            # Detect final response
            final: str = entry.get("final_response", "")
            if not final:
                m = RE_FINAL_RESP.search(line)
                if m:
                    final = _unescape(m.group(1))

            if final and current and not current["output"]:
                current["output"] = final
                if len(current["instruction"]) > 5 and len(final) > 20:
                    sessions.append(current)
                current = None

    return sessions


def filter_quality(samples: list[dict], min_output_len: int = 50) -> list[dict]:
    """Keep only samples with substantial outputs."""
    return [
        s for s in samples
        if len(s["output"]) >= min_output_len
        and not s["output"].startswith("⚠️")
        and not s["output"].startswith("Error")
    ]


def save_jsonl(samples: list[dict], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        for s in samples:
            f.write(json.dumps(s, ensure_ascii=False) + "\n")
    print(f"Saved {len(samples)} samples → {path}")


def show_stats(samples: list[dict]) -> None:
    if not samples:
        print("No samples found.")
        return
    avg_in = sum(len(s["instruction"]) for s in samples) / len(samples)
    avg_out = sum(len(s["output"]) for s in samples) / len(samples)
    brigades = {}
    for s in samples:
        b = s.get("brigade", "unknown")
        brigades[b] = brigades.get(b, 0) + 1
    print(f"  Total samples : {len(samples)}")
    print(f"  Avg prompt len: {avg_in:.0f} chars")
    print(f"  Avg output len: {avg_out:.0f} chars")
    print(f"  Brigades      : {brigades}")


# ─── Main ─────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description="Collect training data from bot logs")
    parser.add_argument("--log", default=str(DEFAULT_LOG), help="Path to bot log file")
    parser.add_argument("--out", default=str(DEFAULT_OUT), help="Output JSONL file")
    parser.add_argument("--min-len", type=int, default=50, help="Min output length")
    args = parser.parse_args()

    log_path = Path(args.log)
    out_path = Path(args.out)

    if not log_path.exists():
        print(f"ERROR: Log file not found: {log_path}", file=sys.stderr)
        sys.exit(1)

    print(f"Parsing {log_path} ...")
    raw = parse_log(log_path)
    print(f"Raw pairs found: {len(raw)}")

    filtered = filter_quality(raw, min_output_len=args.min_len)
    print(f"After quality filter: {len(filtered)}")

    if not filtered:
        print("\nNo training samples found yet.")
        print("Keep using the bot and run this script again in a few days.")
        print("Each conversation becomes a training example.")
        return

    show_stats(filtered)
    save_jsonl(filtered, out_path)
    print(f"\nNext step: run  python scripts/train_lora.py --dataset {out_path}")


if __name__ == "__main__":
    main()
