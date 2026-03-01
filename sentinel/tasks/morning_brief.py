#!/usr/bin/env python3
"""Layer 2: Morning Brief — daily 07:00, Haiku (~$0.01/day).

Generates a concise morning briefing from yesterday's digest,
bulletin alerts, P0/P1 tasks, and weather. Sends via Telegram to Cruz.
"""
import argparse
import re
import sys
import urllib.request
import urllib.error
from datetime import datetime, timedelta
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
WORKSPACE = BASE.parent / "workspace"
sys.path.insert(0, str(BASE))

from lib.logging_util import setup_logger, log_event
from lib.telegram import TelegramBridge
from lib.claude import ClaudeClient

logger = setup_logger("sentinel.morning_brief")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _read_file_safe(path):
    """Read a file, return its text or None if missing/unreadable."""
    try:
        return Path(path).read_text(encoding="utf-8")
    except (FileNotFoundError, PermissionError, OSError):
        return None


def _find_yesterday_digest():
    """Locate the most recent cross-digest file (yesterday first)."""
    yesterday = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")
    day_before = (datetime.now() - timedelta(days=2)).strftime("%Y-%m-%d")

    for date_str in (yesterday, day_before):
        path = WORKSPACE / f"bita-digest-{date_str}.md"
        if path.exists():
            return path.read_text(encoding="utf-8"), date_str
    return None, yesterday


def _extract_bulletin_alerts(text):
    """Extract lines containing alert-related keywords from bulletin text."""
    if not text:
        return "no alerts"
    keywords = re.compile(r"ALERT|警告|P0|P1", re.IGNORECASE)
    lines = [ln.strip() for ln in text.splitlines() if keywords.search(ln)]
    return "\n".join(lines) if lines else "no alerts"


def _parse_priority_tasks(text):
    """Extract [P0] and [P1] tasks from TASKS.md content."""
    if not text:
        return "no tasks"
    pattern = re.compile(r"^.*\[P[01]\].*$", re.MULTILINE)
    matches = pattern.findall(text)
    return "\n".join(m.strip() for m in matches) if matches else "no P0/P1 tasks"


def _fetch_weather():
    """Fetch Taipei weather from wttr.in. Returns fallback on failure."""
    try:
        req = urllib.request.Request(
            "https://wttr.in/Taipei?format=3",
            headers={"User-Agent": "sentinel/1.0"},
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.read().decode("utf-8").strip()
    except Exception:
        return "天氣資料暫無"


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def run(config, state):
    """Generate and send morning brief. Called by sentinel.py scheduler."""
    today = datetime.now().strftime("%Y-%m-%d")
    logger.info(f"Morning brief starting for {today}")

    # 1. Yesterday's digest
    digest_text, digest_date = _find_yesterday_digest()
    if digest_text:
        logger.info(f"Using digest from {digest_date}")
    else:
        digest_text = "no digest available"
        logger.info("No digest found")

    # 2. Bulletin alerts
    bulletin_raw = _read_file_safe(WORKSPACE / "BULLETIN.md")
    bulletin_alerts = _extract_bulletin_alerts(bulletin_raw)

    # 3. P0/P1 tasks
    tasks_raw = _read_file_safe(WORKSPACE / "TASKS.md")
    priority_tasks = _parse_priority_tasks(tasks_raw)

    # 4. Weather
    weather = _fetch_weather()
    logger.info(f"Weather: {weather}")

    # 5. Generate brief via Claude Haiku
    ai_model = config.get("tasks", {}).get("morning_brief", {}).get(
        "ai_model", "claude-haiku-4-5-20251001"
    )
    max_calls = config.get("claude", {}).get("max_daily_calls", 20)
    claude = ClaudeClient(max_daily_calls=max_calls)

    brief = claude.morning_brief(
        digest=digest_text,
        bulletin=bulletin_alerts,
        tasks=priority_tasks,
        weather=weather,
        model=ai_model,
    )
    logger.info(f"Brief generated, {len(brief)} chars")

    # 6. Send via Telegram
    sent = False
    bridge_url = config.get("notifications", {}).get(
        "telegram_bridge", "http://localhost:18790"
    )
    chat_id = config.get("notifications", {}).get("cruz_chat_id", "448345880")
    tg = TelegramBridge(bridge_url)

    header = f"[Sentinel] Morning Brief {today}"
    message = f"{header}\n\n{brief}"

    try:
        result = tg.send(message, chat_id)
        sent = result.get("ok", False) if isinstance(result, dict) else False
        if sent:
            logger.info("Brief sent to Cruz")
        else:
            logger.warning(f"Telegram send returned: {result}")
    except Exception as e:
        logger.error(f"Telegram send failed: {e}")

    # 7. Save to memory
    memory_dir = WORKSPACE / "memory"
    memory_dir.mkdir(exist_ok=True)
    save_path = memory_dir / f"morning-brief-{today}.md"
    save_path.write_text(
        f"# Morning Brief {today}\n\n{brief}\n", encoding="utf-8"
    )
    logger.info(f"Brief saved to {save_path}")

    log_event(logger, "morning_brief_done", "morning_brief",
              f"len={len(brief)} sent={sent}")

    return {"status": "ok", "brief_length": len(brief), "sent": sent}


# ---------------------------------------------------------------------------
# Standalone
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Layer 2: Morning Brief")
    parser.add_argument("--dry-run", action="store_true",
                        help="Generate brief but don't send or save")
    args = parser.parse_args()

    # Minimal config for standalone
    standalone_config = {
        "tasks": {"morning_brief": {"ai_model": "claude-haiku-4-5-20251001"}},
        "claude": {"max_daily_calls": 20},
        "notifications": {
            "telegram_bridge": "http://localhost:18790",
            "cruz_chat_id": "448345880",
        },
    }

    if args.dry_run:
        print("=== DRY RUN: Morning Brief ===")
        digest_text, digest_date = _find_yesterday_digest()
        bulletin_raw = _read_file_safe(WORKSPACE / "BULLETIN.md")
        tasks_raw = _read_file_safe(WORKSPACE / "TASKS.md")
        weather = _fetch_weather()

        print(f"Digest ({digest_date}): {'found' if digest_text else 'missing'}")
        print(f"Bulletin alerts: {_extract_bulletin_alerts(bulletin_raw)[:100]}")
        print(f"Priority tasks: {_parse_priority_tasks(tasks_raw)[:100]}")
        print(f"Weather: {weather}")
        print("=== Would call Claude Haiku and send via Telegram ===")
    else:
        result = run(standalone_config, {"sentinel": {}})
        print(f"Result: {result}")
