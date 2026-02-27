#!/usr/bin/env python3
"""
task_notifier.py - 완료된 태스크 결과를 Harry에게 텔레그램으로 전송 (읽기 쉬운 포맷)
"""

import json
import os
import sqlite3
import re
from datetime import datetime
from pathlib import Path
from shared.db import resolve_ops_db_path

DB_PATH = resolve_ops_db_path()
CHAT_ID = "492860021"

def send_telegram(message: str, chat_id: str = CHAT_ID) -> bool:
    import urllib.request
    
    token = ""
    config_file = Path.home() / ".openclaw/openclaw.json"
    if config_file.exists():
        with open(config_file) as f:
            data = json.load(f)
            channels = data.get('channels', {})
            telegram = channels.get('telegram', {})
            token = telegram.get('botToken', '')
    
    if not token:
        print("❌ Telegram Bot Token 없음")
        return False
    
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    
    if len(message) > 3500:
        message = message[:3500] + "\n\n... (계속)"
    
    payload = {"chat_id": chat_id, "text": message}
    data = json.dumps(payload).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            result = json.loads(resp.read().decode("utf-8"))
            return result.get("ok", False)
    except Exception as e:
        print(f"❌ 전송 실패: {e}")
        return False


def _clean_sentence(text: str, max_len: int = 80) -> str:
    """LLM 원본 텍스트에서 첫 의미 있는 문장만 추출."""
    text = text.strip()
    # 선행 → 제거
    text = re.sub(r'^→\s*', '', text)
    # → 화살표로 분리된 항목 중 가장 의미 있는 첫 항목
    parts = re.split(r'\s*→\s*', text)
    # 빈 첫 항목 건너뛰기
    text = next((p.strip() for p in parts if p.strip()), text)
    # "먼저 작성 — " 같은 프리앰블 제거
    text = re.sub(r'^먼저\s+작성\s*—?\s*', '', text)
    # 콜론 뒤 내용이 너무 길면 콜론까지만
    if ':' in text and len(text) > max_len:
        text = text[:text.index(':') + 1].strip()
    if len(text) > max_len:
        text = text[:max_len].rstrip() + "…"
    return text


def _count_file_actions(text: str) -> str:
    """result_note에서 파일 생성/수정/테스트 수 추출."""
    created = len(re.findall(r'생성 시도|신규', text))
    modified = len(re.findall(r'변경 시도|수정', text))
    tests = len(re.findall(r'테스트 추가|test', text, re.IGNORECASE))
    parts = []
    if created:
        parts.append(f"생성 {created}")
    if modified:
        parts.append(f"수정 {modified}")
    if tests:
        parts.append(f"테스트 {tests}")
    return ", ".join(parts) if parts else ""


_KNOWN_ERRORS = {
    "timed out": "타임아웃",
    "timeout": "타임아웃",
    "not in whitelist": "화이트리스트 미등록",
    "blocked": "차단됨",
    "connection refused": "연결 거부",
    "rate limit": "속도 제한",
    "no such file": "파일 없음",
    "permission denied": "권한 없음",
}


def _translate_error(text: str) -> str:
    """흔한 영문 에러를 한국어로 번역."""
    low = text.lower()
    for eng, kor in _KNOWN_ERRORS.items():
        if eng in low:
            # 모델명은 보존, 에러만 번역
            model_match = re.match(r'^([\w/:\-\.]+):\s*', text)
            model = model_match.group(1) if model_match else ""
            return f"{model} {kor}".strip() if model else kor
    return text[:100]


def parse_result_note(result_note: str, status: str = "done") -> str:
    """result_note를 읽기 쉬운 한국어 요약으로 변환."""
    if not result_note:
        return "결과 없음"

    note = result_note.strip()

    # --- 실패: 에러 메시지 간결 번역 ---
    if status == "failed":
        return _translate_error(note)

    lines = []

    # --- 구조화 섹션 파싱 ---
    sections_found = False

    for tag, emoji, label in [
        ("액션", "🔧", "실행"),
        ("분석", "📊", "분석"),
        ("판단", "💡", "판단"),
        ("현황", "📈", "현황"),
        ("권고", "📋", "권고"),
    ]:
        match = re.search(
            rf'\[{tag}\]\s*(.*?)(?=\[(?:액션|분석|판단|현황|권고)\]|$)',
            note, re.DOTALL,
        )
        if not match:
            continue
        sections_found = True
        raw = match.group(1).strip()

        # [분석] JSON 특수 처리
        if tag == "분석" and raw.startswith('{'):
            try:
                data = json.loads(raw)
                parts = []
                if 'status' in data:
                    s = data['status']
                    parts.append("정상" if s == 'ok' else s)
                if 'passed' in data:
                    parts.append(f"통과 {data['passed']}건")
                if 'issues' in data:
                    issues = data['issues']
                    if issues:
                        parts.append(f"이슈 {len(issues)}건")
                if 'notes_total' in data:
                    parts.append(f"노트 {data['notes_total']}개")
                if parts:
                    lines.append(f"{emoji} {label}: {' / '.join(parts)}")
                continue
            except (json.JSONDecodeError, TypeError):
                pass

        # 파일 액션 요약
        file_actions = _count_file_actions(raw) if tag == "액션" else ""
        summary = _clean_sentence(raw)
        if file_actions:
            lines.append(f"{emoji} {label}: {summary}")
            lines.append(f"   파일: {file_actions}")
        else:
            lines.append(f"{emoji} {label}: {summary}")

    # --- 비구조화: 핵심 추출 ---
    if not sections_found:
        # "한줄 알림" 또는 "요약:" 패턴 우선
        oneliner = re.search(
            r'(?:한줄\s*알림|요약)\s*[:\-—]\s*(.+?)(?:\n|$)', note,
        )
        if oneliner:
            lines.append(_clean_sentence(oneliner.group(1), 120))
        else:
            # 파일 액션이 있으면 카운트
            file_actions = _count_file_actions(note)
            first = _clean_sentence(note, 100)
            lines.append(first)
            if file_actions:
                lines.append(f"   파일: {file_actions}")

    result = "\n".join(lines)
    if len(result) > 400:
        result = result[:400].rstrip() + "…"
    return result


def _format_time(completed_at: str) -> str:
    """DB 시각을 간결 포맷(HH:MM)으로."""
    if not completed_at:
        return "?"
    try:
        dt = datetime.strptime(completed_at, "%Y-%m-%d %H:%M:%S")
        return dt.strftime("%H:%M")
    except ValueError:
        return completed_at[-8:-3] if len(completed_at) >= 8 else completed_at


_AGENT_EMOJI = {
    "ron": "🎯", "codex": "💻", "cowork": "🏗️",
    "guardian": "🛡️", "data-analyst": "📊",
}


def check_and_notify():
    if not DB_PATH.exists():
        print("❌ DB 없음")
        return

    conn = sqlite3.connect(str(DB_PATH))
    cursor = conn.cursor()

    try:
        cursor.execute("SELECT notify_flag FROM bus_commands LIMIT 1")
    except Exception:
        cursor.execute(
            "ALTER TABLE bus_commands ADD COLUMN notify_flag INTEGER DEFAULT 0"
        )
        conn.commit()

    cursor.execute("""
        SELECT id, title, target_agent, result_note, completed_at, status
        FROM bus_commands
        WHERE status IN ('done', 'failed')
          AND notify_flag = 0
          AND result_note IS NOT NULL
          AND result_note != ''
        ORDER BY completed_at DESC
        LIMIT 10
    """)

    rows = cursor.fetchall()

    if not rows:
        print(f"[{datetime.now().strftime('%H:%M:%S')}] 알림 필요 태스크 없음")
        conn.close()
        return

    print(f"[{datetime.now().strftime('%H:%M:%S')}] {len(rows)}개 태스크 알림...")

    # 인프라 실패 패턴 — 에이전트가 해결 불가한 LLM/네트워크 장애
    _INFRA_FAIL_KW = ("timed out", "timeout", "empty_response", "cooldown",
                       "connection refused", "econnrefused")

    # 태스크를 하나의 메시지로 묶기 (최대 3000자)
    blocks = []
    notified_ids = []

    for row in rows:
        task_id, title, agent, result_note, completed_at, status = row

        # 인프라 실패는 알림 스킵 (notify_flag만 마킹하여 재전송 방지)
        if status == "failed" and any(k in (result_note or "").lower() for k in _INFRA_FAIL_KW):
            notified_ids.append(task_id)
            continue

        emoji = _AGENT_EMOJI.get(agent, "📌")
        st = "✅" if status == "done" else "❌"
        time_str = _format_time(completed_at)
        title_short = title[:50] + "…" if len(title) > 50 else title
        parsed = parse_result_note(result_note, status)

        block = f"{st} {emoji} {title_short}\n{parsed}\n⏰ {time_str}"
        blocks.append(block)
        notified_ids.append(task_id)

    # 인프라 실패만이면 알림 없이 notify_flag만 마킹
    if not blocks and notified_ids:
        for tid in notified_ids:
            cursor.execute("UPDATE bus_commands SET notify_flag = 1 WHERE id = ?", (tid,))
        conn.commit()
        print(f"  ⏭ {len(notified_ids)}건 인프라 실패 — 알림 스킵")
        conn.close()
        return

    # 메시지 조립
    header = f"📋 크론 결과 ({len(blocks)}건)"
    body = "\n\n".join(blocks)
    message = f"{header}\n{'─' * 20}\n\n{body}"

    if len(message) > 3500:
        message = message[:3500] + "\n\n… (일부 생략)"

    if send_telegram(message):
        for tid in notified_ids:
            cursor.execute(
                "UPDATE bus_commands SET notify_flag = 1 WHERE id = ?",
                (tid,),
            )
        conn.commit()
        print(f"  ✅ {len(notified_ids)}건 전송 완료")
    else:
        print("  ❌ 전송 실패")

    conn.close()


if __name__ == "__main__":
    import time
    
    print("="*50)
    print("🚀 Task Notifier 시작 (읽기 쉬운 포맷)")
    print("="*50)
    
    check_and_notify()
    
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "--daemon":
        while True:
            time.sleep(30)
            check_and_notify()
