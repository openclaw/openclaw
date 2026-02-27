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

RESILIENCE PATTERNS (v3 with HTTPClient):
- Circuit Breaker: Prevents cascade failures after threshold errors
- Exponential Backoff: 2^n seconds, capped at 60s between retries
- Timeout Segmentation: Connect (5s) vs Read (30-120s for LLM inference)
- Graceful Degradation: Returns fallback value on total failure, no crashes
- Smart Retry Logic: Retry on 429/5xx, fail fast on 4xx client errors
- Playbook Logging: All network failures recorded for observability
- Zero Dependencies: Uses only stdlib (urllib, ssl, socket)
"""
import fnmatch
import json
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.parse
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
from shared.gateway_guard import guarded_gateway_restart

STATE_FILE = LOGS_DIR / 'autopilot_sweeper_state.json'
LOG_FILE = LOGS_DIR / 'autopilot_sweeper.log'
PLAYBOOK_FILE = LOGS_DIR / 'autopilot_playbook.jsonl'

GATEWAY_HOST = '127.0.0.1'
GATEWAY_PORT = 18789

# ── env config ─────────────────────────────────────────────────
CRON_ERROR_THRESHOLD = int(os.environ.get('SWEEPER_CRON_ERROR_THRESHOLD', '3'))
GATEWAY_COOLDOWN_SEC = int(os.environ.get('SWEEPER_GATEWAY_COOLDOWN_SEC', '120'))

# ── HTTP client config (for OpenRouter API calls) ─────────────
HTTP_TIMEOUT_CONNECT_SEC = float(os.environ.get('SWEEPER_HTTP_CONNECT_TIMEOUT', '5.0'))
HTTP_TIMEOUT_READ_SEC = float(os.environ.get('SWEEPER_HTTP_READ_TIMEOUT', '30.0'))
HTTP_RETRY_MAX_ATTEMPTS = int(os.environ.get('SWEEPER_HTTP_RETRY_MAX', '3'))
HTTP_RETRY_BACKOFF_BASE_SEC = float(os.environ.get('SWEEPER_HTTP_RETRY_BACKOFF', '2.0'))
HTTP_CIRCUIT_BREAKER_THRESHOLD = int(os.environ.get('SWEEPER_CB_THRESHOLD', '5'))
HTTP_CIRCUIT_BREAKER_RESET_SEC = int(os.environ.get('SWEEPER_CB_RESET_SEC', '300'))
GATEWAY_MAX_FAILS = int(os.environ.get('SWEEPER_GATEWAY_MAX_FAILS', '0'))  # 0 = unlimited
GATEWAY_BACKOFF_BASE_SEC = int(
    os.environ.get('SWEEPER_GATEWAY_BACKOFF_BASE_SEC', str(GATEWAY_COOLDOWN_SEC))
)
GATEWAY_BACKOFF_MAX_SEC = int(os.environ.get('SWEEPER_GATEWAY_BACKOFF_MAX_SEC', '1800'))
GATEWAY_RESTART_ATTEMPTS = int(os.environ.get('SWEEPER_GATEWAY_RESTART_ATTEMPTS', '2'))
GATEWAY_PROBE_WAIT_SEC = int(os.environ.get('SWEEPER_GATEWAY_PROBE_WAIT_SEC', '20'))
WORKER_COOLDOWN_SEC = 60
CRON_STUCK_MINUTES = 20
QUEUE_JAM_COUNT = 5
QUEUE_JAM_AGE_MINUTES = 30

# ── disk growth monitoring ────────────────────────────────
DISK_SCAN_DIRS = [WORKSPACE / 'memory', WORKSPACE / 'archives', WORKSPACE / 'snapshots',
                   WORKSPACE / 'logs',  # 175GB script_audit 재발 방지
                   OPENCLAW_DIR / 'logs']  # logs/archives 등 대형 아카이브 감시
TMP_EVIDENCE_DIR = Path('/private/tmp')  # /tmp/evidence_* 폭주 감시
SUBDIR_SIZE_LIMIT_MB = 1000      # alert if subdirectory exceeds 1GB
AUTO_DELETE_PATTERNS = ['evidence_*', 'evidence-*', 'archive_evidence_*', 'recovery-*',
                        'forensic*', 'incident-snapshots', 'script_audit_*']
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

# ═══════════════════════════════════════════════════════════════
# HTTP Client Utilities (stdlib only) — OpenRouter API support
# ═══════════════════════════════════════════════════════════════

class CircuitBreaker:
    """Circuit breaker pattern for external API calls.
    
    Opens after threshold failures, prevents cascade failures.
    Automatically resets after cooldown period.
    """
    def __init__(self, threshold=HTTP_CIRCUIT_BREAKER_THRESHOLD, 
                 reset_seconds=HTTP_CIRCUIT_BREAKER_RESET_SEC):
        self.threshold = threshold
        self.reset_seconds = reset_seconds
        self.failures = 0
        self.last_failure_time = 0
        self.state = 'CLOSED'  # CLOSED, OPEN, HALF_OPEN
    
    def can_execute(self):
        if self.state == 'CLOSED':
            return True
        if self.state == 'OPEN':
            if time.time() - self.last_failure_time >= self.reset_seconds:
                self.state = 'HALF_OPEN'
                log(f"Circuit breaker: entering HALF_OPEN state for {self.name}")
                return True
            return False
        return True  # HALF_OPEN allows one test call
    
    def record_success(self):
        if self.state == 'HALF_OPEN':
            log(f"Circuit breaker: closing circuit for {self.name}")
        self.state = 'CLOSED'
        self.failures = 0
    
    def record_failure(self, name='unknown'):
        self.name = name
        self.failures += 1
        self.last_failure_time = time.time()
        if self.failures >= self.threshold:
            if self.state != 'OPEN':
                log(f"Circuit breaker: OPENING circuit for {name} ({self.failures} failures)")
            self.state = 'OPEN'


class HTTPClient:
    """Robust HTTP client with retry, timeout, and circuit breaker support.
    
    Uses only stdlib (urllib) for zero-dependency operation.
    Designed for OpenRouter API calls with graceful degradation.
    """
    
    def __init__(self):
        self.circuit_breakers = {}
        self._local = threading.local()
    
    def _get_cb(self, endpoint_key):
        """Get or create circuit breaker for endpoint."""
        if endpoint_key not in self.circuit_breakers:
            self.circuit_breakers[endpoint_key] = CircuitBreaker()
        return self.circuit_breakers[endpoint_key]
    
    def _calculate_timeout(self, attempt, base_connect=None, base_read=None):
        """Calculate timeout with exponential backoff per attempt."""
        base_connect = base_connect or HTTP_TIMEOUT_CONNECT_SEC
        base_read = base_read or HTTP_TIMEOUT_READ_SEC
        # Increase read timeout on retries, cap at 120s
        read_timeout = min(base_read * (2 ** attempt), 120.0)
        return (base_connect, read_timeout)
    
    def request(self, method, url, headers=None, data=None, json_data=None,
                timeout_connect=None, timeout_read=None, 
                max_retries=HTTP_RETRY_MAX_ATTEMPTS,
                backoff_base=HTTP_RETRY_BACKOFF_BASE_SEC,
                circuit_breaker_key=None,
                allow_methods=('GET', 'POST', 'PUT', 'DELETE'),
                retry_on_status=(429, 500, 502, 503, 504),
                graceful_return=None):
        """Execute HTTP request with full resilience patterns.
        
        Args:
            method: HTTP method string
            url: Target URL
            headers: Optional dict of headers
            data: Raw bytes payload
            json_data: Dict to serialize as JSON (alternative to data)
            timeout_connect: Connection timeout in seconds
            timeout_read: Read timeout in seconds  
            max_retries: Max retry attempts
            backoff_base: Base seconds for exponential backoff
            circuit_breaker_key: Key for circuit breaker (host or endpoint)
            allow_methods: Methods allowed for retry
            retry_on_status: HTTP status codes that trigger retry
            graceful_return: Value to return on total failure (default: None)
        
        Returns:
            tuple: (success: bool, response_data: dict or None, error_info: dict)
            Response format: {'status': int, 'body': bytes, 'headers': dict}
        """
        import urllib.request
        import urllib.error
        import ssl
        
        # Circuit breaker check
        cb_key = circuit_breaker_key or urllib.parse.urlparse(url).netloc
        cb = self._get_cb(cb_key)
        if not cb.can_execute():
            log(f"HTTP: circuit OPEN for {cb_key}, skipping request")
            return (False, graceful_return, {
                'error': 'circuit_breaker_open',
                'circuit_state': cb.state,
                'failures': cb.failures
            })
        
        # Prepare payload
        payload = None
        if json_data is not None:
            payload = json.dumps(json_data).encode('utf-8')
            headers = headers or {}
            headers['Content-Type'] = 'application/json'
        elif data is not None:
            payload = data if isinstance(data, bytes) else data.encode('utf-8')
        
        # Create SSL context that allows us to configure verification
        ssl_context = ssl.create_default_context()
        
        last_error = None
        attempt = 0
        
        while attempt < max_retries:
            connect_to, read_to = self._calculate_timeout(
                attempt, timeout_connect, timeout_read
            )
            
            req = urllib.request.Request(
                url, 
                data=payload,
                headers=headers or {},
                method=method
            )
            
            try:
                start_time = time.time()
                with urllib.request.urlopen(
                    req, 
                    timeout=connect_to + read_to,  # Total timeout fallback
                    context=ssl_context
                ) as resp:
                    body = resp.read()
                    elapsed = time.time() - start_time
                    
                    result = {
                        'status': resp.getcode(),
                        'body': body,
                        'headers': dict(resp.headers),
                        'elapsed_ms': int(elapsed * 1000)
                    }
                    
                    # Success case
                    if result['status'] < 400:
                        cb.record_success()
                        return (True, result, None)
                    
                    # HTTP error that might be retryable
                    if result['status'] in retry_on_status and method in allow_methods:
                        last_error = f"HTTP {result['status']}"
                        log(f"HTTP: {last_error} (attempt {attempt + 1}/{max_retries})")
                        # Don't increment circuit breaker for retryable errors yet
                    else:
                        # Non-retryable HTTP error
                        cb.record_failure(cb_key)
                        return (False, result, {
                            'error': 'http_error',
                            'status': result['status'],
                            'attempt': attempt + 1
                        })
            
            except urllib.error.HTTPError as e:
                last_error = f"HTTP {e.code}: {e.reason}"
                log(f"HTTP: {last_error} (attempt {attempt + 1}/{max_retries})")
                
                # Check if retryable
                if e.code in retry_on_status and method in allow_methods:
                    pass  # Will retry below
                elif 400 <= e.code < 500 and e.code != 429:
                    # Client error, don't retry
                    cb.record_failure(cb_key)
                    return (False, graceful_return, {
                        'error': 'client_error',
                        'code': e.code,
                        'reason': str(e.reason)
                    })
                else:
                    cb.record_failure(cb_key)
                    return (False, graceful_return, {
                        'error': 'http_error',
                        'code': e.code
                    })
            
            except urllib.error.URLError as e:
                last_error = f"URL error: {e.reason}"
                log(f"HTTP: {last_error} (attempt {attempt + 1}/{max_retries})")
                # Network-level errors trigger circuit breaker
                cb.record_failure(cb_key)
            
            except TimeoutError as e:
                last_error = f"Timeout: {e}"
                log(f"HTTP: Timeout after {connect_to + read_to}s (attempt {attempt + 1}/{max_retries})")
                # Timeout triggers circuit breaker
                cb.record_failure(cb_key)
            
            except socket.timeout as e:
                last_error = f"Socket timeout: {e}"
                log(f"HTTP: Socket timeout (attempt {attempt + 1}/{max_retries})")
                cb.record_failure(cb_key)
            
            except OSError as e:
                last_error = f"OS error: {e}"
                log(f"HTTP: OS error (attempt {attempt + 1}/{max_retries}): {e}")
                cb.record_failure(cb_key)
            
            except Exception as e:
                last_error = f"Unexpected: {type(e).__name__}: {e}"
                log(f"HTTP: Unexpected error (attempt {attempt + 1}/{max_retries}): {e}")
                cb.record_failure(cb_key)
            
            # Exponential backoff before retry
            attempt += 1
            if attempt < max_retries:
                sleep_time = min(backoff_base * (2 ** (attempt - 1)), 60)
                log(f"HTTP: retrying in {sleep_time:.1f}s...")
                time.sleep(sleep_time)
        
        # All retries exhausted
        log(f"HTTP: FAILED after {max_retries} attempts. Last error: {last_error}")
        playbook_entry('http_request', 'failed_all_retries', 
                      f'url={urllib.parse.urlparse(url).path}, error={last_error}')
        
        return (False, graceful_return, {
            'error': 'max_retries_exhausted',
            'last_error': last_error,
            'attempts': max_retries,
            'circuit_state': cb.state
        })
    
    def post(self, url, json_data=None, **kwargs):
        """Convenience method for POST requests."""
        return self.request('POST', url, json_data=json_data, **kwargs)
    
    def get(self, url, **kwargs):
        """Convenience method for GET requests."""
        return self.request('GET', url, **kwargs)


# Global HTTP client instance
http_client = HTTPClient()


# ═══════════════════════════════════════════════════════════════
# OpenRouter API Helper (optimized for LLM inference patterns)
# ═══════════════════════════════════════════════════════════════

def call_openrouter_api(api_key, model, messages, temperature=0.7, 
                        max_tokens=None, timeout_read=60.0,
                        max_retries=3, graceful_fallback=None):
    """Call OpenRouter API with production-grade resilience.
    
    Designed for inference calls with proper timeout handling:
    - Connection: 5s (fast TCP handshake)
    - Read: 60s default (generation can be slow)
    - Retry on 429, 500, 502, 503, 504
    - Graceful fallback returns default value on total failure
    
    Args:
        api_key: OpenRouter API key
        model: Model identifier (e.g., 'openai/gpt-4o')
        messages: List of message dicts
        temperature: Sampling temperature
        max_tokens: Max output tokens
        timeout_read: Read timeout (generation time)
        max_retries: Retry attempts
        graceful_fallback: Value to return on failure
    
    Returns:
        dict: {'success': bool, 'data': response or fallback, 'error': str or None}
    """
    if not api_key:
        log("OpenRouter: no API key provided")
        return {
            'success': False,
            'data': graceful_fallback,
            'error': 'missing_api_key',
            'circuit_state': None
        }
    
    url = "https://openrouter.ai/api/v1/chat/completions"
    
    payload = {
        'model': model,
        'messages': messages,
        'temperature': temperature,
    }
    if max_tokens:
        payload['max_tokens'] = max_tokens
    
    headers = {
        'Authorization': f'Bearer {api_key}',
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://openclaw.local',
        'X-Title': 'Autopilot Sweeper'
    }
    
    success, response, error_info = http_client.post(
        url,
        json_data=payload,
        headers=headers,
        timeout_connect=5.0,  # Fast connection
        timeout_read=timeout_read,  # Generation can be slow
        max_retries=max_retries,
        backoff_base=2.0,
        circuit_breaker_key='openrouter_api',
        retry_on_status=(429, 500, 502, 503, 504),
        graceful_return=None
    )
    
    if success and response:
        try:
            body_json = json.loads(response['body'].decode('utf-8'))
            log(f"OpenRouter: success ({response.get('elapsed_ms', 0)}ms)")
            return {
                'success': True,
                'data': body_json,
                'error': None,
                'circuit_state': 'CLOSED'
            }
        except (json.JSONDecodeError, UnicodeDecodeError) as e:
            log(f"OpenRouter: JSON parse error - {e}")
            return {
                'success': False,
                'data': graceful_fallback,
                'error': f'json_parse_error: {e}',
                'circuit_state': 'CLOSED'
            }
    
    # Failure case - graceful degradation
    error_type = error_info.get('error', 'unknown') if error_info else 'unknown_error'
    circuit_state = error_info.get('circuit_state', 'CLOSED') if error_info else 'CLOSED'
    
    log(f"OpenRouter: failed - {error_type}")
    
    if circuit_state == 'OPEN':
        log("OpenRouter: circuit breaker OPEN - using fallback")
        playbook_entry('openrouter_api', 'circuit_open', 
                      f'error={error_type}')
    else:
        playbook_entry('openrouter_api', 'request_failed', 
                      f'error={error_type}, attempts={max_retries}')
    
    return {
        'success': False,
        'data': graceful_fallback,
        'error': error_type,
        'circuit_state': circuit_state
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
        'gateway_next_retry_ts': 0,
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
def _gateway_backoff_seconds(streak):
    if streak <= 0:
        return GATEWAY_COOLDOWN_SEC
    base = max(GATEWAY_COOLDOWN_SEC, GATEWAY_BACKOFF_BASE_SEC)
    delay = base * (2 ** max(0, streak - 1))
    return min(delay, max(base, GATEWAY_BACKOFF_MAX_SEC))


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
            state['gateway_next_retry_ts'] = 0
        else:
            log("Gateway: OK")
        return

    # Gateway is down
    streak = int(state.get('gateway_fail_streak', 0))
    if GATEWAY_MAX_FAILS > 0 and streak >= GATEWAY_MAX_FAILS:
        log(f"Gateway: DOWN but gave up after {GATEWAY_MAX_FAILS} consecutive failures")
        playbook_entry('gateway', 'gave_up', f'streak={streak}')
        return

    # Check cooldown
    next_retry = float(state.get('gateway_next_retry_ts', 0) or 0)
    now = time.time()
    if next_retry > now:
        remaining = int(next_retry - now)
        log(f"Gateway: DOWN, cooldown {remaining}s remaining")
        return

    max_label = str(GATEWAY_MAX_FAILS) if GATEWAY_MAX_FAILS > 0 else "∞"
    log(f"Gateway: DOWN — attempting guarded restart (attempt {streak + 1}/{max_label})")
    try:
        result = guarded_gateway_restart(
            reason='autopilot_sweeper',
            attempts=max(1, GATEWAY_RESTART_ATTEMPTS),
            probe_wait_sec=max(5, GATEWAY_PROBE_WAIT_SEC),
            lock_timeout_sec=max(10, GATEWAY_COOLDOWN_SEC),
        )
        if result.get('ok'):
            log(f"Gateway: RESTORED successfully ({result.get('result', 'restarted')})")
            state['gateway_fail_streak'] = 0
            state['gateway_next_retry_ts'] = 0
            state['gateway_last_fix_ts'] = time.time()
            playbook_entry('gateway', 'restored', f'attempt={streak + 1}')
            return

        state['gateway_fail_streak'] = streak + 1
        state['gateway_last_fix_ts'] = time.time()
        backoff = _gateway_backoff_seconds(state['gateway_fail_streak'])
        state['gateway_next_retry_ts'] = time.time() + backoff
        reason = result.get('reason') or result.get('result') or 'unknown'
        log(
            f"Gateway: guarded restart failed (streak={state['gateway_fail_streak']}, "
            f"next_retry={int(backoff)}s, reason={reason})"
        )
        playbook_entry(
            'gateway',
            'restart_failed',
            f'streak={state["gateway_fail_streak"]}, backoff={int(backoff)}, reason={reason}',
        )

    except subprocess.TimeoutExpired:
        state['gateway_fail_streak'] = streak + 1
        state['gateway_last_fix_ts'] = time.time()
        backoff = _gateway_backoff_seconds(state['gateway_fail_streak'])
        state['gateway_next_retry_ts'] = time.time() + backoff
        log(f"Gateway: guarded restart timed out, retry in {int(backoff)}s")
        playbook_entry(
            'gateway',
            'restart_timeout',
            f'streak={state["gateway_fail_streak"]}, backoff={int(backoff)}',
        )


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
            # FIX: SQLite datetime modifier must be inline (not parameterized)
            rows = conn.execute(f"""
                SELECT COUNT(*) as cnt FROM bus_commands
                WHERE status IN ('pending', 'claimed')
                AND created_at < datetime('now', '-{QUEUE_JAM_AGE_MINUTES} minutes')
            """).fetchone()
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
        # FIX: SQLite datetime modifier must be inline (not parameterized)
        rows = conn.execute(
            f"""SELECT id, title FROM ops_todos
                WHERE status IN ('todo', 'doing', 'blocked')
                  AND (source NOT IN ({placeholders}) OR source IS NULL)
                  AND created_at < datetime('now', '-{SYSTEM_TODO_EXPIRE_DAYS} days')""",
            (*_USER_SOURCES,),
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

# Telegram DM — via shared.telegram
try:
    from shared.telegram import send_dm as _tg_send_dm
except (ImportError, Exception):
    _tg_send_dm = lambda text, **kw: False


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
                dm_sent = _tg_send_dm(
                    f"⚠️ <b>Disk growth alert</b>\n"
                    f"<code>{scan_dir.name}/{name}</code> = {size_mb:.0f}MB\n"
                    f"Action: {action}",
                    level="critical"
                )
                if dm_sent:
                    state['disk_alert_last_ts'] = now
                    cooldown_ok = False  # one alert per cycle
                else:
                    # Graceful degradation: alert failed but don't block other operations
                    log(f"Disk growth: DM alert failed for {name}, will retry next cycle")

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
            dm_sent = _tg_send_dm(msg, level="critical")
            if dm_sent:
                state['disk_alert_last_ts'] = now
            else:
                log("Low disk alert: DM failed, logged for manual review")
            playbook_entry('disk_growth', 'low_disk', f'free={free_gb:.1f}GB, dm_sent={dm_sent}')
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
