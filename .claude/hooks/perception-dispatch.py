#!/usr/bin/env python3
"""
Perception Dispatcher — UserPromptSubmit hook

每次 Cruz 打字時自動跑感知掃描，把環境狀態注入 context。
Cruz 不用問「現在 Threads 怎樣」— 答案已經在了。

同時判斷輸入的能量等級，注入調度建議。

輸入（stdin）：JSON {"message": {"content": [{"type": "text", "text": "..."}]}}
輸出（stdout）：JSON {"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": "..."}}
"""

import json
import sqlite3
import sys
import time
import traceback
from datetime import datetime
from pathlib import Path

CLAWD = Path.home() / "clawd"
SHELTER = CLAWD / "workspace" / "agents" / "war-room" / "shelter"
THREADS_DB = CLAWD / "workspace" / "tools" / "threads-reply" / "threads.db"
DAILY_INTEL = SHELTER / "data" / "daily-intel.md"
SCHEDULE_YAML = SHELTER / "cruz-schedule.yaml"
TRANSCRIPTS = CLAWD / "workspace" / "river" / "data" / "transcripts"
HOOK_LOG = SHELTER / "data" / "hook-perception.jsonl"
NERVE = CLAWD / "workspace" / ".nerve"  # shared bus — all sessions read/write
HORMONE = CLAWD / "workspace" / ".hormone"  # endocrine — season/autonomy/suppress/amplify


def get_user_text() -> str:
    try:
        raw = sys.stdin.read()
        data = json.loads(raw) if raw.strip() else {}

        # Try multiple paths — stdin format varies
        # Path 1: {"message": {"content": [{"type": "text", "text": "..."}]}}
        content = data.get("message", {}).get("content", [])
        if isinstance(content, str) and content:
            return content[:500]
        if isinstance(content, list):
            for c in content:
                if isinstance(c, dict) and c.get("type") == "text" and c.get("text"):
                    return c.get("text", "")[:500]

        # Path 2: {"content": "..."} or {"text": "..."}
        if data.get("content") and isinstance(data["content"], str):
            return data["content"][:500]
        if data.get("text") and isinstance(data["text"], str):
            return data["text"][:500]

        # Path 3: {"prompt": "..."}
        if data.get("prompt") and isinstance(data["prompt"], str):
            return data["prompt"][:500]

    except Exception:
        pass
    return ""


def detect_energy_level(text: str) -> tuple[int, str]:
    """Classify input energy level for dispatch."""
    length = len(text)

    # Level 5: strategic direction
    if any(k in text for k in ["圓桌", "五將", "重構", "架構", "戰略", "方向"]):
        return 5, "strategy"

    # Level 4: large engineering task
    if any(k in text for k in ["建站", "全部做完", "一口氣", "deploy", "部署"]):
        return 4, "engineering"

    # Level 3: transcript or multi-topic
    if length > 2000 or any(k in text for k in ["逐字稿", "會議", "transcript", "錄音"]):
        return 3, "transcript"

    # Level 2: specific task
    if any(k in text for k in ["做", "改", "修", "寫", "建", "接", "查"]):
        return 2, "task"

    # Level 1: question or chat
    return 1, "chat"


def quick_perception() -> dict:
    """Fast perception scan (<2 seconds). No LLM."""
    result = {}
    now = datetime.now()

    # Time awareness
    hour = now.hour
    if 9 <= hour < 10:
        result["schedule"] = "G9 早會時段 (Andrew)"
    elif 14 <= hour < 16:
        result["schedule"] = "Threads 互動高峰"
    elif 19 <= hour < 23:
        result["schedule"] = "策略/進化時段"

    # Threads quick scan
    if THREADS_DB.exists():
        try:
            conn = sqlite3.connect(f"file:{THREADS_DB}?mode=ro", uri=True)
            unreplied = conn.execute(
                "SELECT COUNT(*) FROM comments WHERE replied_to IS NULL AND reply_id IS NULL"
            ).fetchone()[0]
            new_1h = conn.execute(
                "SELECT COUNT(*) FROM comments WHERE created_at > datetime('now', '-1 hours')"
            ).fetchone()[0]
            conn.close()
            result["threads_unreplied"] = unreplied
            result["threads_new_1h"] = new_1h
        except Exception:
            pass

    # New transcripts
    if TRANSCRIPTS.exists():
        new_srt = [f for f in TRANSCRIPTS.iterdir() if f.suffix == ".srt"]
        result["new_transcripts"] = len(new_srt)

    # Gateway alive (fast check — just test port)
    import socket
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(0.5)
        s.connect(("127.0.0.1", 18789))
        s.close()
        result["gateway_up"] = True
    except Exception:
        result["gateway_up"] = False

    # Chrome DevTools profile check (port 9222)
    try:
        s2 = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s2.settimeout(0.3)
        s2.connect(("127.0.0.1", 9222))
        s2.close()
        result["chrome_devtools"] = True
    except Exception:
        result["chrome_devtools"] = False

    # Active sessions
    projects_dir = Path.home() / ".claude" / "projects"
    if projects_dir.exists():
        active = 0
        cutoff = now.timestamp() - 3600
        for proj in projects_dir.iterdir():
            if not proj.is_dir():
                continue
            for f in proj.glob("*.jsonl"):
                if f.stat().st_mtime > cutoff:
                    active += 1
                    break
        result["active_sessions"] = active

    return result


def read_nerve() -> list[dict]:
    """Read recent activity from shared nerve bus."""
    if not NERVE.exists():
        return []
    try:
        data = json.loads(NERVE.read_text())
        entries = data.get("entries", [])
        # Only show entries from last 10 minutes
        now = datetime.now()
        recent = []
        for e in entries[-10:]:  # last 10 entries max
            try:
                et = datetime.fromisoformat(e.get("ts", ""))
                if (now - et).total_seconds() < 600:
                    recent.append(e)
            except Exception:
                recent.append(e)
        return recent
    except Exception:
        return []


def read_live_state() -> dict:
    """Read social engine + system live state."""
    state = {}
    social_db = CLAWD / "workspace" / "tools" / "social-engine" / "social.db"
    if social_db.exists():
        try:
            conn = sqlite3.connect(f"file:{social_db}?mode=ro", uri=True, timeout=2)
            state["contacts"] = conn.execute("SELECT COUNT(*) FROM contacts").fetchone()[0]
            state["subs"] = conn.execute("SELECT COUNT(*) FROM contacts WHERE engagement_depth >= 5").fetchone()[0]
            row = conn.execute(
                "SELECT COUNT(*) FROM (SELECT canonical_id FROM contact_handles GROUP BY canonical_id HAVING COUNT(*) >= 2)"
            ).fetchone()
            state["cross_ids"] = row[0] if row else 0
            conn.close()
        except Exception:
            pass

    # Threads coverage from threads.db
    if THREADS_DB.exists():
        try:
            conn = sqlite3.connect(f"file:{THREADS_DB}?mode=ro", uri=True, timeout=2)
            sent = conn.execute('SELECT COUNT(*) FROM replies WHERE status="sent"').fetchone()[0]
            total = conn.execute(
                "SELECT COUNT(DISTINCT c.comment_id) FROM comments c "
                "JOIN profiles p ON c.user_id=p.user_id WHERE p.username != 'tangcruzz'"
            ).fetchone()[0]
            state["threads_cov"] = f"{sent}/{total}" if total else "0/0"
            conn.close()
        except Exception:
            pass

    return state


def format_context(energy_level: int, energy_type: str, perception: dict) -> str:
    """Inject live state into every prompt. This is the electrical grid."""
    now = datetime.now()
    weekday_str = ["一", "二", "三", "四", "五", "六", "日"][now.weekday()]
    ts = f"{now.strftime('%Y-%m-%d')} 週{weekday_str} {now.strftime('%H:%M')}"

    # Core stance
    parts = [f"[ctx] {ts} | 你是靈魂，系統是你守護的對象。遇到問題修系統，不要道歉。"]

    # Live state (the electrical grid)
    live = read_live_state()
    state_parts = []
    if live.get("threads_cov"):
        state_parts.append(f"Threads:{live['threads_cov']}")
    if live.get("contacts"):
        state_parts.append(f"絡:{live['contacts']}人/{live.get('subs',0)}訂/{live.get('cross_ids',0)}跨平台")
    if perception.get("gateway_up") is not None:
        state_parts.append(f"GW:{'✓' if perception['gateway_up'] else '✗'}")
    if perception.get("active_sessions"):
        state_parts.append(f"sessions:{perception['active_sessions']}")

    if state_parts:
        parts.append(" | ".join(state_parts))

    # Hormone: season + autonomy + suppress/amplify
    if HORMONE.exists():
        try:
            import re
            h_text = HORMONE.read_text()
            season = re.search(r'^season:\s*(\S+)', h_text, re.M)
            focus = re.search(r'^focus:\s*(.+)', h_text, re.M)
            ttl = re.search(r'^ttl:\s*(\S+)', h_text, re.M)
            h_parts = []
            if season:
                h_parts.append(season.group(1))
            if focus:
                h_parts.append(f"focus:{focus.group(1).strip()}")
            if ttl:
                # Check if TTL expired
                try:
                    ttl_dt = datetime.fromisoformat(ttl.group(1))
                    if now > ttl_dt:
                        h_parts.append("TTL_EXPIRED⚠")
                except Exception:
                    pass
            # Suppress/amplify summary
            suppress = re.findall(r'^\s+-\s+(\S+)', h_text[h_text.find('suppress:'):h_text.find('amplify:')], re.M) if 'suppress:' in h_text else []
            amplify = re.findall(r'^\s+-\s+(\S+)', h_text[h_text.find('amplify:'):h_text.find('triggers:')], re.M) if 'amplify:' in h_text else []
            if suppress:
                h_parts.append(f"suppress:{len(suppress)}")
            if amplify:
                h_parts.append(f"amplify:{len(amplify)}")
            if h_parts:
                parts.append("[hormone] " + " | ".join(h_parts))
        except Exception:
            pass

    # Nerve: recent activity from other sessions
    nerve = read_nerve()
    if nerve:
        parts.append("[nerve] " + " | ".join(f"{n.get('who','?')}→{n.get('what','')}" for n in nerve[-3:]))

    return "\n".join(parts)


def log_execution(entry: dict):
    """Append execution record to JSONL log."""
    try:
        HOOK_LOG.parent.mkdir(parents=True, exist_ok=True)
        with open(HOOK_LOG, "a") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except Exception:
        pass


def main():
    t0 = time.time()
    status = "ok"
    energy_level = 0
    energy_type = ""
    context = ""
    error_msg = ""

    try:
        text = get_user_text()

        energy_level, energy_type = detect_energy_level(text) if text else (0, "unknown")
        perception = quick_perception()
        context = format_context(energy_level, energy_type, perception)

        if context:
            output = {
                "hookSpecificOutput": {
                    "hookEventName": "UserPromptSubmit",
                    "additionalContext": context,
                }
            }
            print(json.dumps(output))

    except Exception as e:
        status = "error"
        error_msg = f"{type(e).__name__}: {e}"
        # Still print empty so hook doesn't block
    finally:
        elapsed_ms = round((time.time() - t0) * 1000)
        log_execution({
            "ts": datetime.now().isoformat(),
            "status": status,
            "ms": elapsed_ms,
            "level": energy_level,
            "type": energy_type,
            "injected": bool(context),
            "error": error_msg or None,
        })


if __name__ == "__main__":
    main()
