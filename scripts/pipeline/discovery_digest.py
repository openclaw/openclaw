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
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
KST = timezone(timedelta(hours=9))

REPORTS_DIR = Path.home() / ".openclaw" / "workspace" / "reports" / "ideas"
STATE_PATH = REPORTS_DIR / "discovery_digest_state.json"

TELEGRAM_BOT_TOKEN = "8554125313:AAGC5Zzb9nCbPYgmOVqs3pVn-qzIA2oOtkI"
TELEGRAM_CHAT_ID = "492860021"
TELEGRAM_API = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"

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
def find_scored_file() -> Path | None:
    """Return today's scored file, falling back to yesterday's."""
    for date_str in (today_str(), yesterday_str()):
        path = REPORTS_DIR / f"scored_discoveries_{date_str}.jsonl"
        if path.exists():
            return path
    return None


def load_discoveries(path: Path, min_score: int) -> list[dict]:
    """Load discoveries with score >= min_score from a JSONL file."""
    results = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        score = item.get("relevance_score", 0)
        if score >= min_score:
            results.append(item)
    # Sort by score descending, then by title
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
# Telegram sending
# ---------------------------------------------------------------------------
def send_telegram(text: str) -> bool:
    """Send message via Telegram Bot API. Returns True on success."""
    payload = json.dumps({
        "chat_id": TELEGRAM_CHAT_ID,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    }).encode("utf-8")

    req = urllib.request.Request(
        TELEGRAM_API,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            body = json.loads(resp.read().decode("utf-8"))
            return body.get("ok", False)
    except (urllib.error.URLError, urllib.error.HTTPError, OSError) as exc:
        print(f"[ERROR] Telegram send failed: {exc}", file=sys.stderr)
        return False


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

    # Find scored file
    scored_file = find_scored_file()
    if scored_file is None:
        print("No scored_discoveries file found for today or yesterday")
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
    ok = send_telegram(message)
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
