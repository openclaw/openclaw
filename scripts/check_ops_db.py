#!/usr/bin/env python3
"""
check_ops_db.py

무결성 검사 및 안전 복구 도구 (강화판)
- DB 기본 경로: /Users/ron/.openclaw/workspace/ops_multiagent.db (환경변수 CHECK_OPS_DB 또는 --db로 재정의 가능)
- 주요 검사: 스키마, FK, 상태 일관성, 중복, 연속 실패 카운터
- 리포트: logs/check_ops_db_report_<ts>.txt
- ops_todos에 자동 레코드 추가(검사 결과 요약, 실패 시 best-effort)

추가 기능:
- --stub : 단명 테스트 DB를 만들어 검사 로직을 실행하는 스텁(검증용)
- 개선된 예외/로깅, 일관된 exit code

Usage:
  python3 check_ops_db.py [--apply] [--approve-recovery] [--db /path/to/db] [--stub]

Exit codes:
  0 - 문제 없음
  1 - 문제 발견 (수동 조치 필요)
  2 - 실행 중 예외(치명적)
  3 - 자동 복구 실행됨
  4 - 복구 필요하지만 승인 없음

Cron 설치 시 권장:
- 실행권한 추가: chmod +x scripts/check_ops_db.py
- shebang는 파일 상단에 이미 존재합니다
- cron 예: 0 * * * * /Users/ron/.openclaw/workspace/scripts/check_ops_db.py --apply --approve-recovery >> /Users/ron/.openclaw/workspace/logs/check_ops_db.cron.log 2>&1

검증 명령 예시:
  python3 /Users/ron/.openclaw/workspace/scripts/check_ops_db.py --stub
  sqlite3 /Users/ron/.openclaw/workspace/ops_multiagent.db "SELECT COUNT(*) FROM bus_commands;"

"""

import sqlite3
import sys
import os
import argparse
import datetime
import traceback
import tempfile
import stat
from typing import List, Tuple

# Paths and constants
DEFAULT_DB_PATH = os.environ.get('CHECK_OPS_DB', '/Users/ron/.openclaw/workspace/ops_multiagent.db')
LOG_DIR = '/Users/ron/.openclaw/workspace/logs'
if not os.path.exists(LOG_DIR):
    os.makedirs(LOG_DIR, exist_ok=True)

REPORT_TS = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
REPORT_PATH = os.path.join(LOG_DIR, f'check_ops_db_report_{REPORT_TS}.txt')

# Exit codes (team standard: 0=OK, 1=Issues, 2=Fatal)
EXIT_OK = 0
# Any non-fatal issue (including recovered or awaiting approval) returns 1
EXIT_ISSUES = 1
# Fatal/unhandled exceptions return 2
EXIT_FATAL = 2


def write_report(lines: List[str]):
    try:
        with open(REPORT_PATH, 'w') as f:
            f.write('\n'.join(lines))
    except Exception:
        # best-effort: print to stdout if file write fails
        print('WARN: failed to write report file', REPORT_PATH)


def insert_ops_todos_summary(conn: sqlite3.Connection, summary_title: str, summary_body: str) -> Tuple[bool,str]:
    try:
        cur = conn.cursor()
        cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='ops_todos'")
        if not cur.fetchone():
            return False, 'ops_todos table not found'
        now = datetime.datetime.utcnow().isoformat() + 'Z'
        cur.execute(
            "INSERT INTO ops_todos (title, detail, status, created_at) VALUES (?,?,?,?)",
            (summary_title, summary_body, 'todo', now)
        )
        conn.commit()
        return True, 'inserted'
    except Exception as e:
        return False, str(e)


def check_schema(conn: sqlite3.Connection, out: List[str]) -> List[str]:
    expected = {
        'bus_commands': ['id','agent','payload','status','created_at','updated_at','attempts','consecutive_errors'],
        'ops_todos': ['id','title','detail','status','created_at']
    }
    cur = conn.cursor()
    cur.execute("SELECT name FROM sqlite_master WHERE type='table'")
    tables = [r[0] for r in cur.fetchall()]
    issues = []
    for t, cols in expected.items():
        if t not in tables:
            issues.append(f'MISSING TABLE: {t}')
            continue
        cur.execute(f"PRAGMA table_info({t})")
        present = [row[1] for row in cur.fetchall()]
        missing = [c for c in cols if c not in present]
        if missing:
            issues.append(f'TABLE {t} missing columns: {missing}')
    out.append('Schema check: ' + (', '.join(issues) if issues else 'OK'))
    return issues


def check_foreign_keys(conn: sqlite3.Connection, out: List[str]) -> List[Tuple]:
    cur = conn.cursor()
    try:
        cur.execute('PRAGMA foreign_keys = ON')
        cur.execute("PRAGMA foreign_key_check")
        fk_issues = cur.fetchall()
        if fk_issues:
            out.append('Foreign key check: FOUND issues')
            for r in fk_issues:
                out.append(str(r))
        else:
            out.append('Foreign key check: OK')
        return fk_issues
    except sqlite3.DatabaseError as e:
        out.append('Foreign key check skipped: ' + str(e))
        return []


def _parse_iso_or_none(s: str):
    if not s:
        return None
    try:
        return datetime.datetime.fromisoformat(s.replace('Z',''))
    except Exception:
        try:
            # fallback: try common formats
            return datetime.datetime.strptime(s, '%Y-%m-%d %H:%M:%S')
        except Exception:
            return None


def check_state_consistency(conn: sqlite3.Connection, out: List[str]):
    cur = conn.cursor()
    issues = []

    try:
        cur.execute("SELECT COUNT(*) FROM bus_commands")
        total = cur.fetchone()[0]
    except Exception as e:
        out.append('ERROR reading bus_commands count: ' + str(e))
        return ['could not read bus_commands'], []

    out.append(f'bus_commands total rows: {total}')

    # duplicate ids
    try:
        cur.execute("SELECT id, COUNT(*) FROM bus_commands GROUP BY id HAVING COUNT(*)>1")
        dup_ids = cur.fetchall()
        if dup_ids:
            issues.append(f'duplicate ids: {dup_ids}')
    except Exception as e:
        out.append('ERROR checking duplicates: ' + str(e))

    # stuck entries: queued/claimed > 30m
    stuck = []
    try:
        cur.execute("SELECT id, status, created_at, updated_at FROM bus_commands WHERE status IN ('queued','claimed')")
        now = datetime.datetime.utcnow()
        for row in cur.fetchall():
            id_, status, created_at, updated_at = row
            tstr = updated_at or created_at
            t = _parse_iso_or_none(tstr)
            if not t:
                continue
            delta = now - t
            if delta.total_seconds() > 1800:
                stuck.append((id_, status, tstr, int(delta.total_seconds())))
    except Exception as e:
        out.append('ERROR checking stuck entries: ' + str(e))

    if stuck:
        issues.append(f'stuck entries (>30m): count={len(stuck)} sample={stuck[:5]}')
        out.append('Stuck sample: ' + str(stuck[:10]))
    else:
        out.append('No stuck queued/claimed entries (>30m)')

    # consecutive_errors sanity
    try:
        cur.execute("SELECT id, consecutive_errors FROM bus_commands WHERE consecutive_errors IS NOT NULL AND consecutive_errors<0")
        neg = cur.fetchall()
        if neg:
            issues.append(f'negative consecutive_errors: {neg}')
        cur.execute("SELECT COUNT(*) FROM bus_commands WHERE consecutive_errors>100")
        high = cur.fetchone()[0]
        if high>0:
            issues.append(f'{high} rows with consecutive_errors>100')
    except Exception as e:
        out.append('ERROR checking consecutive_errors: ' + str(e))

    out.append('State checks done')
    return issues, stuck


def attempt_autorepair(conn: sqlite3.Connection, stuck, issues, approve_recovery, out: List[str]):
    cur = conn.cursor()
    actions = []
    if not stuck:
        return actions
    if not approve_recovery:
        return actions
    for ent in stuck:
        id_, status, tstr, secs = ent
        try:
            cur.execute("UPDATE bus_commands SET status=?, updated_at=? WHERE id=?", ('error', datetime.datetime.utcnow().isoformat()+'Z', id_))
            actions.append(f'set id={id_} {status}->error (stuck {secs}s)')
        except Exception as e:
            out.append(f'Failed to update id={id_}: {e}')
    conn.commit()
    return actions


def create_stub_db(path: str):
    conn = sqlite3.connect(path)
    cur = conn.cursor()
    cur.execute('''CREATE TABLE IF NOT EXISTS bus_commands (
                   id TEXT PRIMARY KEY, agent TEXT, payload TEXT, status TEXT, created_at TEXT, updated_at TEXT, attempts INTEGER DEFAULT 0, consecutive_errors INTEGER DEFAULT 0)
                ''')
    cur.execute('''CREATE TABLE IF NOT EXISTS ops_todos (
                   id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, detail TEXT, status TEXT, created_at TEXT)
                ''')
    # insert a stuck row and a healthy row
    now = (datetime.datetime.utcnow() - datetime.timedelta(hours=1)).isoformat() + 'Z'
    cur.execute("INSERT OR REPLACE INTO bus_commands (id, agent, payload, status, created_at, updated_at, attempts, consecutive_errors) VALUES (?,?,?,?,?,?,?,?)",
                ('stuck-1','agent-x','{}','queued', now, now, 1, 0))
    cur.execute("INSERT OR REPLACE INTO bus_commands (id, agent, payload, status, created_at, updated_at, attempts, consecutive_errors) VALUES (?,?,?,?,?,?,?,?)",
                ('ok-1','agent-y','{}','done', datetime.datetime.utcnow().isoformat()+'Z', None, 1, 0))
    conn.commit()
    conn.close()


def main():
    parser = argparse.ArgumentParser(description='ops_multiagent.db integrity checker (safe)')
    parser.add_argument('--apply', action='store_true', help='Attempt safe repairs when --approve-recovery provided')
    parser.add_argument('--approve-recovery', action='store_true', help='Approve automatic recovery actions')
    parser.add_argument('--db', type=str, default=DEFAULT_DB_PATH, help='Path to sqlite DB')
    parser.add_argument('--stub', action='store_true', help='Create and run against a temporary stub DB for verification')
    args = parser.parse_args()

    report_lines: List[str] = []
    problems_found = False
    recovered = False

    db_path = args.db
    temp_db = None
    try:
        if args.stub:
            td = tempfile.NamedTemporaryFile(prefix='check_ops_db_stub_', suffix='.db', delete=False)
            temp_db = td.name
            td.close()
            create_stub_db(temp_db)
            db_path = temp_db
            report_lines.append(f'STUB DB created at {temp_db}')

        if not os.path.exists(db_path):
            report_lines.append(f'DB not found at {db_path}')
            write_report(report_lines)
            print('\n'.join(report_lines))
            return EXIT_FATAL

        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row

        report_lines.append(f'Check run at {datetime.datetime.utcnow().isoformat()}Z against {db_path}')

        schema_issues = check_schema(conn, report_lines)
        if schema_issues:
            problems_found = True

        fk_issues = check_foreign_keys(conn, report_lines)
        if fk_issues:
            problems_found = True

        state_issues, stuck = check_state_consistency(conn, report_lines)
        if state_issues:
            problems_found = True
            report_lines.append('State issues:')
            report_lines.extend(state_issues)

        repair_actions = []
        if args.apply:
            if stuck:
                if args.approve_recovery:
                    repair_actions = attempt_autorepair(conn, stuck, state_issues, True, report_lines)
                    if repair_actions:
                        recovered = True
                        report_lines.append('Autorepair actions:')
                        report_lines.extend(repair_actions)
                else:
                    report_lines.append('Stuck entries found but --approve-recovery not provided')

        summary_title = 'ops_multiagent.db 무결성 검사 결과 ' + ('OK' if not problems_found else 'Issues found')
        summary_body = '\n'.join(report_lines[:2000])
        inserted, msg = insert_ops_todos_summary(conn, summary_title, summary_body)
        report_lines.append(f'ops_todos insert: {inserted} / {msg}')

        write_report(report_lines)
        print('\n'.join(report_lines))

        # return codes
        if recovered:
            return EXIT_RECOVERED
        if problems_found:
            if args.apply and stuck and not args.approve_recovery:
                return EXIT_NO_APPROVAL
            return EXIT_ISSUES
        return EXIT_OK

    except Exception as e:
        tb = traceback.format_exc()
        print('FATAL ERROR', e)
        print(tb)
        with open(REPORT_PATH, 'w') as f:
            f.write('FATAL ERROR:\n')
            f.write(str(e) + '\n')
            f.write(tb)
        return EXIT_FATAL
    finally:
        if temp_db and os.path.exists(temp_db):
            try:
                # keep stub for inspection, but set permissive perms so user can inspect
                os.chmod(temp_db, stat.S_IRUSR | stat.S_IWUSR | stat.S_IRGRP | stat.S_IROTH)
                report_lines.append(f'Stub DB preserved at {temp_db}')
            except Exception:
                pass


if __name__ == '__main__':
    rc = main()
    sys.exit(rc)

