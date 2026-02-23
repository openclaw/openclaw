#!/usr/bin/env python3
"""
Autopilot Sweeper — LLM-free self-healing daemon (v2, 2026-02-19)

5 checks, 60-second cycle via LaunchAgent:
1. Gateway liveness — TCP probe first, restart only if actually dead
2. Worker cascade — pgrep per agent, kickstart if missing
3. Cron stuck — jobs running >20min → mark error
4. Cron consecutive failures — ≥N fails → disable + ops_todo
5. Queue jam — >5 items older than 30min → classify cause

CRITICAL: Never restart Gateway unconditionally. Always probe first.
"""
import fnmatch
import json
import os
import shutil
import socket
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

# ── paths ──────────────────────────────────────────────────────
OPENCLAW_DIR = Path.home() / '.openclaw'
WORKSPACE = OPENCLAW_DIR / 'workspace'
DATA_DIR = OPENCLAW_DIR / 'data'
LOGS_DIR = OPENCLAW_DIR / 'logs'
CRON_JOBS = OPENCLAW_DIR / 'cron' / 'jobs.json'
DB_PATH = DATA_DIR / 'ops_multiagent.db'
SCRIPTS_DIR = WORKSPACE / 'scripts'

sys.path.insert(0, str(SCRIPTS_DIR))
from shared.db import db_connection

STATE_FILE = LOGS_DIR / 'autopilot_sweeper_state.json'
LOG_FILE = LOGS_DIR / 'autopilot_sweeper.log'
PLAYBOOK_FILE = LOGS_DIR / 'autopilot_playbook.jsonl'

GATEWAY_HOST = '127.0.0.1'
GATEWAY_PORT = 18789

# ── env config ─────────────────────────────────────────────────
CRON_ERROR_THRESHOLD = int(os.environ.get('SWEEPER_CRON_ERROR_THRESHOLD', '3'))
GATEWAY_COOLDOWN_SEC = int(os.environ.get('SWEEPER_GATEWAY_COOLDOWN_SEC', '120'))
GATEWAY_MAX_FAILS = 3  # give up after 3 consecutive restart failures
WORKER_COOLDOWN_SEC = 60
CRON_STUCK_MINUTES = 20
QUEUE_JAM_COUNT = 5
QUEUE_JAM_AGE_MINUTES = 30

# ── disk growth monitoring ────────────────────────────────
DISK_SCAN_DIRS = [WORKSPACE / 'memory', WORKSPACE / 'archives', WORKSPACE / 'snapshots',
                   OPENCLAW_DIR / 'logs']  # logs/archives 등 대형 아카이브 감시
TMP_EVIDENCE_DIR = Path('/private/tmp')  # /tmp/evidence_* 폭주 감시
SUBDIR_SIZE_LIMIT_MB = 1000      # alert if subdirectory exceeds 1GB
AUTO_DELETE_PATTERNS = ['evidence_*', 'evidence-*', 'archive_evidence_*', 'recovery-*',
                        'forensic*', 'incident-snapshots']
STALE_REFLECTION_DAYS = 30
DISK_FREE_WARN_GB = 5
DISK_ALERT_CD = 600              # 10-min cooldown between DM alerts
SYSTEM_TODO_EXPIRE_DAYS = 7      # auto-close system todos older than 7 days
_USER_SOURCES = ('telegram', 'claude')

# ── worker mapping ─────────────────────────────────────────────
WORKER_PLIST_MAP = {
    'ron': 'com.openclaw.agent-queue-ron',
    'codex': 'com.openclaw.agent-queue-codex',
    'cowork': 'com.openclaw.agent-queue-cowork',
    'guardian': 'com.openclaw.agent-queue-guardian',
    'data-analyst': 'com.openclaw.agent-queue-analyst',
}

# ── state management ───────────────────────────────────────────
def load_state():
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text())
        except (json.JSONDecodeError, OSError):
            pass
    return {
        'gateway_fail_streak': 0,
        'worker_last_fix_ts': {},
        'disabled_crons': [],
        'last_run': None,
    }


def save_state(state):
    state['last_run'] = datetime.now(timezone.utc).isoformat()
    tmp = STATE_FILE.with_suffix('.tmp')
    tmp.write_text(json.dumps(state, indent=2))
    tmp.rename(STATE_FILE)


# ── logging ────────────────────────────────────────────────────
def log(msg):
    ts = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    line = f"[{ts}] {msg}"
    print(line)
    try:
        with open(LOG_FILE, 'a') as f:
            f.write(line + '\n')
        # rotate if >10MB
        if LOG_FILE.stat().st_size > 10 * 1024 * 1024:
            rotated = LOG_FILE.with_suffix('.log.1')
            if rotated.exists():
                rotated.unlink()
            LOG_FILE.rename(rotated)
    except OSError:
        pass


def playbook_entry(check, action, detail):
    entry = {
        'ts': datetime.now(timezone.utc).isoformat(),
        'check': check,
        'action': action,
        'detail': detail,
    }
    try:
        with open(PLAYBOOK_FILE, 'a') as f:
            f.write(json.dumps(entry) + '\n')
        # rotate if >10MB
        if PLAYBOOK_FILE.stat().st_size > 10 * 1024 * 1024:
            rotated = PLAYBOOK_FILE.with_suffix('.jsonl.1')
            if rotated.exists():
                rotated.unlink()
            PLAYBOOK_FILE.rename(rotated)
    except OSError:
        pass


# ── check 1: Gateway liveness ─────────────────────────────────
def check_gateway(state):
    """Probe Gateway TCP port. Only restart if actually unreachable."""
    # TCP probe
    alive = False
    try:
        with socket.create_connection((GATEWAY_HOST, GATEWAY_PORT), timeout=5):
            alive = True
    except (ConnectionRefusedError, OSError, TimeoutError):
        pass

    if alive:
        if state.get('gateway_fail_streak', 0) > 0:
            log(f"Gateway: recovered (was fail_streak={state.get('gateway_fail_streak', 0)})")
            state['gateway_fail_streak'] = 0
        else:
            log("Gateway: OK")
        return

    # Gateway is down
    streak = state.get('gateway_fail_streak', 0)
    if streak >= GATEWAY_MAX_FAILS:
        log(f"Gateway: DOWN but gave up after {GATEWAY_MAX_FAILS} consecutive failures")
        playbook_entry('gateway', 'gave_up', f'streak={streak}')
        return

    # Check cooldown
    last_fix = state.get('gateway_last_fix_ts', 0)
    now = time.time()
    if now - last_fix < GATEWAY_COOLDOWN_SEC:
        remaining = int(GATEWAY_COOLDOWN_SEC - (now - last_fix))
        log(f"Gateway: DOWN, cooldown {remaining}s remaining")
        return

    # Attempt restart
    log(f"Gateway: DOWN — attempting restart (attempt {streak + 1}/{GATEWAY_MAX_FAILS})")
    try:
        proc = subprocess.run(
            ['launchctl', 'kickstart', '-k', f'gui/{os.getuid()}/ai.openclaw.gateway'],
            capture_output=True, text=True, timeout=30
        )
        if proc.returncode == 0:
            log("Gateway: kickstart issued, waiting for startup...")
            time.sleep(5)
            # Verify
            try:
                with socket.create_connection((GATEWAY_HOST, GATEWAY_PORT), timeout=5):
                    log("Gateway: RESTORED successfully")
                    state['gateway_fail_streak'] = 0
                    state['gateway_last_fix_ts'] = time.time()
                    playbook_entry('gateway', 'restored', f'attempt={streak + 1}')
                    return
            except (ConnectionRefusedError, OSError, TimeoutError):
                pass

        state['gateway_fail_streak'] = streak + 1
        state['gateway_last_fix_ts'] = time.time()
        log(f"Gateway: restart failed (streak={state['gateway_fail_streak']})")
        playbook_entry('gateway', 'restart_failed', f'streak={state["gateway_fail_streak"]}')

    except subprocess.TimeoutExpired:
        state['gateway_fail_streak'] = streak + 1
        state['gateway_last_fix_ts'] = time.time()
        log("Gateway: restart timed out")
        playbook_entry('gateway', 'restart_timeout', f'streak={state["gateway_fail_streak"]}')


# ── check 2: Worker cascade ───────────────────────────────────
def check_workers(state):
    """Check each agent worker is alive via pgrep."""
    now = time.time()
    for agent, plist_label in WORKER_PLIST_MAP.items():
        # pgrep for the worker process
        try:
            proc = subprocess.run(
                ['pgrep', '-f', f'agent_queue_worker.py --agent {agent}'],
                capture_output=True, text=True, timeout=10
            )
            if proc.returncode == 0 and proc.stdout.strip():
                continue  # worker alive
        except subprocess.TimeoutExpired:
            continue

        # Worker is down — check cooldown
        last_fix = state.get('worker_last_fix_ts', {}).get(agent, 0)
        if now - last_fix < WORKER_COOLDOWN_SEC:
            continue

        log(f"Worker [{agent}]: DOWN — kickstarting {plist_label}")
        try:
            subprocess.run(
                ['launchctl', 'kickstart', f'gui/{os.getuid()}/{plist_label}'],
                capture_output=True, text=True, timeout=15
            )
            if 'worker_last_fix_ts' not in state:
                state['worker_last_fix_ts'] = {}
            state['worker_last_fix_ts'][agent] = now
            playbook_entry('worker', 'kickstart', f'agent={agent}')
        except subprocess.TimeoutExpired:
            log(f"Worker [{agent}]: kickstart timed out")


# ── check 3: Cron stuck ───────────────────────────────────────
def check_cron_stuck():
    """Find cron jobs stuck in 'running' state for >20 minutes."""
    if not CRON_JOBS.exists():
        return
    try:
        jobs = json.loads(CRON_JOBS.read_text())
    except (json.JSONDecodeError, OSError):
        return

    now_ts = time.time()
    for job in jobs:
        if not isinstance(job, dict):
            continue
        status = job.get('status', '')
        if status != 'running':
            continue
        started = job.get('lastRunStarted')
        if not started:
            continue
        try:
            # Parse ISO timestamp
            start_ts = datetime.fromisoformat(started.replace('Z', '+00:00')).timestamp()
        except (ValueError, AttributeError):
            continue

        elapsed_min = (now_ts - start_ts) / 60
        if elapsed_min > CRON_STUCK_MINUTES:
            job_id = job.get('id', '?')
            log(f"Cron [{job_id}]: stuck for {elapsed_min:.0f}min (>{CRON_STUCK_MINUTES}min)")
            playbook_entry('cron_stuck', 'detected', f'job={job_id}, elapsed={elapsed_min:.0f}min')


# ── check 4: Cron consecutive failures ────────────────────────
def check_cron_failures(state):
    """Disable cron jobs with ≥N consecutive failures."""
    if not CRON_JOBS.exists():
        return
    try:
        jobs = json.loads(CRON_JOBS.read_text())
    except (json.JSONDecodeError, OSError):
        return

    disabled = state.get('disabled_crons', [])
    modified = False

    for job in jobs:
        if not isinstance(job, dict):
            continue
        job_id = job.get('id', '')
        if job_id in disabled:
            continue
        consec_fails = job.get('consecutiveFailures', 0)
        if consec_fails >= CRON_ERROR_THRESHOLD:
            log(f"Cron [{job_id}]: {consec_fails} consecutive failures — flagging")
            playbook_entry('cron_fail', 'flagged', f'job={job_id}, fails={consec_fails}')
            # Note: we don't modify jobs.json directly (requires atomic RMW)
            # Instead we log and add to ops_todo
            add_ops_todo(
                f'Cron {job_id} has {consec_fails} consecutive failures',
                f'Job {job_id} failed {consec_fails} times. Consider disabling or investigating.'
            )
            disabled.append(job_id)
            modified = True

    if modified:
        state['disabled_crons'] = disabled


# ── check 5: Queue jam ────────────────────────────────────────
def check_queue_jam():
    """Detect queue jam: >5 items older than 30 minutes in pending/claimed state."""
    if not DB_PATH.exists():
        return
    try:
        import sqlite3
        with db_connection(DB_PATH, row_factory=sqlite3.Row) as conn:
            rows = conn.execute("""
                SELECT COUNT(*) as cnt FROM bus_commands
                WHERE status IN ('pending', 'claimed')
                AND created_at < datetime('now', ?)
            """, (f'-{QUEUE_JAM_AGE_MINUTES} minutes',)).fetchone()
            cnt = rows['cnt'] if rows else 0
        if cnt > QUEUE_JAM_COUNT:
            log(f"Queue jam: {cnt} items older than {QUEUE_JAM_AGE_MINUTES}min")
            playbook_entry('queue_jam', 'detected', f'count={cnt}, threshold={QUEUE_JAM_COUNT}')
    except Exception as e:
        log(f"Queue check error: {e}")


# ── ops_todo helper ────────────────────────────────────────────
def add_ops_todo(title, details):
    """Add an ops_todo entry via helper script or fallback to file."""
    helper = SCRIPTS_DIR / 'add_ops_todo.py'
    if helper.exists():
        try:
            subprocess.run(
                [sys.executable, str(helper), '--title', title, '--details', details],
                timeout=15
            )
            return
        except (subprocess.TimeoutExpired, OSError):
            pass
    # Fallback: append to file
    outdir = WORKSPACE / 'memory' / 'reflection'
    outdir.mkdir(parents=True, exist_ok=True)
    path = outdir / 'manual-approvals.md'
    with open(path, 'a') as f:
        f.write(f"### {time.strftime('%Y-%m-%d %H:%M:%S')} - {title}\n{details}\n\n")


# ── check 7: Stale system todos auto-expire ──────────────────

def expire_stale_system_todos():
    """7일 이상 된 시스템 할일을 자동 만료 처리. LLM-free, stdlib only."""
    if not DB_PATH.exists():
        return 0
    import sqlite3
    now = time.strftime('%Y-%m-%d %H:%M:%S')
    try:
        conn = sqlite3.connect(str(DB_PATH), timeout=10)
        conn.execute("PRAGMA journal_mode=WAL")
        placeholders = ','.join('?' for _ in _USER_SOURCES)
        rows = conn.execute(
            f"""SELECT id, title FROM ops_todos
                WHERE status IN ('todo', 'doing', 'blocked')
                  AND (source NOT IN ({placeholders}) OR source IS NULL)
                  AND created_at < datetime('now', ?)""",
            (*_USER_SOURCES, f'-{SYSTEM_TODO_EXPIRE_DAYS} days'),
        ).fetchall()
        if not rows:
            conn.close()
            return 0
        ids = [r[0] for r in rows]
        conn.execute(
            f"""UPDATE ops_todos
                SET status='cancelled', completed_at=?,
                    detail=COALESCE(detail,'') || ' [자동만료: {SYSTEM_TODO_EXPIRE_DAYS}일 경과]'
                WHERE id IN ({','.join('?' for _ in ids)})""",
            (now, *ids),
        )
        conn.commit()
        conn.close()
        log(f"System todos expired: {len(ids)} items (>{SYSTEM_TODO_EXPIRE_DAYS}d)")
        return len(ids)
    except Exception as e:
        log(f"expire_stale_system_todos error: {e}")
        return 0


# ── check 6: Disk growth ─────────────────────────────────────

_telegram_token_cache = None


def _dir_size_mb(path):
    """Return directory size in MB via du -sk. Returns 0 on error."""
    try:
        proc = subprocess.run(
            ['du', '-sk', str(path)],
            capture_output=True, text=True, timeout=10
        )
        if proc.returncode == 0 and proc.stdout.strip():
            kb = int(proc.stdout.split()[0])
            return kb / 1024
    except (subprocess.TimeoutExpired, ValueError, OSError):
        pass
    return 0


def _get_telegram_token():
    """Read bot token from openclaw.json (cached). Returns token or None."""
    global _telegram_token_cache
    if _telegram_token_cache is not None:
        return _telegram_token_cache
    cfg_path = OPENCLAW_DIR / 'openclaw.json'
    try:
        cfg = json.loads(cfg_path.read_text())
        token = cfg.get('telegram', {}).get('botToken', '')
        if token:
            _telegram_token_cache = token
            return token
    except (json.JSONDecodeError, OSError, KeyError):
        pass
    return None


def _send_telegram_dm(text):
    """Send a Telegram DM via bot API. stdlib only, never raises."""
    import urllib.request
    import urllib.error
    token = _get_telegram_token()
    if not token:
        log("Telegram DM: no bot token found")
        return
    chat_id = 492860021
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    payload = json.dumps({
        'chat_id': chat_id,
        'text': text[:4000],
        'parse_mode': 'HTML',
    }).encode()
    req = urllib.request.Request(url, data=payload,
                                headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=10):
            pass
    except (urllib.error.URLError, OSError, TimeoutError) as e:
        log(f"Telegram DM failed: {e}")


def check_disk_growth(state):
    """Monitor workspace directories for abnormal growth. Auto-delete known-bad patterns."""
    now = time.time()
    last_alert = state.get('disk_alert_last_ts', 0)
    cooldown_ok = (now - last_alert) >= DISK_ALERT_CD

    for scan_dir in DISK_SCAN_DIRS:
        if not scan_dir.is_dir():
            continue
        try:
            entries = list(scan_dir.iterdir())
        except OSError:
            continue
        for entry in entries:
            if not entry.is_dir() and not entry.is_file():
                continue
            if entry.is_dir():
                size_mb = _dir_size_mb(entry)
            else:
                try:
                    size_mb = entry.stat().st_size / (1024 * 1024)
                except OSError:
                    continue
            if size_mb < SUBDIR_SIZE_LIMIT_MB:
                continue

            # Large entry detected
            name = entry.name
            log(f"Disk growth: {scan_dir.name}/{name} = {size_mb:.0f}MB (>{SUBDIR_SIZE_LIMIT_MB}MB)")
            playbook_entry('disk_growth', 'detected',
                           f'{scan_dir.name}/{name}={size_mb:.0f}MB')

            # Pattern match → auto-delete
            matched = any(fnmatch.fnmatch(name, pat) for pat in AUTO_DELETE_PATTERNS)
            if matched and entry.is_dir():
                try:
                    shutil.rmtree(entry)
                    log(f"Disk growth: AUTO-DELETED {scan_dir.name}/{name} ({size_mb:.0f}MB)")
                    playbook_entry('disk_growth', 'auto_deleted',
                                   f'{scan_dir.name}/{name}={size_mb:.0f}MB')
                except OSError as e:
                    log(f"Disk growth: rmtree failed for {name}: {e}")
            elif matched and entry.is_file():
                try:
                    entry.unlink()
                    log(f"Disk growth: AUTO-DELETED file {scan_dir.name}/{name} ({size_mb:.0f}MB)")
                    playbook_entry('disk_growth', 'auto_deleted',
                                   f'{scan_dir.name}/{name}={size_mb:.0f}MB')
                except OSError as e:
                    log(f"Disk growth: unlink failed for {name}: {e}")

            # Send DM alert (with cooldown)
            if cooldown_ok:
                action = "auto-deleted" if matched else "MANUAL CHECK REQUIRED"
                _send_telegram_dm(
                    f"⚠️ <b>Disk growth alert</b>\n"
                    f"<code>{scan_dir.name}/{name}</code> = {size_mb:.0f}MB\n"
                    f"Action: {action}"
                )
                state['disk_alert_last_ts'] = now
                cooldown_ok = False  # one alert per cycle

    # Stale reflection cleanup (>30 days)
    reflection_dir = WORKSPACE / 'memory' / 'reflection'
    if reflection_dir.is_dir():
        cutoff = now - (STALE_REFLECTION_DAYS * 86400)
        for f in reflection_dir.iterdir():
            if not f.is_file():
                continue
            try:
                if f.stat().st_mtime < cutoff:
                    f.unlink()
                    log(f"Stale reflection removed: {f.name}")
                    playbook_entry('disk_growth', 'stale_removed', f.name)
            except OSError:
                pass

    # Low disk space urgent alert
    try:
        usage = shutil.disk_usage('/')
        free_gb = usage.free / (1024 ** 3)
        if free_gb < DISK_FREE_WARN_GB and cooldown_ok:
            msg = f"🚨 <b>LOW DISK SPACE</b>: {free_gb:.1f}GB free"
            log(msg)
            _send_telegram_dm(msg)
            state['disk_alert_last_ts'] = now
            playbook_entry('disk_growth', 'low_disk', f'free={free_gb:.1f}GB')
    except OSError:
        pass


# ── main ───────────────────────────────────────────────────────
def main():
    LOGS_DIR.mkdir(parents=True, exist_ok=True)
    state = load_state()

    check_gateway(state)
    check_workers(state)
    check_cron_stuck()
    check_cron_failures(state)
    check_queue_jam()
    check_disk_growth(state)
    expire_stale_system_todos()

    save_state(state)


if __name__ == '__main__':
    main()
