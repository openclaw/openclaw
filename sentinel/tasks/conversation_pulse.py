#!/usr/bin/env python3
"""Conversation pulse — heuristic detection of conversation anomalies.

Runs every 15m. Zero AI cost. Seven detection algorithms:
  1. Bot unresponsive — human question with no bot reply within 5min
  2. Thought leak     — bot message matches thought_leak_patterns
  3. Consecutive msgs — bot sends ≥3 messages in 120s without human interleave
  4. Self evaluation   — bot message matches self_eval_patterns
  5. Work avoidance   — bot offers menus/delegates instead of executing
  6. Stuck loop       — bot sends 5+ msgs in 3min with repeated patterns
  7. Abnormal silence  — no messages for too long (priority-dependent)
     Bridge-aware: pre-checks bridge health; if bridge is down, emits
     bridge_down (P1) instead of abnormal_silence (P2). N groups on
     the same dead bridge are merged into 1 alert.

Usage:
    python3 sentinel/tasks/conversation_pulse.py --dry-run
"""

import json
import logging
import re
import sys
import time
import urllib.request
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

# Auto-repair cooldown per chat (seconds)
REPAIR_COOLDOWN = 900  # 15 minutes — avoid spamming the gateway

# Stuck-loop detection: bot sends 5+ messages in 3min with 2+ distinct "讓我" variants
STUCK_LOOP_MSG_THRESHOLD = 5
STUCK_LOOP_WINDOW_SEC = 180
STUCK_LOOP_PATTERN_THRESHOLD = 2


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


def _detect_work_avoidance(messages: list[dict], config: dict) -> list[dict]:
    """P1: Bot message shows work avoidance — offering menus / delegating instead of executing."""
    detection = config.get("detection", {})
    avoidance_patterns = detection.get("work_avoidance_patterns", [])
    menu_patterns = detection.get("menu_patterns", [])
    all_patterns = avoidance_patterns + menu_patterns
    if not all_patterns:
        return []

    regex = re.compile("|".join(re.escape(p) for p in all_patterns))
    issues = []

    for msg in messages:
        if not is_bot(msg):
            continue
        text = msg.get("text", "") or ""
        match = regex.search(text)
        if match:
            snippet = text[:80].replace("\n", " ")
            issues.append({
                "type": "work_avoidance",
                "severity": "P1",
                "detail": f"逃避工作: 「{match.group()}」",
                "snippet": snippet,
                "message_id": msg.get("id"),
            })

    return issues


def _detect_stuck_loop(messages: list[dict], config: dict) -> list[dict]:
    """P0: Bot stuck in tool/thought loop — 5+ messages in 3min with 2+ distinct '讓我' variants."""
    issues = []
    let_me_re = re.compile(r"讓我\S{1,6}")  # e.g. 讓我檢查, 讓我搜索, 讓我查看, etc.

    bot_burst = []
    for msg in messages:
        if is_bot(msg):
            bot_burst.append(msg)
        else:
            bot_burst = []

    # Check trailing bot burst (most recent consecutive bot messages)
    if len(bot_burst) < STUCK_LOOP_MSG_THRESHOLD:
        return issues

    first_t = _parse_timestamp(bot_burst[0])
    last_t = _parse_timestamp(bot_burst[-1])
    if not first_t or not last_t:
        return issues

    window = (last_t - first_t).total_seconds()
    if window > STUCK_LOOP_WINDOW_SEC:
        return issues

    # Count distinct "讓我X" patterns
    variants = set()
    for msg in bot_burst:
        text = msg.get("text", "") or ""
        for m in let_me_re.finditer(text):
            variants.add(m.group())

    if len(variants) >= STUCK_LOOP_PATTERN_THRESHOLD:
        issues.append({
            "type": "stuck_loop",
            "severity": "P0",
            "detail": f"agent 卡死循環: {len(bot_burst)} 則連發, {len(variants)} 種「讓我」 ({int(window)}s內)",
            "count": len(bot_burst),
            "variants": list(variants)[:5],
        })

    return issues


def _auto_repair(issue: dict, group: dict, chat_id: str, pulse_state: dict,
                 telegram: TelegramBridge, cruz_id: str, now: datetime):
    """Attempt auto-repair for P0 issues by sending corrective message to the group."""
    repair_state = pulse_state.setdefault("auto_repairs", {})
    repair_key = f"{chat_id}:{issue['type']}"

    # Cooldown check
    last_repair = repair_state.get(repair_key)
    if last_repair:
        try:
            elapsed = (now - datetime.fromisoformat(last_repair)).total_seconds()
            if elapsed < REPAIR_COOLDOWN:
                return
        except (ValueError, TypeError):
            pass

    agent_id = group.get("agent_id")
    issue_type = issue["type"]
    bridge_url = group.get("bridge_url", "http://localhost:18790")

    # Build corrective message based on issue type
    if issue_type == "thought_leak":
        repair_msg = (
            f"@x01clawbot 停止。不要洩漏思考過程。"
            f"直接回覆用戶的問題，不要說「讓我」開頭的句子。"
        )
    elif issue_type == "stuck_loop":
        repair_msg = (
            f"@x01clawbot 停止嘗試。你目前的方法不可行。"
            f"直接告訴用戶你無法完成此操作，並建議替代方案。"
        )
    elif issue_type == "consecutive_messages":
        repair_msg = (
            f"@x01clawbot 停止連發。把你的回覆合併成一則訊息。"
        )
    else:
        return  # Only auto-repair specific issue types

    # Send corrective message to the group via bridge
    try:
        import urllib.request
        payload = json.dumps({"chat_id": chat_id, "text": repair_msg}).encode()
        req = urllib.request.Request(
            f"{bridge_url}/send",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            result = json.loads(resp.read())
            if result.get("ok"):
                logger.info("Auto-repair sent to %s: %s", group["name"], issue_type)
            else:
                logger.warning("Auto-repair send failed: %s", result)
    except Exception as e:
        logger.warning("Auto-repair exception for %s: %s", group["name"], e)
        return

    # Record repair
    repair_state[repair_key] = now.isoformat()

    # Notify Cruz about the auto-repair action
    notify_msg = (
        f"[Sentinel 自動修復] {group['name']}: {issue['detail']}\n"
        f"→ 已注入修正指令到群組"
    )
    telegram.send(notify_msg, cruz_id)


def _detect_silence(messages: list[dict], group: dict, config: dict,
                    bridge_healthy: bool | None = None) -> list[dict]:
    """P2: No messages for longer than priority-based threshold.

    Args:
        bridge_healthy: If explicitly False, empty messages are attributed to
            bridge failure rather than group silence. If None, behaves as before
            (assumes bridge is healthy).
    """
    priority = group.get("priority", "low")
    threshold_hours = SILENCE_HOURS.get(priority, 24)
    issues = []
    now = datetime.now()

    if not messages:
        # Root-cause attribution: bridge down ≠ group silence
        if bridge_healthy is False:
            bridge_name = group.get("bridge", "unknown")
            issues.append({
                "type": "bridge_down",
                "severity": "P1",
                "detail": f"Bridge {bridge_name} 無法連線，訊息無法取得（非靜默）",
                "bridge": bridge_name,
            })
            return issues

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


def _check_bridge_health(bridge_urls: dict[str, str]) -> dict[str, bool]:
    """Pre-check health of all bridges. Returns {bridge_name: is_healthy}.

    Called once per run to avoid redundant HTTP checks per group.
    """
    health: dict[str, bool] = {}
    for name, url in bridge_urls.items():
        url = url.rstrip("/")
        try:
            req = urllib.request.Request(f"{url}/health", method="GET")
            with urllib.request.urlopen(req, timeout=5) as resp:
                health[name] = resp.status == 200
        except Exception:
            health[name] = False
        logger.debug("Bridge %s health: %s", name, health[name])
    return health


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

    # Layer 0: Pre-check all bridge health (once, not per-group)
    bridge_urls = scan_cfg.get("bridge", {})
    bridge_health = _check_bridge_health(bridge_urls)
    # Track which down-bridges we've already alerted (for N-group merging)
    bridge_down_alerted: set[str] = set()

    for chat_id, group in groups.items():
        bridge_name = group.get("bridge", "dufu")
        bridge_ok = bridge_health.get(bridge_name, True)

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
        issues.extend(_detect_work_avoidance(messages, scan_cfg))
        issues.extend(_detect_stuck_loop(messages, scan_cfg))
        issues.extend(_detect_silence(messages, group, scan_cfg,
                                      bridge_healthy=bridge_ok))

        for issue in issues:
            issue["chat_id"] = chat_id
            issue["chat_name"] = group["name"]

            # Merge N bridge_down alerts into 1 per bridge
            if issue["type"] == "bridge_down":
                bname = issue.get("bridge", bridge_name)
                alert_key = f"bridge:{bname}:bridge_down"
                if bname in bridge_down_alerted:
                    # Still record in issues for reporting, but skip notification
                    result["issues"].append(issue)
                    current_alert_keys.add(alert_key)
                    continue
                bridge_down_alerted.add(bname)
            else:
                alert_key = f"{chat_id}:{issue['type']}"

            result["issues"].append(issue)
            current_alert_keys.add(alert_key)

            # Auto-repair for actionable P0/P1 issues
            if issue["type"] in ("thought_leak", "stuck_loop", "consecutive_messages"):
                _auto_repair(issue, group, chat_id, pulse_state,
                             telegram, cruz_id, now)

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

        # Pre-check bridge health (same as run())
        bridge_urls = cfg.get("bridge", {})
        bridge_health = _check_bridge_health(bridge_urls)
        bridge_down_shown: set[str] = set()

        total_issues = 0
        for chat_id, group in groups.items():
            bridge_name = group.get("bridge", "dufu")
            bridge_ok = bridge_health.get(bridge_name, True)

            messages = fetch_messages(group["bridge_url"], chat_id, limit=30)
            messages.sort(key=lambda m: m.get("timestamp") or m.get("date") or 0)
            issues = []
            issues.extend(_detect_unresponsive(messages, cfg))
            issues.extend(_detect_thought_leak(messages, cfg))
            issues.extend(_detect_consecutive(messages, cfg))
            issues.extend(_detect_self_eval(messages, cfg))
            issues.extend(_detect_work_avoidance(messages, cfg))
            issues.extend(_detect_stuck_loop(messages, cfg))
            issues.extend(_detect_silence(messages, group, cfg,
                                          bridge_healthy=bridge_ok))

            # Merge bridge_down alerts in dry-run output too
            display_issues = []
            for issue in issues:
                if issue["type"] == "bridge_down":
                    bname = issue.get("bridge", bridge_name)
                    if bname in bridge_down_shown:
                        continue
                    bridge_down_shown.add(bname)
                display_issues.append(issue)

            if display_issues:
                print(f"\n{group['name']} ({chat_id}):")
                for issue in display_issues:
                    print(f"  [{issue['severity']}] {issue['type']}: {issue['detail']}")
                total_issues += len(display_issues)
            else:
                print(f"  {group['name']}: OK")

        print(f"\n[dry-run] Total: {total_issues} issues across {len(groups)} groups")
    else:
        result = run(cfg, st)
        # Save state
        with open(state_path, "w") as f:
            json.dump(st, f, indent=2, ensure_ascii=False)
        print(json.dumps(result, indent=2, ensure_ascii=False))
