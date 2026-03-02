#!/usr/bin/env python3
"""Conversation pulse — heuristic detection of conversation anomalies.

Runs every 15m. Zero AI cost. Five detection algorithms:
  1. Bot unresponsive — human question with no bot reply within 5min
  2. Thought leak     — bot message matches thought_leak_patterns
  3. Consecutive msgs — bot sends ≥3 messages in 120s without human interleave
  4. Self evaluation   — bot message matches self_eval_patterns
  5. Abnormal silence  — no messages for too long (priority-dependent)

Usage:
    python3 sentinel/tasks/conversation_pulse.py --dry-run
"""

import json
import logging
import re
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

SENTINEL_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SENTINEL_ROOT))

from lib.conversation import fetch_messages, get_groups, init_bot_ids, is_bot
from lib.telegram import TelegramBridge

logger = logging.getLogger("sentinel.conversation_pulse")

# Silence thresholds (hours) by priority
SILENCE_HOURS = {"high": 6, "medium": 12, "low": 24}

# Cooldown between notifications for the same alert (seconds)
NOTIFY_COOLDOWN = 3600  # 1 hour


def _parse_timestamp(msg: dict) -> datetime | None:
    """Parse message timestamp from various formats."""
    ts = msg.get("timestamp") or msg.get("date")
    if ts is None:
        return None
    if isinstance(ts, (int, float)):
        return datetime.fromtimestamp(ts)
    try:
        return datetime.fromisoformat(str(ts).replace("Z", "+00:00").replace("+00:00", ""))
    except (ValueError, TypeError):
        return None


def _detect_unresponsive(messages: list[dict], config: dict) -> list[dict]:
    """P0: Last human message has a question mark, bot hasn't replied within timeout."""
    timeout_min = config.get("detection", {}).get("unresponsive_timeout_min", 5)
    issues = []
    now = datetime.now()

    # Find the last human message
    for msg in reversed(messages):
        if is_bot(msg):
            continue
        text = msg.get("text", "") or ""
        if "?" not in text and "？" not in text:
            break  # Last human message isn't a question
        msg_time = _parse_timestamp(msg)
        if msg_time is None:
            break
        elapsed_min = (now - msg_time).total_seconds() / 60

        if elapsed_min < timeout_min:
            break  # Not timed out yet

        # Check if bot replied after this message
        bot_replied = False
        for m2 in messages:
            t2 = _parse_timestamp(m2)
            if t2 and t2 > msg_time and is_bot(m2):
                bot_replied = True
                break

        if not bot_replied:
            issues.append({
                "type": "unresponsive",
                "severity": "P0",
                "detail": f"bot 無回應 ({int(elapsed_min)}分鐘)",
                "sender": msg.get("sender_name", "?"),
                "elapsed_min": int(elapsed_min),
            })
        break  # Only check the last human question

    return issues


def _detect_thought_leak(messages: list[dict], config: dict) -> list[dict]:
    """P0: Bot message contains thought chain leak patterns."""
    patterns = config.get("detection", {}).get("thought_leak_patterns", [])
    if not patterns:
        return []

    regex = re.compile("|".join(re.escape(p) for p in patterns))
    issues = []

    for msg in messages:
        if not is_bot(msg):
            continue
        text = msg.get("text", "") or ""
        match = regex.search(text)
        if match:
            snippet = text[:80].replace("\n", " ")
            issues.append({
                "type": "thought_leak",
                "severity": "P0",
                "detail": f"思維洩漏: 「{match.group()}」",
                "snippet": snippet,
                "message_id": msg.get("id"),
            })

    return issues


def _detect_consecutive(messages: list[dict], config: dict) -> list[dict]:
    """P1: Bot sends ≥N messages within window_sec without human interleave."""
    detection = config.get("detection", {})
    window_sec = detection.get("consecutive_msg_window_sec", 120)
    threshold = detection.get("consecutive_msg_threshold", 3)
    issues = []

    # Collect bot messages in chronological order
    bot_streak = []
    for msg in messages:
        if is_bot(msg):
            bot_streak.append(msg)
        else:
            # Human interleave — check if streak triggers
            if len(bot_streak) >= threshold:
                first_t = _parse_timestamp(bot_streak[0])
                last_t = _parse_timestamp(bot_streak[-1])
                if first_t and last_t and (last_t - first_t).total_seconds() <= window_sec:
                    issues.append({
                        "type": "consecutive_messages",
                        "severity": "P1",
                        "detail": f"bot 連發 {len(bot_streak)} 則 ({int((last_t - first_t).total_seconds())}s內)",
                        "count": len(bot_streak),
                    })
            bot_streak = []

    # Check trailing streak
    if len(bot_streak) >= threshold:
        first_t = _parse_timestamp(bot_streak[0])
        last_t = _parse_timestamp(bot_streak[-1])
        if first_t and last_t and (last_t - first_t).total_seconds() <= window_sec:
            issues.append({
                "type": "consecutive_messages",
                "severity": "P1",
                "detail": f"bot 連發 {len(bot_streak)} 則 ({int((last_t - first_t).total_seconds())}s內)",
                "count": len(bot_streak),
            })

    return issues


def _detect_self_eval(messages: list[dict], config: dict) -> list[dict]:
    """P1: Bot message contains self-evaluation patterns."""
    patterns = config.get("detection", {}).get("self_eval_patterns", [])
    if not patterns:
        return []

    regex = re.compile("|".join(re.escape(p) for p in patterns))
    issues = []

    for msg in messages:
        if not is_bot(msg):
            continue
        text = msg.get("text", "") or ""
        match = regex.search(text)
        if match:
            issues.append({
                "type": "self_evaluation",
                "severity": "P1",
                "detail": f"自我評價: 「{match.group()}」",
                "message_id": msg.get("id"),
            })

    return issues


def _detect_silence(messages: list[dict], group: dict, config: dict) -> list[dict]:
    """P2: No messages for longer than priority-based threshold."""
    priority = group.get("priority", "low")
    threshold_hours = SILENCE_HOURS.get(priority, 24)
    issues = []
    now = datetime.now()

    if not messages:
        issues.append({
            "type": "abnormal_silence",
            "severity": "P2",
            "detail": f"異常靜默: 無法取得訊息",
        })
        return issues

    # Find the most recent message timestamp
    latest = None
    for msg in messages:
        t = _parse_timestamp(msg)
        if t and (latest is None or t > latest):
            latest = t

    if latest:
        hours_silent = (now - latest).total_seconds() / 3600
        if hours_silent > threshold_hours:
            issues.append({
                "type": "abnormal_silence",
                "severity": "P2",
                "detail": f"異常靜默: {hours_silent:.1f}h (閾值 {threshold_hours}h)",
                "hours_silent": round(hours_silent, 1),
            })

    return issues


def _should_notify(alert_key: str, known_alerts: dict, now: datetime) -> bool:
    """Check if we should send a notification (1-hour cooldown dedup)."""
    entry = known_alerts.get(alert_key)
    if not entry:
        return True
    last_notified = entry.get("last_notified")
    if not last_notified:
        return True
    try:
        last_dt = datetime.fromisoformat(last_notified)
        return (now - last_dt).total_seconds() >= NOTIFY_COOLDOWN
    except (ValueError, TypeError):
        return True


def _update_known_alerts(known_alerts: dict, current_keys: set, now: datetime):
    """Update known_alerts: add new, increment existing, remove resolved."""
    # Remove alerts no longer present
    stale = [k for k in known_alerts if k not in current_keys]
    for k in stale:
        del known_alerts[k]


def _load_scan_config() -> dict:
    """Load config.json (groups, bridges, detection patterns)."""
    cfg_path = SENTINEL_ROOT / "config.json"
    with open(cfg_path) as f:
        return json.load(f)


def run(config: dict, state: dict) -> dict:
    """Main entry point called by sentinel.py.

    Note: `config` is sentinel.yaml. Groups/bridges live in config.json.
    """
    logger.info("=== conversation_pulse: start ===")

    scan_cfg = _load_scan_config()
    init_bot_ids(scan_cfg)
    groups = get_groups(scan_cfg)

    # State for dedup
    sentinel = state.setdefault("sentinel", {})
    pulse_state = sentinel.setdefault("conversation_pulse", {})
    known_alerts = pulse_state.setdefault("known_alerts", {})

    # Notification bridge
    notify_url = config.get("notifications", {}).get(
        "telegram_bridge", "http://localhost:18790"
    )
    cruz_id = config.get("notifications", {}).get("cruz_chat_id", "448345880")
    telegram = TelegramBridge(bridge_url=notify_url)

    now = datetime.now()
    result = {
        "groups_scanned": 0,
        "messages_analyzed": 0,
        "alerts_sent": 0,
        "issues": [],
    }
    current_alert_keys: set = set()

    for chat_id, group in groups.items():
        messages = fetch_messages(group["bridge_url"], chat_id, limit=30)
        # Sort chronologically (API may return newest-first)
        messages.sort(key=lambda m: m.get("timestamp") or m.get("date") or 0)
        result["groups_scanned"] += 1
        result["messages_analyzed"] += len(messages)

        # Run all detectors (scan_cfg has detection patterns)
        issues = []
        issues.extend(_detect_unresponsive(messages, scan_cfg))
        issues.extend(_detect_thought_leak(messages, scan_cfg))
        issues.extend(_detect_consecutive(messages, scan_cfg))
        issues.extend(_detect_self_eval(messages, scan_cfg))
        issues.extend(_detect_silence(messages, group, scan_cfg))

        for issue in issues:
            issue["chat_id"] = chat_id
            issue["chat_name"] = group["name"]
            result["issues"].append(issue)

            alert_key = f"{chat_id}:{issue['type']}"
            current_alert_keys.add(alert_key)

            if _should_notify(alert_key, known_alerts, now):
                # Send notification
                sev = issue["severity"]
                msg = (
                    f"[Sentinel 對話脈搏] {sev} {group['name']}: "
                    f"{issue['detail']}"
                )
                resp = telegram.send(msg, cruz_id)
                if resp.get("ok") or resp.get("error") is None:
                    result["alerts_sent"] += 1
                    logger.info("Notified: %s", msg)
                else:
                    logger.warning("Notify failed: %s", resp)

                # Update known_alerts
                if alert_key not in known_alerts:
                    known_alerts[alert_key] = {
                        "first_seen": now.isoformat(),
                        "last_notified": now.isoformat(),
                        "count": 1,
                    }
                else:
                    known_alerts[alert_key]["last_notified"] = now.isoformat()
                    known_alerts[alert_key]["count"] = known_alerts[alert_key].get("count", 0) + 1
            else:
                logger.debug("Deduped alert: %s", alert_key)

    # Clean up resolved alerts
    _update_known_alerts(known_alerts, current_alert_keys, now)

    # Store summary
    pulse_state["last_run"] = now.isoformat()
    pulse_state["last_result"] = {
        "groups_scanned": result["groups_scanned"],
        "messages_analyzed": result["messages_analyzed"],
        "alerts_sent": result["alerts_sent"],
        "issue_count": len(result["issues"]),
        "issues": [
            {"chat_name": i["chat_name"], "type": i["type"],
             "severity": i["severity"], "detail": i["detail"]}
            for i in result["issues"][:10]
        ],
    }

    logger.info("=== conversation_pulse: done — %d groups, %d issues, %d alerts ===",
                result["groups_scanned"], len(result["issues"]), result["alerts_sent"])
    return result


# ---------------------------------------------------------------------------
# Standalone
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import argparse

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")

    parser = argparse.ArgumentParser(description="Conversation pulse (standalone)")
    parser.add_argument("--dry-run", action="store_true", help="Detect issues without sending notifications")
    parser.add_argument("--config", default=str(SENTINEL_ROOT / "config.json"))
    args = parser.parse_args()

    with open(args.config) as f:
        cfg = json.load(f)

    state_path = SENTINEL_ROOT / "state.json"
    st = {}
    if state_path.exists():
        with open(state_path) as f:
            st = json.load(f)

    if args.dry_run:
        # Dry run: detect but don't notify
        init_bot_ids(cfg)
        groups = get_groups(cfg)
        total_issues = 0
        for chat_id, group in groups.items():
            messages = fetch_messages(group["bridge_url"], chat_id, limit=30)
            messages.sort(key=lambda m: m.get("timestamp") or m.get("date") or 0)
            issues = []
            issues.extend(_detect_unresponsive(messages, cfg))
            issues.extend(_detect_thought_leak(messages, cfg))
            issues.extend(_detect_consecutive(messages, cfg))
            issues.extend(_detect_self_eval(messages, cfg))
            issues.extend(_detect_silence(messages, group, cfg))

            if issues:
                print(f"\n{group['name']} ({chat_id}):")
                for issue in issues:
                    print(f"  [{issue['severity']}] {issue['type']}: {issue['detail']}")
                total_issues += len(issues)
            else:
                print(f"  {group['name']}: OK")

        print(f"\n[dry-run] Total: {total_issues} issues across {len(groups)} groups")
    else:
        result = run(cfg, st)
        # Save state
        with open(state_path, "w") as f:
            json.dump(st, f, indent=2, ensure_ascii=False)
        print(json.dumps(result, indent=2, ensure_ascii=False))
