#!/usr/bin/env python3
"""
task_briefing.py — 통합 할일 관리 + 브리핑 파이프라인

Usage:
  python3 task_briefing.py --morning           # 아침 브리핑 → Telegram DM
  python3 task_briefing.py --evening           # 저녁 브리핑 → Telegram DM
  python3 task_briefing.py --on-demand         # stdout 출력만 (DM 발송 없음)
  python3 task_briefing.py --add "제목"         # 할일 추가
  python3 task_briefing.py --add "급한일" --priority urgent --source telegram
  python3 task_briefing.py --complete 42       # 할일 완료
  python3 task_briefing.py --cancel 42         # 할일 취소
  python3 task_briefing.py --dry-run --morning # 미리보기
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from shared.db import db_connection, db_transaction
from shared.log import make_logger
from shared.telegram import send_dm as _shared_send_dm, _get_bot_token, DM_CHAT_ID

# ── paths ──
WORKSPACE = Path(os.path.expanduser("~/.openclaw/workspace"))
OPS_DB = Path(os.path.expanduser("~/.openclaw/data/ops_multiagent.db"))
LOGS_DIR = WORKSPACE / "logs"
LOG_FILE = LOGS_DIR / "task_briefing.log"

log = make_logger(log_file=LOG_FILE)


# ── DB queries ──

def _ensure_source_column():
    """source 컬럼이 없으면 추가 (멱등)."""
    if not OPS_DB.exists():
        return
    with db_connection(OPS_DB) as conn:
        try:
            conn.execute("ALTER TABLE ops_todos ADD COLUMN source TEXT DEFAULT NULL")
            conn.commit()
        except Exception:
            pass


_USER_SOURCES = ("telegram", "claude")


def fetch_pending_todos(user_only: bool = False) -> list[dict]:
    """미완료 할일 목록 (우선순위 정렬). user_only=True면 해리 할일만."""
    if not OPS_DB.exists():
        return []
    _ensure_source_column()
    priority_order = "CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 END"
    where = "WHERE status IN ('todo', 'doing', 'blocked')"
    params = ()
    if user_only:
        placeholders = ",".join("?" for _ in _USER_SOURCES)
        where += f" AND source IN ({placeholders})"
        params = _USER_SOURCES
    with db_connection(OPS_DB, row_factory=sqlite3.Row) as conn:
        rows = conn.execute(
            f"""SELECT id, title, detail, status, priority, assigned_to, source, created_at
                FROM ops_todos
                {where}
                ORDER BY {priority_order}, created_at ASC""",
            params,
        ).fetchall()
    return [dict(r) for r in rows]


def fetch_completed_today(user_only: bool = False) -> list[dict]:
    """오늘 완료된 할일. user_only=True면 해리 할일만."""
    if not OPS_DB.exists():
        return []
    today = datetime.now().strftime("%Y-%m-%d")
    source_filter = ""
    params = [today]
    if user_only:
        placeholders = ",".join("?" for _ in _USER_SOURCES)
        source_filter = f" AND source IN ({placeholders})"
        params.extend(_USER_SOURCES)
    with db_connection(OPS_DB, row_factory=sqlite3.Row) as conn:
        rows = conn.execute(
            f"""SELECT id, title, status, priority, completed_at
               FROM ops_todos
               WHERE status IN ('done', 'cancelled')
                 AND date(completed_at) = ?
                 {source_filter}
               ORDER BY completed_at DESC""",
            params,
        ).fetchall()
    return [dict(r) for r in rows]


def fetch_agent_activity_summary(hours: int = 24) -> list[dict]:
    """에이전트 활동 요약 (bus_commands GROUP BY agent, status)."""
    if not OPS_DB.exists():
        return []
    cutoff = (datetime.now() - timedelta(hours=hours)).strftime("%Y-%m-%d %H:%M:%S")
    with db_connection(OPS_DB, row_factory=sqlite3.Row) as conn:
        rows = conn.execute(
            """SELECT target_agent AS agent,
                      status,
                      COUNT(*) AS cnt
               FROM bus_commands
               WHERE created_at >= ?
               GROUP BY target_agent, status
               ORDER BY target_agent, status""",
            (cutoff,),
        ).fetchall()
    return [dict(r) for r in rows]


def fetch_escalation_items() -> list[dict]:
    """시스템이 처리 못한 항목 중 사용자 주의가 필요한 것들."""
    if not OPS_DB.exists():
        return []
    items = []
    with db_connection(OPS_DB, row_factory=sqlite3.Row) as conn:
        # 1) blocked 상태 할일 (출처 무관)
        blocked = conn.execute(
            """SELECT id, title, source, created_at FROM ops_todos
               WHERE status = 'blocked'
               ORDER BY created_at ASC LIMIT 5""",
        ).fetchall()
        for r in blocked:
            items.append({"type": "blocked", **dict(r)})
        # 2) 최근 24h 에이전트 실패 태스크
        cutoff = (datetime.now() - timedelta(hours=24)).strftime("%Y-%m-%d %H:%M:%S")
        failed = conn.execute(
            """SELECT id, title, target_agent, created_at FROM bus_commands
               WHERE status = 'failed' AND created_at >= ?
               ORDER BY created_at DESC LIMIT 5""",
            (cutoff,),
        ).fetchall()
        for r in failed:
            items.append({"type": "failed_cmd", **dict(r)})
    return items


def add_todo(title: str, priority: str = "normal", source: str = None, detail: str = None) -> int:
    """할일 추가, 새 ID 반환."""
    _ensure_source_column()
    with db_transaction(OPS_DB) as conn:
        cur = conn.execute(
            """INSERT INTO ops_todos(title, detail, status, priority, source)
               VALUES (?, ?, 'todo', ?, ?)""",
            (title, detail, priority, source),
        )
        return cur.lastrowid


def complete_todo(todo_id: int) -> bool:
    """할일 완료 처리."""
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with db_transaction(OPS_DB) as conn:
        cur = conn.execute(
            """UPDATE ops_todos
               SET status='done', completed_at=?, updated_at=?
               WHERE id=? AND status IN ('todo','doing','blocked')""",
            (now, now, todo_id),
        )
        return cur.rowcount > 0


def cancel_todo(todo_id: int) -> bool:
    """할일 취소 처리."""
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with db_transaction(OPS_DB) as conn:
        cur = conn.execute(
            """UPDATE ops_todos
               SET status='cancelled', completed_at=?, updated_at=?
               WHERE id=? AND status IN ('todo','doing','blocked')""",
            (now, now, todo_id),
        )
        return cur.rowcount > 0


# ── Briefing builders ──

_PRIORITY_EMOJI = {"urgent": "🔴", "high": "🟠", "normal": "🔵", "low": "⚪"}
_STATUS_LABEL = {"todo": "대기", "doing": "진행중", "blocked": "차단됨", "done": "완료", "cancelled": "취소"}


def build_morning_briefing() -> str:
    """아침 브리핑: 미완료 할일(해리 것만) + 에이전트 24h 활동."""
    pending = fetch_pending_todos(user_only=True)
    activity = fetch_agent_activity_summary(hours=24)

    lines = [f"<b>🌅 아침 브리핑</b> ({datetime.now().strftime('%m/%d %H:%M')})", ""]

    # 할일 섹션
    if pending:
        lines.append(f"<b>📋 미완료 할일 ({len(pending)}건)</b>")
        for t in pending[:15]:
            emoji = _PRIORITY_EMOJI.get(t["priority"], "🔵")
            status = _STATUS_LABEL.get(t["status"], t["status"])
            src = f" [{t['source']}]" if t.get("source") else ""
            lines.append(f"  {emoji} #{t['id']} {t['title']} ({status}){src}")
        if len(pending) > 15:
            lines.append(f"  ... 외 {len(pending) - 15}건")
    else:
        lines.append("📋 미완료 할일 없음 ✨")

    # 에이전트 활동
    if activity:
        lines.append("")
        lines.append("<b>🤖 에이전트 24h 활동</b>")
        agent_stats = {}
        for row in activity:
            a = row["agent"]
            if a not in agent_stats:
                agent_stats[a] = {}
            agent_stats[a][row["status"]] = row["cnt"]
        for agent, stats in sorted(agent_stats.items()):
            parts = [f"{s}:{c}" for s, c in sorted(stats.items())]
            lines.append(f"  {agent}: {', '.join(parts)}")

    return "\n".join(lines)


def build_evening_briefing() -> str:
    """저녁 브리핑: 오늘 완료 + 잔여 할일."""
    completed = fetch_completed_today()
    pending = fetch_pending_todos()

    lines = [f"<b>🌙 저녁 브리핑</b> ({datetime.now().strftime('%m/%d %H:%M')})", ""]

    # 오늘 완료
    if completed:
        lines.append(f"<b>✅ 오늘 완료 ({len(completed)}건)</b>")
        for t in completed[:10]:
            status = "✅" if t["status"] == "done" else "❌"
            lines.append(f"  {status} #{t['id']} {t['title']}")
        if len(completed) > 10:
            lines.append(f"  ... 외 {len(completed) - 10}건")
    else:
        lines.append("✅ 오늘 완료 항목 없음")

    # 잔여 할일
    lines.append("")
    if pending:
        lines.append(f"<b>📋 잔여 할일 ({len(pending)}건)</b>")
        for t in pending[:10]:
            emoji = _PRIORITY_EMOJI.get(t["priority"], "🔵")
            lines.append(f"  {emoji} #{t['id']} {t['title']}")
        if len(pending) > 10:
            lines.append(f"  ... 외 {len(pending) - 10}건")
    else:
        lines.append("📋 모든 할일 완료 ✨")

    return "\n".join(lines)


def build_on_demand_briefing() -> str:
    """on-demand: 할일 현황 + 시스템 에스컬레이션."""
    pending = fetch_pending_todos()
    completed = fetch_completed_today()
    escalation = fetch_escalation_items()

    lines = [f"📋 할일 현황 ({datetime.now().strftime('%m/%d %H:%M')})", ""]

    if pending:
        for t in pending[:20]:
            emoji = _PRIORITY_EMOJI.get(t["priority"], "🔵")
            status = _STATUS_LABEL.get(t["status"], t["status"])
            lines.append(f"{emoji} #{t['id']} {t['title']} ({status})")
    else:
        lines.append("미완료 할일 없음 ✨")

    if completed:
        lines.append("")
        lines.append(f"오늘 완료: {len(completed)}건")

    if escalation:
        lines.append("")
        lines.append(f"⚠️ 시스템 미해결 ({len(escalation)}건)")
        for item in escalation:
            if item["type"] == "blocked":
                lines.append(f"  🚫 #{item['id']} {item['title']}")
            elif item["type"] == "failed_cmd":
                agent = item.get("target_agent", "?")
                lines.append(f"  ❌ {item['title'][:40]} ({agent})")

    return "\n".join(lines)


# ── Telegram Bot API ──


def _tg_api(method: str, payload: dict) -> dict | None:
    """Telegram Bot API 호출 헬퍼."""
    token = _get_bot_token()
    url = f"https://api.telegram.org/bot{token}/{method}"
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception as e:
        log(f"Telegram API {method} 실패: {e}", level="ERROR")
        return None


# ── 인라인 버튼 할일 관리 ──


def send_todo_buttons(dry_run: bool = False) -> bool:
    """미완료 할일을 인라인 버튼 메시지로 DM 발송. 버튼 탭 → Gateway가 한국어 명령으로 라우팅."""
    pending = fetch_pending_todos(user_only=True)
    if not pending:
        return False
    items = pending[:8]
    # 메시지 본문: 할일 목록 + 사용법
    lines = [f"📋 <b>할일 현황</b> ({len(pending)}건)", ""]
    for t in items:
        emoji = _PRIORITY_EMOJI.get(t["priority"], "⚪")
        lines.append(f"{emoji} #{t['id']} {t['title']}")
    if len(pending) > 8:
        lines.append(f"  ... 외 {len(pending) - 8}건")
    lines.append("")
    lines.append("━━━━━━━━━━━━━━━━━━")
    lines.append("💡 <code>할일 추가: 제목</code>  — 새 할일")
    lines.append("💡 <code>할일 추가: 제목 !urgent</code>  — 긴급")
    lines.append("💡 <code>할일 취소 #번호</code>  — 취소")
    lines.append("👇 버튼 탭 — 즉시 완료 처리")
    text = "\n".join(lines)
    # 인라인 키보드: 버튼에 제목 포함 (1열 = 알아보기 쉽게)
    buttons = []
    for t in items:
        title_short = t["title"][:25]
        emoji = _PRIORITY_EMOJI.get(t["priority"], "⚪")
        buttons.append([{
            "text": f"✅ #{t['id']} {emoji} {title_short}",
            "callback_data": f"할일 완료 #{t['id']}",
        }])
    # 하단: 추가 + 새로고침
    buttons.append([
        {"text": "➕ 할일 추가", "callback_data": "할일 추가:"},
        {"text": "🔄 새로고침", "callback_data": "할일 확인"},
    ])
    if dry_run:
        log(f"DRY-RUN — 버튼 메시지 생략: {len(items)}건")
        print(text)
        for brow in buttons:
            print("  " + "  ".join(f"[{b['text']}]" for b in brow))
        return True
    result = _tg_api("sendMessage", {
        "chat_id": DM_CHAT_ID,
        "text": text,
        "parse_mode": "HTML",
        "reply_markup": {"inline_keyboard": buttons},
    })
    if not result or not result.get("ok"):
        log("버튼 메시지 발송 실패", level="ERROR")
        return False
    log(f"버튼 메시지 발송 완료: {len(items)}건")
    return True


# ── Telegram DM ──

def send_dm(text: str, dry_run: bool = False) -> bool:
    """Telegram DM 발송."""
    if dry_run:
        log("DRY-RUN — DM 발송 생략")
        return True
    return _shared_send_dm(text)


# ── CLI ──

def main():
    parser = argparse.ArgumentParser(description="통합 할일 브리핑")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--morning", action="store_true", help="아침 브리핑 → DM")
    mode.add_argument("--evening", action="store_true", help="저녁 브리핑 → DM")
    mode.add_argument("--on-demand", action="store_true", help="stdout 출력만")
    mode.add_argument("--add", type=str, metavar="TITLE", help="할일 추가")
    mode.add_argument("--complete", type=int, metavar="ID", help="할일 완료")
    mode.add_argument("--cancel", type=int, metavar="ID", help="할일 취소")
    mode.add_argument("--buttons", action="store_true", help="할일 인라인 버튼 → DM")
    mode.add_argument("--notify", action="store_true", help="6시간 주기 알림: 버튼 + 에스컬레이션")

    parser.add_argument("--priority", default="normal", choices=["low", "normal", "high", "urgent"])
    parser.add_argument("--source", default=None, help="출처: telegram|claude|agent|cron|system")
    parser.add_argument("--detail", default=None, help="상세 내용")
    parser.add_argument("--dry-run", action="store_true", help="DM 발송 없이 미리보기")

    args = parser.parse_args()

    if args.add:
        new_id = add_todo(args.add, priority=args.priority, source=args.source, detail=args.detail)
        msg = f"할일 추가: #{new_id} {args.add} (priority={args.priority})"
        log(msg)
        print(msg)
        return

    if args.complete:
        ok = complete_todo(args.complete)
        msg = f"할일 #{args.complete} {'완료 처리' if ok else '실패 (이미 완료되었거나 존재하지 않음)'}"
        log(msg)
        print(msg)
        return

    if args.cancel:
        ok = cancel_todo(args.cancel)
        msg = f"할일 #{args.cancel} {'취소 처리' if ok else '실패 (이미 취소되었거나 존재하지 않음)'}"
        log(msg)
        print(msg)
        return

    if args.buttons:
        ok = send_todo_buttons(dry_run=args.dry_run)
        if ok:
            print("버튼 메시지 발송 완료 ✅")
        else:
            print("할일이 없어서 버튼을 보내지 않았습니다")
        return

    if args.notify:
        # 1) 할일 버튼 발송
        has_todos = send_todo_buttons(dry_run=args.dry_run)
        # 2) 에스컬레이션 항목 확인
        esc = fetch_escalation_items()
        if esc:
            lines = ["⚠️ <b>주의 필요 항목</b>", ""]
            for item in esc:
                if item["type"] == "blocked":
                    lines.append(f"🚫 #{item['id']} {item['title']} — blocked")
                elif item["type"] == "failed_cmd":
                    agent = item.get("target_agent", "?")
                    lines.append(f"❌ CMD#{item['id']} {item['title'][:40]} ({agent} 실패)")
            esc_text = "\n".join(lines)
            if not args.dry_run:
                send_dm(esc_text)
            print(esc_text)
        if not has_todos and not esc:
            log("알림 생략: 할일 없음, 에스컬레이션 없음")
            print("알림 대상 없음")
        return

    # 브리핑 모드
    if args.morning:
        text = build_morning_briefing()
    elif args.evening:
        text = build_evening_briefing()
    else:
        text = build_on_demand_briefing()

    print(text)

    if args.morning or args.evening:
        ok = send_dm(text, dry_run=args.dry_run)
        if ok:
            log(f"{'아침' if args.morning else '저녁'} 브리핑 DM 발송 {'(dry-run)' if args.dry_run else '완료'}")
        else:
            log("브리핑 DM 발송 실패", level="ERROR")


if __name__ == "__main__":
    main()
