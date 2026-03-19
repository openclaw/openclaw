#!/usr/bin/env python3
"""
Threads 戰場同步 — scan + CRM sync + AI reply + dashboard

Sentinel task: schedule "every 15m"
Uses social-engine for cross-platform CRM.
"""

import json
import subprocess
import sys
import os
from pathlib import Path

SENTINEL_ROOT = Path(__file__).resolve().parent.parent
THREADS_DIR = SENTINEL_ROOT.parent / "workspace" / "tools" / "threads-reply"
ENGINE_DIR = SENTINEL_ROOT.parent / "workspace" / "tools" / "social-engine"

sys.path.insert(0, str(SENTINEL_ROOT))
sys.path.insert(0, str(ENGINE_DIR))
sys.path.insert(0, str(THREADS_DIR))

try:
    from lib.logging_util import setup_logger
    logger = setup_logger("threads_sync")
except ImportError:
    import logging
    logging.basicConfig(level=logging.INFO)
    logger = logging.getLogger("threads_sync")


def run(config: dict, state: dict) -> dict:
    logger.info("=== threads_sync: start ===")

    # L0: Scan via Threads API
    result = subprocess.run(
        [sys.executable, str(THREADS_DIR / "threads_reply.py"), "scan"],
        capture_output=True, text=True, timeout=90,
        cwd=str(THREADS_DIR)
    )
    logger.info(f"Scan: {result.stdout.strip()[-150:]}")

    # L1: Sync to social engine CRM
    try:
        from core.db import init_db
        from core.identity import Identity

        sconn = init_db()
        identity = Identity(sconn)

        import threads_db as tdb
        tconn = tdb.get_conn()

        # Sync new/updated profiles
        rows = tconn.execute('''
            SELECT username, value_tier, stance, engagement_depth, topic_interests, recruitment_signal
            FROM profiles WHERE engagement_depth >= 3 AND username != "tangcruzz"
        ''').fetchall()

        synced = 0
        for r in rows:
            cid = identity.resolve('threads', r['username'])
            if cid:
                sconn.execute('UPDATE contacts SET engagement_depth=MAX(engagement_depth,?), tier=?, stance=? WHERE canonical_id=?',
                              (r['engagement_depth'], r['value_tier'] or 'C', r['stance'] or 'unknown', cid))
            else:
                cid = f"threads:{r['username']}"
                sconn.execute('''INSERT OR IGNORE INTO contacts
                    (canonical_id, display_name, tier, stance, engagement_depth, topics, recruitment_signal)
                    VALUES (?,?,?,?,?,?,?)''',
                    (cid, r['username'], r['value_tier'] or 'C', r['stance'] or 'unknown',
                     r['engagement_depth'] or 0, r['topic_interests'] or '[]', r['recruitment_signal']))
                sconn.execute('INSERT OR IGNORE INTO contact_handles (canonical_id, channel, handle) VALUES (?,?,?)',
                              (cid, 'threads', r['username']))
            synced += 1

        sconn.commit()
        tconn.close()
        sconn.close()
        logger.info(f"CRM sync: {synced} contacts")
    except Exception as e:
        logger.warning(f"CRM sync failed: {e}")
        synced = 0

    # L2: Get unreplied count + coverage
    try:
        tconn = tdb.get_conn()
        sent = tconn.execute('SELECT COUNT(*) as c FROM replies WHERE status="sent"').fetchone()['c']
        total = tconn.execute('SELECT COUNT(DISTINCT c.comment_id) as c FROM comments c JOIN profiles p ON c.user_id=p.user_id WHERE p.username != "tangcruzz"').fetchone()['c']
        unreplied = tconn.execute('''
            SELECT COUNT(*) as c FROM comments c
            LEFT JOIN replies r ON c.comment_id = r.comment_id
            JOIN profiles p ON c.user_id = p.user_id
            WHERE r.reply_id IS NULL AND p.username != "tangcruzz" AND length(c.text_content) > 5
        ''').fetchone()['c']
        tconn.close()
        coverage_pct = round(sent / max(total, 1) * 100)
    except Exception as e:
        logger.warning(f"Coverage calc failed: {e}")
        sent, total, unreplied, coverage_pct = 0, 0, 0, 0

    # L3: Update dashboard data
    try:
        subprocess.run(
            [sys.executable, str(THREADS_DIR / "dashboard_data.py")],
            capture_output=True, text=True, timeout=30,
            cwd=str(THREADS_DIR)
        )
    except Exception as e:
        logger.warning(f"Dashboard update failed: {e}")

    logger.info(f"=== threads_sync: done (synced={synced}, coverage={sent}/{total}={coverage_pct}%, unreplied={unreplied}) ===")
    return {
        "synced": synced,
        "coverage": f"{sent}/{total}",
        "coverage_pct": coverage_pct,
        "unreplied": unreplied,
    }


if __name__ == "__main__":
    print(json.dumps(run({}, {}), indent=2))
