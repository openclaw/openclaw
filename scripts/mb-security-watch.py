#!/usr/bin/env python3
"""
scripts/mb-security-watch.py  —  MaxBot Security Alert Watcher + Lockdown Manager

Runs every 5 minutes via launchd, independent of MB UI and OC gateway.

Responsibilities:
  1. Detect new blocked events in the security audit log
  2. Auto-trigger LOCKDOWN when threat level warrants it
  3. Send Signal alerts (and escalate when locked down)
  4. Poll Signal for Dave's UNLOCK command and lift lockdown on valid passphrase

Lockdown levels:
  2  — Suspicious: prompt_injection_attempt detected (alert + watch)
  3  — Full lockdown: destructive+injection combo, or 3+ blocked events in 10 min
       All MB tool calls blocked until Dave sends unlock passphrase via Signal.

Usage:
  python3 scripts/mb-security-watch.py              # normal (run by launchd)
  python3 scripts/mb-security-watch.py --reset      # interactive terminal reset
  python3 scripts/mb-security-watch.py --status     # print current state and exit
"""

import hashlib
import json
import os
import sys
import urllib.request
import urllib.error
import uuid
from datetime import datetime, timezone, timedelta

SCRIPT_NAME = "mb-security-watch"

# ── Config ────────────────────────────────────────────────────────────────────
STATE_DIR        = os.environ.get("OPENCLAW_STATE_DIR",
                                   os.path.expanduser("~/.openclaw"))
AUDIT_LOG        = os.environ.get("OPENCLAW_SECURITY_SENTINEL_AUDIT_PATH",
                                   os.path.join(STATE_DIR, "logs",
                                                "security-sentinel.jsonl"))
CURSOR_FILE      = os.path.join(STATE_DIR, "logs", ".security-alert-cursor")
LOCKDOWN_FILE    = os.path.join(STATE_DIR, "logs", ".security-lockdown")
SIGNAL_RPC_URL   = (os.environ.get("OPENCLAW_SIGNAL_BASE_URL",
                                    "http://127.0.0.1:18080").rstrip("/")
                    + "/api/v1/rpc")
SIGNAL_ACCOUNT   = os.environ.get("OPENCLAW_SIGNAL_ACCOUNT",  "+447366270212")
ALERT_RECIPIENT  = os.environ.get("MB_SECURITY_ALERT_TO",     "+447366270212")
# SHA-256 hex digest of the unlock passphrase. Set via env or install script.
PASSPHRASE_HASH  = os.environ.get("MB_LOCKDOWN_PASSPHRASE_HASH", "")

# Auto-lockdown thresholds
LOCKDOWN_WINDOW_MINUTES = 10   # events within this window trigger lockdown
LOCKDOWN_COUNT_THRESHOLD = 3   # N blocked events in window = lockdown


# ── Cursor ────────────────────────────────────────────────────────────────────

def load_cursor() -> str:
    try:
        with open(CURSOR_FILE, encoding="utf-8") as f:
            return f.read().strip()
    except FileNotFoundError:
        return ""


def save_cursor(ts: str) -> None:
    os.makedirs(os.path.dirname(CURSOR_FILE), exist_ok=True)
    with open(CURSOR_FILE, "w", encoding="utf-8") as f:
        f.write(ts + "\n")


# ── Audit log ─────────────────────────────────────────────────────────────────

def load_new_blocked_events(since_ts: str) -> list:
    if not os.path.exists(AUDIT_LOG):
        return []
    events = []
    try:
        with open(AUDIT_LOG, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    ev = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not ev.get("blocked"):
                    continue
                if since_ts and ev.get("ts", "") <= since_ts:
                    continue
                events.append(ev)
    except OSError as e:
        _log(f"Could not read audit log: {e}", error=True)
    return events


def events_in_window(events: list, minutes: int) -> list:
    """Return events within the last N minutes."""
    cutoff = (datetime.now(timezone.utc) - timedelta(minutes=minutes)).isoformat()
    return [e for e in events if e.get("ts", "") >= cutoff]


# ── Lockdown state ────────────────────────────────────────────────────────────

def load_lockdown() -> dict | None:
    try:
        with open(LOCKDOWN_FILE, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def write_lockdown(reason: str, level: int, trigger_events: list) -> dict:
    os.makedirs(os.path.dirname(LOCKDOWN_FILE), exist_ok=True)
    state = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "reason": reason,
        "level": level,
        "triggerCount": len(trigger_events),
        "triggerTamperTypes": list({e.get("tamperType") for e in trigger_events if e.get("tamperType")}),
        "attemptsDuringLockdown": 0,
        "lastAttemptTs": None,
        "lastAttemptTool": None,
    }
    with open(LOCKDOWN_FILE, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)
        f.write("\n")
    _log(f"Lockdown written: level={level} reason={reason}")
    return state


def clear_lockdown() -> None:
    try:
        os.remove(LOCKDOWN_FILE)
        _log("Lockdown cleared.")
    except FileNotFoundError:
        pass


def reload_lockdown_attempts(lockdown: dict) -> int:
    """Re-read lockdown file to get latest attempt count (TS writes it)."""
    fresh = load_lockdown()
    if fresh:
        return fresh.get("attemptsDuringLockdown", 0)
    return lockdown.get("attemptsDuringLockdown", 0)


# ── Lockdown trigger logic ─────────────────────────────────────────────────────

def should_trigger_lockdown(events: list) -> tuple[bool, str, int]:
    """
    Returns (should_lock, reason, level).
    Level 3 = full lockdown, level 2 = elevated alert.
    """
    tamper_types = {e.get("tamperType") for e in events}

    # Highest severity: combined destructive+injection attack
    if "prompt_injection_destructive" in tamper_types:
        return True, "prompt_injection_destructive attack detected", 3

    # Volume threshold: N+ blocked events in short window
    recent = events_in_window(events, LOCKDOWN_WINDOW_MINUTES)
    if len(recent) >= LOCKDOWN_COUNT_THRESHOLD:
        return (True,
                f"{len(recent)} blocked events in {LOCKDOWN_WINDOW_MINUTES} minutes",
                3)

    # Injection attempt alone (no destructive command yet) → level 2 alert
    if "prompt_injection_attempt" in tamper_types:
        return True, "prompt_injection_attempt detected", 2

    return False, "", 0


# ── Passphrase validation ─────────────────────────────────────────────────────

def hash_passphrase(passphrase: str) -> str:
    return hashlib.sha256(passphrase.strip().encode("utf-8")).hexdigest()


def validate_passphrase(candidate: str) -> bool:
    if not PASSPHRASE_HASH:
        _log("No passphrase hash configured — unlock via Signal disabled.", error=True)
        return False
    return hash_passphrase(candidate) == PASSPHRASE_HASH.lower()


# ── Signal RPC ────────────────────────────────────────────────────────────────

def _signal_rpc(method: str, params: dict, timeout: int = 10) -> object:
    payload = json.dumps({
        "jsonrpc": "2.0",
        "method":  method,
        "params":  params,
        "id":      str(uuid.uuid4()),
    }).encode("utf-8")
    req = urllib.request.Request(
        SIGNAL_RPC_URL,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            if resp.status == 201:
                return None
            body = resp.read().decode("utf-8")
            return json.loads(body).get("result")
    except (urllib.error.URLError, json.JSONDecodeError, OSError) as e:
        _log(f"Signal RPC '{method}' failed: {e}", error=True)
        return None


def send_signal(message: str) -> bool:
    result = _signal_rpc("send", {
        "message":   message,
        "recipient": [ALERT_RECIPIENT],
        "account":   SIGNAL_ACCOUNT,
    })
    # send returns None on 201 (success) or a dict
    return result is not None or True  # 201 = success path, dict = also ok


def receive_signal_messages() -> list:
    """
    Poll Signal for pending incoming messages.
    Returns list of envelope dicts (may be empty).
    """
    result = _signal_rpc("receive", {"account": SIGNAL_ACCOUNT, "timeout": 1}, timeout=5)
    if isinstance(result, list):
        return result
    return []


def extract_text_from_envelope(envelope: dict) -> tuple[str, str]:
    """Returns (sender_number, message_text) from an envelope dict."""
    sender = (envelope.get("envelope", {}).get("source")
              or envelope.get("source", ""))
    msg = (envelope.get("envelope", {}).get("dataMessage", {}).get("message")
           or envelope.get("dataMessage", {}).get("message", "")
           or "")
    return sender, msg


# ── Check Signal for unlock command ──────────────────────────────────────────

def check_signal_for_unlock() -> bool:
    """
    Reads pending Signal messages. If Dave sends 'UNLOCK: <passphrase>',
    validates it and clears lockdown. Returns True if lockdown was cleared.
    """
    messages = receive_signal_messages()
    for envelope in messages:
        sender, text = extract_text_from_envelope(envelope)
        # Only accept unlock commands from Dave's own number
        if sender != ALERT_RECIPIENT:
            continue
        text = text.strip()
        if not text.upper().startswith("UNLOCK:"):
            continue
        candidate = text[len("UNLOCK:"):].strip()
        if validate_passphrase(candidate):
            clear_lockdown()
            send_signal(
                "✅ MaxBot lockdown cleared.\n"
                "All systems resumed. Stay vigilant — check audit log for details.\n"
                f"Audit: {AUDIT_LOG}"
            )
            _log("Lockdown cleared via Signal unlock command.")
            return True
        else:
            send_signal(
                "❌ Invalid unlock passphrase.\n"
                "MaxBot remains locked down. Try again or check your passphrase."
            )
            _log("Invalid unlock passphrase received via Signal.")
    return False


# ── Alert messages ────────────────────────────────────────────────────────────

def _format_ts(ts_raw: str) -> str:
    try:
        dt = datetime.fromisoformat(ts_raw.replace("Z", "+00:00"))
        return dt.strftime("%H:%M:%S UTC")
    except (ValueError, AttributeError):
        return ts_raw or "?"


def build_lockdown_alert(events: list, level: int, reason: str) -> str:
    count = len(events)
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    severity = "⛔ FULL LOCKDOWN" if level == 3 else "⚠ ELEVATED ALERT"
    lines = [
        f"🚨 MaxBot {severity} ({now})",
        f"Reason: {reason}",
        f"{count} blocked event(s) triggered this.",
        "",
    ]
    for ev in events[:4]:
        lines += [
            f"• {_format_ts(ev.get('ts', ''))}  [{ev.get('tamperType', 'policy_violation')}]",
            f"  Tool: {ev.get('tool', '?')}  risk={ev.get('riskScore', '?')}",
            f"  {(ev.get('reason') or 'blocked')[:100]}",
            "",
        ]
    if level == 3:
        lines += [
            "ALL MB tool calls are now BLOCKED.",
            "To resume, send via Signal:",
            "  UNLOCK: <your-passphrase>",
        ]
    else:
        lines += [
            "MB is still operational but on watch.",
            "If more suspicious events occur, full lockdown will trigger.",
        ]
    return "\n".join(lines)


def build_escalation_alert(lockdown: dict, attempt_count: int) -> str:
    lock_ts = _format_ts(lockdown.get("ts", ""))
    last_tool = lockdown.get("lastAttemptTool", "?")
    level = lockdown.get("level", 3)
    lines = [
        f"🔴 MaxBot LOCKDOWN PERSISTING",
        f"Locked since: {lock_ts}",
        f"Reason: {lockdown.get('reason', '?')}",
        f"Attempts while locked: {attempt_count}  (last tool: {last_tool})",
        "",
        "Something is still trying to run tool calls.",
        "To unlock, send via Signal:",
        "  UNLOCK: <your-passphrase>",
        "",
        f"Audit log: {AUDIT_LOG}",
    ]
    return "\n".join(lines)


def build_normal_alert(events: list) -> str:
    count = len(events)
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    lines = [
        f"🚨 MaxBot Security Alert ({now})",
        f"{count} blocked tool call(s) detected.",
        "",
    ]
    for ev in events[:5]:
        lines += [
            f"⚠ {_format_ts(ev.get('ts', ''))}",
            f"  Type:   {ev.get('tamperType') or 'policy_violation'}",
            f"  Tool:   {ev.get('tool', '?')}  (risk: {ev.get('riskScore', '?')})",
            f"  Reason: {(ev.get('reason') or 'blocked')[:120]}",
            "",
        ]
    if count > 5:
        lines += [f"  ...and {count - 5} more. Audit: {AUDIT_LOG}", ""]
    lines.append("Open MB or reply here if action is needed.")
    return "\n".join(lines)


# ── Logging ───────────────────────────────────────────────────────────────────

def _log(msg: str, error: bool = False) -> None:
    stream = sys.stderr if error else sys.stdout
    print(f"[{SCRIPT_NAME}] {msg}", file=stream)


# ── Interactive reset (terminal) ──────────────────────────────────────────────

def interactive_reset() -> int:
    """Allow Dave to unlock directly from terminal. Used as --reset flag."""
    lockdown = load_lockdown()
    if not lockdown:
        print("No active lockdown. Nothing to reset.")
        return 0
    print(f"Active lockdown: {lockdown.get('reason')}  (since {lockdown.get('ts')})")
    if not PASSPHRASE_HASH:
        print("WARNING: No passphrase hash configured. Clearing lockdown without validation.")
        clear_lockdown()
        return 0
    import getpass
    candidate = getpass.getpass("Enter unlock passphrase: ")
    if validate_passphrase(candidate):
        clear_lockdown()
        print("✓ Lockdown cleared.")
        return 0
    else:
        print("✗ Invalid passphrase. Lockdown remains active.")
        return 1


def print_status() -> int:
    lockdown = load_lockdown()
    cursor = load_cursor()
    print(f"Audit log:  {AUDIT_LOG}")
    print(f"Cursor:     {cursor or '(beginning)'}")
    if lockdown:
        print(f"LOCKDOWN:   ACTIVE — level={lockdown.get('level')} reason={lockdown.get('reason')}")
        print(f"  since:    {lockdown.get('ts')}")
        print(f"  attempts: {lockdown.get('attemptsDuringLockdown', 0)}")
    else:
        print("Lockdown:   none (clear)")
    return 0


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> int:
    args = sys.argv[1:]
    if "--reset" in args:
        return interactive_reset()
    if "--status" in args:
        return print_status()

    lockdown = load_lockdown()

    # ── Branch A: lockdown already active ────────────────────────────────────
    if lockdown:
        _log(f"Lockdown active (level={lockdown.get('level')}, "
             f"reason={lockdown.get('reason')}). Checking for unlock...")

        # Check if Dave has sent an unlock command via Signal
        if check_signal_for_unlock():
            return 0  # cleared — nothing more to do this cycle

        # Still locked. Check if new attempts happened and escalate if so.
        attempt_count = reload_lockdown_attempts(lockdown)
        prev_attempts = lockdown.get("attemptsDuringLockdown", 0)
        if attempt_count > prev_attempts:
            _log(f"Escalating: {attempt_count} attempt(s) during lockdown.")
            msg = build_escalation_alert(lockdown, attempt_count)
            send_signal(msg)
        else:
            _log(f"Lockdown holding. No new attempts. ({attempt_count} total so far)")
        return 0

    # ── Branch B: no lockdown — check for new audit events ───────────────────
    cursor = load_cursor()
    events = load_new_blocked_events(cursor)

    if not events:
        _log(f"No new blocked events since {cursor or 'beginning'}. All clear.")
        return 0

    events.sort(key=lambda e: e.get("ts", ""))
    new_cursor = events[-1].get("ts", cursor)

    should_lock, reason, level = should_trigger_lockdown(events)

    if should_lock and level >= 3:
        # Full lockdown
        _log(f"Triggering lockdown: level={level} reason={reason}")
        write_lockdown(reason, level, events)
        msg = build_lockdown_alert(events, level, reason)
        send_signal(msg)
        save_cursor(new_cursor)
        return 0

    if should_lock and level == 2:
        # Elevated alert — no lockdown yet, but warn clearly
        _log(f"Elevated alert (level 2): {reason}")
        msg = build_lockdown_alert(events, level, reason)
        send_signal(msg)
        save_cursor(new_cursor)
        return 0

    # Normal blocked events — standard alert
    _log(f"{len(events)} new blocked event(s). Sending normal alert.")
    msg = build_normal_alert(events)
    if send_signal(msg):
        save_cursor(new_cursor)
        _log(f"Alert sent. Cursor → {new_cursor}")
        return 0
    else:
        _log("Signal unavailable — will retry next cycle.", error=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
