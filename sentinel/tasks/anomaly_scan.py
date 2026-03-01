#!/usr/bin/env python3
"""Layer 3: Anomaly Scan — every 4 hours, conditional AI (~$0.03/day max).

Scans recently modified files across agent workspaces for error patterns.
Only invokes Claude Haiku when the heuristic score exceeds a threshold,
keeping API costs near zero on quiet days.
"""
import argparse
import os
import re
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
WORKSPACE = BASE.parent / "workspace"
sys.path.insert(0, str(BASE))

from lib.logging_util import setup_logger, log_event
from lib.telegram import TelegramBridge
from lib.claude import ClaudeClient

logger = setup_logger("sentinel.anomaly_scan")

# ---------------------------------------------------------------------------
# Pattern weights — higher = more severe
# ---------------------------------------------------------------------------

PATTERNS = {
    "ERROR": 3,
    "error": 2,
    "429": 3,
    "timeout": 2,
    "VIP": 2,
    "客訴": 3,
    "P0": 4,
    "P1": 2,
    "crash": 4,
    "踩坑": 2,
    "failed": 2,
    "失敗": 2,
    "異常": 2,
    "DOWN": 3,
    "unreachable": 3,
}

# Compile patterns once
_COMPILED = {re.compile(re.escape(pat)): weight for pat, weight in PATTERNS.items()}

# Directories to scan
SCAN_DIRS = [
    WORKSPACE / "agents" / "*" / "memory",
    WORKSPACE / "memory",
    WORKSPACE / "meihui",
    BASE / "logs",
]

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _expand_scan_dirs():
    """Expand globs in SCAN_DIRS and return existing directories."""
    dirs = []
    for pattern in SCAN_DIRS:
        pattern_str = str(pattern)
        if "*" in pattern_str:
            parent = Path(pattern_str.split("*")[0])
            if parent.exists():
                for d in parent.iterdir():
                    if d.is_dir():
                        suffix = pattern_str.split("*", 1)[1]
                        candidate = d / suffix.lstrip("/")
                        if candidate.exists() and candidate.is_dir():
                            dirs.append(candidate)
        else:
            if pattern.exists() and pattern.is_dir():
                dirs.append(pattern)
    return dirs


def _find_recent_files(dirs, hours=4):
    """Find files modified within the last N hours."""
    cutoff = datetime.now() - timedelta(hours=hours)
    cutoff_ts = cutoff.timestamp()
    recent = []
    for d in dirs:
        try:
            for entry in d.iterdir():
                if entry.is_file() and entry.suffix in (".md", ".txt", ".log", ".json"):
                    try:
                        if os.path.getmtime(entry) >= cutoff_ts:
                            recent.append(entry)
                    except OSError:
                        pass
        except PermissionError:
            logger.warning(f"Permission denied: {d}")
    return recent


def _score_file(filepath):
    """Read file and compute heuristic score from pattern matches.
    Returns (score, matched_patterns, excerpt).
    """
    try:
        text = filepath.read_text(encoding="utf-8", errors="replace")
    except (OSError, PermissionError):
        return 0, [], ""

    matched = {}
    for regex, weight in _COMPILED.items():
        if regex.search(text):
            matched[regex.pattern.replace("\\", "")] = weight

    score = sum(matched.values())

    # Build excerpt: lines containing matched patterns (first 20 lines max)
    excerpt_lines = []
    if matched:
        for line in text.splitlines():
            for regex in _COMPILED:
                if regex.search(line):
                    excerpt_lines.append(line.strip()[:200])
                    break
            if len(excerpt_lines) >= 20:
                break

    return score, list(matched.keys()), "\n".join(excerpt_lines)


def _is_quiet_hours(config):
    """Check if current time is within quiet hours."""
    qh = config.get("notifications", {}).get("quiet_hours", [])
    if len(qh) != 2:
        return False
    now = datetime.now().strftime("%H:%M")
    return qh[0] <= now < qh[1]


def _bulletin_alert(msg):
    """Write an alert to the shared bulletin board."""
    bulletin_script = WORKSPACE / "scripts" / "bulletin"
    try:
        subprocess.run(
            ["python3", str(bulletin_script), "alert", msg],
            timeout=10,
            capture_output=True,
        )
    except Exception as e:
        logger.error(f"Bulletin alert failed: {e}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def run(config, state):
    """Scan for anomalies. Called by sentinel.py scheduler."""
    logger.info("Anomaly scan starting")

    # Config
    threshold = config.get("tasks", {}).get("anomaly_scan", {}).get("ai_threshold", 3)
    bridge_url = config.get("notifications", {}).get(
        "telegram_bridge", "http://localhost:18790"
    )
    chat_id = config.get("notifications", {}).get("cruz_chat_id", "448345880")
    max_calls = config.get("claude", {}).get("max_daily_calls", 20)

    # 1. Find recently modified files
    dirs = _expand_scan_dirs()
    recent_files = _find_recent_files(dirs, hours=4)
    logger.info(f"Found {len(recent_files)} recently modified files in {len(dirs)} dirs")

    # 2. Score each file
    total_score = 0
    flagged = []  # (path, score, patterns, excerpt)
    for fpath in recent_files:
        score, patterns, excerpt = _score_file(fpath)
        if score > 0:
            flagged.append((fpath, score, patterns, excerpt))
            total_score += score

    logger.info(f"Total heuristic score: {total_score} (threshold: {threshold})")

    ai_called = False
    severity = None
    alerts_sent = 0

    # 3. Conditional AI analysis
    if total_score >= threshold and flagged:
        ai_called = True
        logger.info(f"Score {total_score} >= {threshold}, invoking Claude Haiku")

        # Build context for AI
        context_parts = []
        for fpath, score, patterns, excerpt in flagged:
            context_parts.append(
                f"File: {fpath.name} (score={score}, patterns={patterns})\n"
                f"{excerpt[:500]}"
            )
        context = "\n---\n".join(context_parts)[:3000]

        prompt = (
            "你是無極系統的異常分析師。以下是最近 4 小時內偵測到的異常模式。\n"
            "請判斷嚴重程度：P0（立即處理）、P1（今天處理）、P2（本週處理）、P3（觀察）。\n"
            "回覆格式：第一行只寫 P0/P1/P2/P3，第二行起簡述原因和建議行動（100字內）。"
        )

        try:
            claude = ClaudeClient(max_daily_calls=max_calls)
            ai_model = config.get("tasks", {}).get("anomaly_scan", {}).get(
                "ai_model", "claude-haiku-4-5-20251001"
            )
            response = claude.analyze(prompt, context=context, model=ai_model)
            logger.info(f"AI response: {response[:200]}")

            # Parse severity from first line
            first_line = response.strip().splitlines()[0].strip().upper()
            for sev in ("P0", "P1", "P2", "P3"):
                if sev in first_line:
                    severity = sev
                    break
            if not severity:
                severity = "P2"  # Default if parsing fails

            logger.info(f"Assessed severity: {severity}")

            # P0 or P1 → bulletin alert + Telegram notification
            if severity in ("P0", "P1"):
                alert_msg = f"[Sentinel Anomaly {severity}] score={total_score}\n{response[:300]}"
                _bulletin_alert(alert_msg)

                # Quiet hours: skip Telegram for P1, always send for P0
                quiet = _is_quiet_hours(config)
                if severity == "P0" or not quiet:
                    tg = TelegramBridge(bridge_url)
                    tg.send(alert_msg, chat_id)
                    alerts_sent += 1
                    logger.info(f"Alert sent to Cruz ({severity})")
                else:
                    logger.info(f"Quiet hours — skipping Telegram for {severity}")

        except Exception as e:
            logger.error(f"AI analysis failed: {e}")
            severity = None
    else:
        logger.info("No anomalies detected, zero API calls")

    # 5. Track in state
    state.setdefault("sentinel", {})
    history = state["sentinel"].setdefault("anomaly_history", [])
    history.append({
        "ts": datetime.now().isoformat(),
        "files_scanned": len(recent_files),
        "score": total_score,
        "ai_called": ai_called,
        "severity": severity,
    })
    # Keep only last 50 entries
    if len(history) > 50:
        state["sentinel"]["anomaly_history"] = history[-50:]

    log_event(
        logger, "anomaly_scan_done", "anomaly_scan",
        f"files={len(recent_files)} score={total_score} ai={ai_called} sev={severity}",
    )

    return {
        "files_scanned": len(recent_files),
        "total_score": total_score,
        "ai_called": ai_called,
        "alerts_sent": alerts_sent,
    }


# ---------------------------------------------------------------------------
# Standalone
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Layer 3: Anomaly Scan")
    parser.add_argument("--dry-run", action="store_true",
                        help="Scan and score but skip AI and notifications")
    args = parser.parse_args()

    standalone_config = {
        "tasks": {"anomaly_scan": {"ai_threshold": 3}},
        "claude": {"max_daily_calls": 20},
        "notifications": {
            "telegram_bridge": "http://localhost:18790",
            "cruz_chat_id": "448345880",
            "quiet_hours": ["00:00", "06:00"],
        },
    }

    if args.dry_run:
        print("=== DRY RUN: Anomaly Scan ===")
        dirs = _expand_scan_dirs()
        recent_files = _find_recent_files(dirs, hours=4)
        print(f"Scan dirs: {len(dirs)}")
        print(f"Recent files: {len(recent_files)}")

        total = 0
        for fpath in recent_files:
            score, patterns, _ = _score_file(fpath)
            if score > 0:
                print(f"  {fpath.name}: score={score} patterns={patterns}")
                total += score

        threshold = standalone_config["tasks"]["anomaly_scan"]["ai_threshold"]
        print(f"\nTotal score: {total} (threshold: {threshold})")
        if total >= threshold:
            print(">>> Would invoke Claude Haiku for severity assessment")
        else:
            print(">>> Below threshold — zero API calls")
        print("=== DRY RUN complete ===")
    else:
        result = run(standalone_config, {"sentinel": {}})
        print(f"Result: {result}")
