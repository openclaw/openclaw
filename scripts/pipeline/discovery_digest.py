#!/usr/bin/env python3
"""Send high-quality discovery digest via Telegram DM.

Reads scored discoveries (score >= 7), filters out already-notified URLs,
and sends a formatted digest to Ron's Telegram. Zero LLM calls, $0 cost.

Usage:
    python3 discovery_digest.py              # send digest
    python3 discovery_digest.py --dry-run    # print to stdout only
    python3 discovery_digest.py --min-score 8  # override threshold
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from shared.telegram import send_dm

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
KST = timezone(timedelta(hours=9))

FILTERED_DIR = Path.home() / ".openclaw" / "workspace" / "memory" / "filtered-ideas"
STATE_PATH = FILTERED_DIR / "discovery_digest_state.json"

MAX_ITEMS = 10
MAX_MESSAGE_LEN = 4090

DEFAULT_MIN_SCORE = 7

SOURCE_PREFIX = {
    "github": "[GH]",
    "hackernews": "[HN]",
    "arxiv": "[arXiv]",
    "x": "[X]",
    "twitter": "[X]",
    "zettelkasten": "[ZK]",
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def now_kst() -> datetime:
    return datetime.now(KST)


def today_str() -> str:
    return now_kst().strftime("%Y%m%d")


def yesterday_str() -> str:
    return (now_kst() - timedelta(days=1)).strftime("%Y%m%d")


def source_tag(source: str) -> str:
    return SOURCE_PREFIX.get(source.lower(), "[?]")


# ---------------------------------------------------------------------------
# State management
# ---------------------------------------------------------------------------
def load_state() -> dict:
    if STATE_PATH.exists():
        try:
            return json.loads(STATE_PATH.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            pass
    return {"notified_urls": [], "last_run": None, "last_count": 0}


def save_state(state: dict) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    STATE_PATH.write_text(
        json.dumps(state, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


# ---------------------------------------------------------------------------
# Discovery loading
# ---------------------------------------------------------------------------
def find_filtered_file() -> Path | None:
    """Return the most recent filtered file from today or yesterday."""
    today = now_kst().strftime("%Y-%m-%d")
    yesterday = (now_kst() - timedelta(days=1)).strftime("%Y-%m-%d")
    candidates = sorted(FILTERED_DIR.glob("filtered_*.json"), reverse=True)
    for path in candidates:
        name = path.stem  # e.g. filtered_2026-02-28_0907
        if name.startswith(f"filtered_{today}") or name.startswith(f"filtered_{yesterday}"):
            return path
    return None


def load_discoveries(path: Path, min_score: int) -> list[dict]:
    """Load discoveries with score >= min_score from a filtered JSON file."""
    try:
        items = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return []
    if not isinstance(items, list):
        return []
    results = []
    for item in items:
        score = item.get("score", item.get("relevance_score", 0))
        if score >= min_score:
            # Normalize fields for formatting
            item["relevance_score"] = score
            if not item.get("title"):
                text = item.get("text", "")
                first_line = text.strip().split("\n")[0].lstrip("# ").strip()
                item["title"] = first_line[:80] if first_line else "untitled"
            if not item.get("url"):
                item["url"] = item.get("file", "")
            if not item.get("relevance_reason"):
                item["relevance_reason"] = item.get("reason", "")
            results.append(item)
    results.sort(key=lambda x: (-x.get("relevance_score", 0), x.get("title", "")))
    return results


# ---------------------------------------------------------------------------
# Message formatting
# ---------------------------------------------------------------------------
def format_message(discoveries: list[dict]) -> str:
    """Format discoveries into a Telegram-friendly message."""
    ts = now_kst()
    header = f"[Discovery Digest] {ts.strftime('%m/%d %H:%M')} ({len(discoveries)}\uac74)\n"

    lines = [header]
    for i, item in enumerate(discoveries, 1):
        tag = source_tag(item.get("source", ""))
        score = item.get("relevance_score", 0)
        title = item.get("title", "untitled")
        # Use relevance_reason as summary, fall back to summary field
        reason = item.get("relevance_reason", "") or item.get("summary", "")
        url = item.get("url", "")

        entry = f"{i}. {tag} {score}/10 {title}\n   {reason}\n   {url}"
        lines.append(entry)

    msg = "\n\n".join(lines)

    # Truncate if exceeding Telegram limit
    if len(msg) > MAX_MESSAGE_LEN:
        msg = msg[: MAX_MESSAGE_LEN - 3] + "..."

    return msg


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> None:
    parser = argparse.ArgumentParser(
        description="Send high-quality discovery digest via Telegram DM",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print message to stdout instead of sending",
    )
    parser.add_argument(
        "--min-score",
        type=int,
        default=DEFAULT_MIN_SCORE,
        help=f"Minimum relevance score (default: {DEFAULT_MIN_SCORE})",
    )
    args = parser.parse_args()

    # Find filtered file
    scored_file = find_filtered_file()
    if scored_file is None:
        print("No filtered discoveries file found for today or yesterday")
        return

    # Load discoveries
    all_discoveries = load_discoveries(scored_file, args.min_score)
    if not all_discoveries:
        print("No new discoveries above threshold")
        return

    # Filter out already-notified URLs
    state = load_state()
    notified_urls = set(state.get("notified_urls", []))
    new_discoveries = [
        d for d in all_discoveries if d.get("url") not in notified_urls
    ]

    if not new_discoveries:
        print("No new discoveries (all already notified)")
        return

    # Cap at MAX_ITEMS
    batch = new_discoveries[:MAX_ITEMS]

    # Format message
    message = format_message(batch)

    if args.dry_run:
        print(message)
        print(f"\n--- dry-run: {len(batch)} discoveries would be sent ---")
        return

    # Send
    ok = send_dm(message)
    if not ok:
        print("[ERROR] Failed to send Telegram message", file=sys.stderr)
        sys.exit(1)

    # Update state only on success
    batch_urls = [d.get("url") for d in batch if d.get("url")]
    state["notified_urls"] = list(notified_urls | set(batch_urls))
    state["last_run"] = now_kst().isoformat()
    state["last_count"] = len(batch)
    save_state(state)

    print(f"Sent {len(batch)} discoveries")


if __name__ == "__main__":
    main()
