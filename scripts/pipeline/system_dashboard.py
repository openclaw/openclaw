#!/usr/bin/env python3
"""system_dashboard.py — 론-클로드코드-옵시디언 통합 대시보드

볼트 내 `300 운영/340 리포트/system-dashboard.md`에 시스템 현황 자동 생성.

Usage:
    python3 system_dashboard.py              # 대시보드 생성 (볼트에 저장)
    python3 system_dashboard.py --notify     # 생성 + 텔레그램 DM
    python3 system_dashboard.py --dry-run    # 콘솔 출력만
"""

import argparse, os, subprocess, sys, urllib.error, urllib.parse, urllib.request
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from shared.db import db_connection
from shared.log import make_logger
from shared.frontmatter import write_note, render_frontmatter

# ── Paths ──
from shared.vault_paths import (
    VAULT as VAULT_ROOT, REPORTS, INBOX, EXECUTION,
    NOTES, AREAS, STRUCTURE, INSIGHTS,
)

WORKSPACE = Path(os.path.expanduser("~/.openclaw/workspace"))
OUTPUT_FILE = REPORTS / "system-dashboard.md"
LOG_FILE = WORKSPACE / "logs" / "system_dashboard.log"
OPS_DB = Path(os.path.expanduser("~/.openclaw/data/ops_multiagent.db"))
MEMORY_DIR = WORKSPACE / "memory"

# ── Telegram ──
DM_CHAT_ID = "492860021"
BOT_TOKEN = "8554125313:AAGC5Zzb9nCbPYgmOVqs3pVn-qzIA2oOtkI"

log = make_logger(log_file=str(LOG_FILE))

# ── v3 흐름 단계 (논리 → 물리) ──
V3_STAGES = [
    ("100 캡처", INBOX),
    ("200 정리", NOTES),

    ("300 연결", STRUCTURE),
    ("400 판단", INSIGHTS),
    ("800 실행", EXECUTION),
]

MEMORY_NAMES = [
    "filtered-ideas", "hypotheses", "knowledge-connections",
    "market-indicators", "geopolitical", "shipbuilding-indicators",
    "popular-posts/reports", "twitter-collector/reports",
    "blog-insights", "choi-reports", "experiment-results",
]


# ── 유틸 ──

def _count_md(folder, max_age_days=None):
    """폴더 내 .md 파일 수 (archives 제외, 선택적 기간 필터)."""
    if not folder.exists():
        return 0
    cutoff = (datetime.now() - timedelta(days=max_age_days)) if max_age_days else None
    n = 0
    for f in folder.rglob("*.md"):
        if "archives" in f.parts:
            continue
        if cutoff and datetime.fromtimestamp(f.stat().st_mtime) < cutoff:
            continue
        n += 1
    return n


def _count_recent(folder, days=1):
    """폴더 내 최근 N일 수정 파일 수."""
    if not folder.exists():
        return 0
    cutoff = datetime.now() - timedelta(days=days)
    return sum(
        1 for f in folder.rglob("*")
        if f.is_file() and datetime.fromtimestamp(f.stat().st_mtime) >= cutoff
    )


def _bar(value, max_val, width=20):
    filled = min(int((value / max_val) * width), width) if max_val > 0 else 0
    return "█" * filled + "░" * (width - filled)


# ── 데이터 수집 ──

def _check_gateway():
    try:
        urllib.request.urlopen("http://localhost:18789/", timeout=3)
        return True
    except urllib.error.HTTPError:
        return True  # 404 = 살아있음
    except Exception:
        return False


def _check_workers():
    try:
        r = subprocess.run(["pgrep", "-f", "agent_queue_worker"],
                           capture_output=True, text=True, timeout=5)
        return len(r.stdout.strip().split("\n")) if r.stdout.strip() else 0
    except Exception:
        return -1


def _query_db():
    """DB에서 할일/실패/에이전트 활동 조회."""
    todos, failed, agents = {}, [], []
    try:
        with db_connection(str(OPS_DB)) as conn:
            for row in conn.execute(
                "SELECT priority, COUNT(*) FROM ops_todos "
                "WHERE status IN ('todo','doing') GROUP BY priority"
            ).fetchall():
                todos[row[0]] = row[1]
    except Exception as e:
        log(f"DB todos error: {e}", level="ERROR")

    try:
        with db_connection(str(OPS_DB)) as conn:
            failed = conn.execute(
                "SELECT target_agent, substr(title,1,80), created_at "
                "FROM bus_commands WHERE status='failed' "
                "AND created_at > datetime('now','-1 day') "
                "ORDER BY created_at DESC LIMIT 5"
            ).fetchall()
    except Exception as e:
        log(f"DB bus_commands error: {e}", level="ERROR")

    try:
        with db_connection(str(OPS_DB)) as conn:
            agents = conn.execute(
                "SELECT agent, COUNT(*) FROM ops_agent_memory "
                "WHERE created_at > datetime('now','-7 days') "
                "GROUP BY agent ORDER BY 2 DESC"
            ).fetchall()
    except Exception as e:
        log(f"DB agent_memory error: {e}", level="ERROR")

    return todos, failed, agents


# ── 대시보드 생성 ──

def generate():
    now = datetime.now()
    gw = _check_gateway()
    wk = _check_workers()
    todos, failed, agents = _query_db()

    # 파이프라인 메모리 갱신 현황
    mem_24h = {d: _count_recent(MEMORY_DIR / d, 1) for d in MEMORY_NAMES}

    # v3 흐름 단계별
    flow = {name: _count_md(path) for name, path in V3_STAGES}
    max_flow = max(flow.values()) if flow else 1

    # 볼트 통계
    total = _count_md(VAULT_ROOT)
    moc_dir = AREAS
    mocs = len(list(moc_dir.rglob("MOC-*.md"))) if moc_dir.exists() else 0
    inbox_7d = _count_md(V3_STAGES[0][1], max_age_days=7)
    mem_7d = sum(_count_recent(MEMORY_DIR / d, 7) for d in MEMORY_NAMES)

    # Claude Code
    cmd_dir = Path(os.path.expanduser("~/.claude/commands"))
    cmds = sorted(f.stem for f in cmd_dir.glob("*.md")) if cmd_dir.exists() else []

    # ── 병목 분석 ──
    bottlenecks = []
    names = list(flow.keys())
    vals = list(flow.values())
    for i in range(len(names) - 1):
        c, n = vals[i], vals[i + 1]
        if c > 20 and n > 0 and n / c < 0.15:
            bottlenecks.append(
                f"{names[i]}({c}) → {names[i+1]}({n}) — 전환율 {n/c*100:.0f}%"
            )
        if n > c * 3 and n > 20:
            bottlenecks.append(f"{names[i+1]}({n}) >> {names[i]}({c}) — 역전 적체")

    # 건강 판정
    if not gw or wk < 5 or len(failed) > 3:
        health = "🔴 경고"
    elif bottlenecks or todos.get("urgent", 0) > 5:
        health = "🟡 주의"
    else:
        health = "🟢 정상"

    # ── 마크다운 조립 ──
    L = []  # lines

    L.append("")
    L.append(f"> 자동 생성: {now.strftime('%Y-%m-%d %H:%M')} KST")
    L.append("")

    # OpenClaw
    L.append("## OpenClaw (자동화)")
    L.append("")
    L.append(f"- **Gateway**: {'🟢 가동' if gw else '🔴 중단'} (port 18789)")
    L.append(f"- **워커**: {wk}/5 활성")
    L.append(f"- **크론 실패 (24h)**: {len(failed)}건")
    for ag, cmd, ts in failed:
        L.append(f"  - `{ag}`: {cmd} ({ts})")
    todo_str = " / ".join(f"{p} {c}" for p, c in
                          [(p, todos[p]) for p in ("urgent", "high", "normal", "low") if p in todos])
    L.append(f"- **할일**: {todo_str or '없음'} (총 {sum(todos.values())}건)")
    L.append(f"- **메모리 갱신 (24h)**:")
    active = [(d, c) for d, c in mem_24h.items() if c > 0]
    if active:
        for d, c in active:
            L.append(f"  · {d}: {c}건")
    else:
        L.append("  · 없음")
    inactive = [d for d, c in mem_24h.items() if c == 0]
    if inactive:
        L.append(f"  · 미갱신: {', '.join(inactive)}")
    L.append(f"- **에이전트 활동 (7일)**:")
    for ag, cnt in agents[:6]:
        L.append(f"  · {ag}: {cnt}건")

    # Claude Code
    L.append("")
    L.append("## Claude Code (대화)")
    L.append("")
    L.append(f"- **커맨드**: {len(cmds)}개 — {', '.join(f'/{c}' for c in cmds)}")
    claude_md = Path(os.path.expanduser("~/.claude/projects/-Users-ron/CLAUDE.md"))
    L.append(f"- **CLAUDE.md**: {'✅' if claude_md.exists() else '❌'}")

    # Obsidian
    L.append("")
    L.append("## Obsidian 볼트 (지식)")
    L.append("")
    L.append(f"- **전체**: {total}개 노트 | **MOC**: {mocs}개")
    L.append("")
    L.append("### v3 지식 흐름 (번호 = 성숙도)")
    L.append("")
    L.append("```")
    for name, _ in V3_STAGES:
        c = flow[name]
        L.append(f"  {name:<10} {_bar(c, max_flow)}  {c}개")
    L.append("```")
    L.append("")
    is_funnel = all(vals[i] >= vals[i + 1] for i in range(len(vals) - 1))
    L.append(f"> {'✅ 건강한 깔때기형' if is_funnel else '⚠️ 깔때기형 아님 — 흐름 역전 감지'}")

    if bottlenecks:
        L.append("")
        L.append("### 병목")
        L.append("")
        for b in bottlenecks:
            L.append(f"- ⚠️ {b}")

    # 데이터 흐름
    L.append("")
    L.append("## 데이터 흐름")
    L.append("")
    L.append(f"- OpenClaw → memory/: 7일 **{mem_7d}건** 출력")
    L.append(f"- OpenClaw → 수신함: 7일 **{inbox_7d}건** 입력")
    L.append("")
    L.append("```")
    L.append(f"  ┌──────────┐  memory/{mem_7d}건  ┌──────────┐  v3 흐름  ┌──────────┐")
    L.append(f"  │ OpenClaw │ ─────────→ │  Claude  │ ──읽기─→ │ Obsidian │")
    L.append(f"  │ 18 파이프 │             │   Code   │           │  볼트    │")
    L.append(f"  │ 5 에이전트│ ─수신함{inbox_7d:>2}→ │ {len(cmds):>2} 커맨드  │ ←─읽기─ │ {total:>3} 노트  │")
    L.append(f"  └──────────┘             └──────────┘           └──────────┘")
    L.append("```")

    # 종합
    L.append("")
    L.append("## 종합 판단")
    L.append("")
    L.append(f"- **건강**: {health}")
    issues = []
    if todos.get("urgent", 0) > 0:
        issues.append(f"urgent 할일 {todos['urgent']}건")
    if not gw:
        issues.append("Gateway 중단")
    if wk < 5:
        issues.append(f"워커 {wk}/5")
    if failed:
        issues.append(f"크론 실패 {len(failed)}건")
    issues.extend(bottlenecks)
    if issues:
        L.append("- **이슈**:")
        for iss in issues:
            L.append(f"  - {iss}")
    else:
        L.append("- **이슈**: 없음")

    meta = {
        "title": "시스템 대시보드",
        "date": now.strftime("%Y-%m-%d"),
        "tags": ["system", "dashboard", "auto-generated"],
    }
    return meta, "\n".join(L)


def _send_dm(text):
    try:
        url = (
            f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage?"
            f"chat_id={DM_CHAT_ID}"
            f"&text={urllib.parse.quote(text)}&parse_mode=HTML"
        )
        urllib.request.urlopen(url, timeout=10)
        log("DM sent")
    except Exception as e:
        log(f"DM failed: {e}", level="ERROR")


def main():
    ap = argparse.ArgumentParser(description="시스템 통합 대시보드")
    ap.add_argument("--notify", action="store_true", help="텔레그램 DM")
    ap.add_argument("--dry-run", action="store_true", help="콘솔 출력만")
    args = ap.parse_args()

    log("=== system_dashboard start ===")
    meta, body = generate()

    if args.dry_run:
        print(render_frontmatter(meta))
        print(body)
        log("dry-run done")
        return

    write_note(str(OUTPUT_FILE), meta, body)
    log(f"saved → {OUTPUT_FILE}")

    if args.notify:
        # 컴팩트 DM
        dm = "<b>📊 시스템 대시보드</b>\n"
        dm += f"<i>{datetime.now().strftime('%Y-%m-%d %H:%M')}</i>\n\n"
        for line in body.split("\n"):
            if "**건강**:" in line:
                dm += line.strip().replace("- **", "").replace("**", "") + "\n"
            if "**이슈**:" in line:
                dm += line.strip().replace("- **", "").replace("**", "") + "\n"
        # 흐름 요약
        for name, _ in V3_STAGES:
            dm += f"  {name}: {_count_md(_)}\n"
        _send_dm(dm)

    log("=== system_dashboard done ===")


if __name__ == "__main__":
    main()
