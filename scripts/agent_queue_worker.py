#!/usr/bin/env python3
"""Agent command-queue worker for Ron/Codex/Cowork.

Flow:
1) announce status heartbeat
2) fetch queued commands for this agent
3) atomic claim -> execute mapped routine -> complete/fail
"""

from __future__ import annotations

import argparse
import json
import os
import random
import re
import shlex
import subprocess
import time
from pathlib import Path
from urllib.error import HTTPError, URLError

# Agent-specific model routing via OpenClaw gateway (Single Source: agent_registry.py)
try:
    from agent_registry import AGENT_MODEL_MAP, AGENT_ROLE_PROMPTS
except ImportError:
    import sys; sys.path.insert(0, str(Path(__file__).parent))
    from agent_registry import AGENT_MODEL_MAP, AGENT_ROLE_PROMPTS

try:
    from shared.db import get_connection, db_connection, db_transaction
except ImportError:
    pass  # fallback: raw sqlite3 still works

try:
    from shared.vault_paths import VAULT as _VAULT_PATH
except ImportError:
    _VAULT_PATH = Path(os.path.expanduser("~/knowledge"))

def _get_model_chain_orig(default_model="openclaw:main", include_default=True):
    return [default_model]


def get_model_chain(default_model="openclaw:main", include_default=True, agent_name=None):
    """Return model chain, preferring AGENT_MODEL_MAP if agent_name is provided."""
    if agent_name and agent_name in AGENT_MODEL_MAP:
        return AGENT_MODEL_MAP[agent_name]
    return _get_model_chain_orig(default_model=default_model, include_default=include_default)

def log_to_memory(agent, title, note, priority="low"):
    """Record task result (stub — memory_manager.py removed)."""
    pass
from urllib.parse import urlencode
from urllib.request import Request, urlopen

# Workspace root (used by normalization helpers)
WORKSPACE = Path("/Users/ron/.openclaw/workspace")

# Lightweight logger helper (fallback to print if no logging configured)
def log(*args, **kwargs):
    try:
        # prefer standard logging if configured
        import logging
        logging.getLogger(__name__).info(' '.join(str(a) for a in args))
    except Exception:
        print(*args, **kwargs)

# --- LLM execution via gateway chat API ---
GATEWAY_CHAT_URL = "http://127.0.0.1:18789/v1/chat/completions"
GATEWAY_TOKEN = os.environ.get("OPENCLAW_TOKEN", "")
# Auto-load from .env if token empty (LaunchAgent env fix)
if not GATEWAY_TOKEN:
    _env_file = os.path.join(os.path.expanduser("~"), ".openclaw/.env")
    if os.path.exists(_env_file):
        with open(_env_file) as _ef:
            for _line in _ef:
                if _line.startswith("OPENCLAW_TOKEN="):
                    GATEWAY_TOKEN = _line.strip().split("=", 1)[1]
                    break
# Keep model-fallback latency bounded so queue workers do not appear frozen.
LLM_TIMEOUT = int(os.environ.get("OPENCLAW_LLM_TIMEOUT_SEC", "40"))
# Hard cap for a single command's LLM phase to avoid long "claimed" stalls.
LLM_BUDGET_SEC = int(os.environ.get("OPENCLAW_LLM_BUDGET_SEC", "90"))

def _build_auto_context(agent: str, task_text: str) -> str:
    """Auto-build context (stub — context_builder removed)."""
    return ""


# Quality thresholds
MIN_RESPONSE_LEN = 80
QUALITY_REJECT_PATTERNS = [
    "알겠습니다", "확인했습니다", "작업을 시작", "진행하겠",
    "understood", "acknowledged", "will proceed",
]

# ============================================================
# Tool-Use Loop: [액션] parsing → safe execution → result injection
# ============================================================

TOOL_USE_AGENTS = {"ron", "codex", "cowork", "guardian", "data-analyst"}
TOOL_USE_MAX_TURNS = int(os.environ.get("OPENCLAW_TOOL_TURNS", "2"))
TOOL_USE_CMD_TIMEOUT = int(os.environ.get("OPENCLAW_TOOL_CMD_TIMEOUT_SEC", "20"))
TOOL_USE_STDOUT_CAP = 2000

_ACTION_MARKERS = {"[액션]", "[Action]"}
_STOP_SECTIONS = {"[분석]", "[판단]", "[검증]", "[현황]", "[리스크]", "[Analysis]", "[Verdict]"}

# Whitelist: only these script prefixes are allowed
_CMD_WHITELIST_PREFIXES = [
    # 핵심 도구
    "python3 ontology_core.py",
    "python3 knowledge_os.py",
    "python3 health_check.py",
    "python3 self_evolve.py",
    # memory_manager.py removed — stub retained for safe command list
    "python3 data_analyst.py",
    "python3 daily_kpi_eval.py",
    "python3 maintenance.py",
    # 파이프라인 전체 (인사이트 자율 생성용)
    "python3 pipeline/discovery_filter.py",
    "python3 pipeline/discovery_digest.py",
    "python3 pipeline/knowledge_connector.py",
    "python3 pipeline/hypothesis_engine.py",
    "python3 pipeline/experiment_tracker.py",
    "python3 pipeline/keyword_tuner.py",
    "python3 pipeline/note_atomizer.py",
    "python3 pipeline/idea_collector.py",
    "python3 pipeline/vault_reeval.py",
    "python3 pipeline/blog_monitor.py",
    "python3 pipeline/market_indicator_tracker.py",
    "python3 pipeline/task_briefing.py",
    "python3 pipeline/geopolitical_monitor.py",
    "python3 pipeline/shipbuilding_cycle_tracker.py",
    "python3 pipeline/choi_report_collector.py",
    "python3 pipeline/telegram_popular_posts.py",
    "python3 pipeline/system_dashboard.py",
    "python3.13 pipeline/twitter_collector.py",
    "/opt/homebrew/bin/python3.13 pipeline/twitter_collector.py",
    # knowledge_search.py removed — file does not exist
    # 조회
    "curl http://127.0.0.1:3344",
    "curl http://localhost:3344",
    "sqlite3",
    "cat SOUL.md",
    "cat AGENTS.md",
    "cat MEMORY.md",
    "cat TOOLS.md",
    "ls ",
    "find ",
]

_CMD_BLACKLIST_PATTERNS = [
    "rm ", "rm\t", "rmdir", "sudo", "chmod", "chown",
    "> /", ">> /", "| sh", "| bash", "eval ", "exec ",
    "kill ", "pkill", "mkfs", "dd if=", "wget", "curl -X DELETE",
    "DROP TABLE", "DELETE FROM", "TRUNCATE",
    # disk-explosion defense-in-depth (2026-02-20)
    "cp ", "cp\t", "mkdir", "tar ", "tar\t", "rsync",
    # forensic cascade prevention (2026-02-23): /tmp/evidence_* 351GB 폭주 재발 방지
    "evidence", "forensic", "forensics",
]


def _normalize_tool_cmd(cmd: str) -> str:
    """Normalize absolute paths to workspace-relative for safe execution."""
    workspace_str = str(WORKSPACE) + "/scripts/"
    cmd = cmd.replace(workspace_str, "")
    cmd = cmd.replace(str(WORKSPACE) + "/", "")
    # Also handle /usr/bin/python3 → python3
    cmd = cmd.replace("/usr/bin/python3 ", "python3 ")
    cmd = cmd.replace("/opt/homebrew/bin/python3 ", "python3 ")
    return cmd.strip()


def _is_safe_command(cmd: str) -> bool:
    """Check command against whitelist/blacklist.

    Security improvements:
    - Reject commands containing shell metacharacters that would require a shell.
    - Use normalized comparison against whitelist prefixes.
    - Ensure no redirection, pipelines, command chaining, or subshells are present.
    """
    normalized = _normalize_tool_cmd(cmd)
    ln = normalized.lower()
    # Immediate rejection for dangerous metacharacters or constructs
    dangerous_tokens = [";", "|", "&", "$(`", "$ (", "`", "<", ">", "&&", "||"]
    for tok in dangerous_tokens:
        if tok in ln:
            return False
    # Blacklist check (case-insensitive)
    for pattern in _CMD_BLACKLIST_PATTERNS:
        if pattern.lower() in ln:
            return False
    # Whitelist check: require startswith one of allowed prefixes
    for prefix in _CMD_WHITELIST_PREFIXES:
        if ln.startswith(prefix.lower()):
            return True
    return False


def _extract_tool_calls(content: str) -> list[str]:
    """Extract executable commands from LLM response [액션] blocks.

    Handles multiple formats:
    1. → command (standard)
    2. → description: command (codex mixed format — strip description prefix)
    3. -> command (ascii arrow)
    4. $ command (shell prefix)
    5. > command (quote prefix)
    6. ```bash\\ncommand\\n``` (code block)
    7. Inline backtick: `command`
    """
    commands: list[str] = []
    lines = content.split("\n")
    in_action_block = False
    in_code_block = False

    for line in lines:
        stripped = line.strip()

        # Code block toggle
        if stripped.startswith("```"):
            if in_code_block:
                in_code_block = False
                continue
            if "bash" in stripped.lower() or "shell" in stripped.lower() or stripped == "```":
                in_code_block = True
                continue

        # Inside code block — treat each line as a command
        if in_code_block:
            if stripped and not stripped.startswith("#"):
                commands.append(stripped)
                if len(commands) >= 3:
                    break
            continue

        # Check for action markers
        for marker in _ACTION_MARKERS:
            if marker in stripped:
                in_action_block = True
                # If there's a command on the same line after the marker
                after = stripped.split(marker, 1)[1].strip()
                if after:
                    cmd = _parse_action_line(after)
                    if cmd:
                        commands.append(cmd)
                break

        # Check for stop sections
        for stop in _STOP_SECTIONS:
            if stop in stripped:
                in_action_block = False
                break

        # Parse action lines when inside an action block
        if in_action_block and stripped:
            cmd = _parse_action_line(stripped)
            if cmd and cmd not in commands:
                commands.append(cmd)

        if len(commands) >= 3:
            break

    return commands[:3]


def _parse_action_line(line: str) -> str | None:
    """Parse a single action line, handling various formats.

    Handles:
    - → command
    - → description: python3 script.py args  (strip description before command keyword)
    - -> command
    - $ command
    - > command
    - `command`
    """
    # Strip arrow/prefix markers
    for prefix in ["→", "->", "$", ">"]:
        if line.startswith(prefix):
            line = line[len(prefix):].strip()
            break
    else:
        # Also handle numbered lists like "1. command"
        m = re.match(r"^\d+\.\s*", line)
        if m:
            line = line[m.end():].strip()
        else:
            # No recognized prefix, try inline backtick
            m = re.search(r"`([^`]+)`", line)
            if m:
                line = m.group(1).strip()
            else:
                return None

    if not line:
        return None

    # Handle mixed format: "설명: python3 script.py args"
    # or "설명문 — python3 script.py args"
    # Key insight: find the first occurrence of a command-like token
    cmd_starters = ["python3 ", "curl ", "sqlite3 ", "cat ", "ls ", "grep "]
    for starter in cmd_starters:
        idx = line.find(starter)
        if idx > 0:
            # There's text before the command — likely a description
            line = line[idx:]
            break

    # Strip trailing backtick if present
    if line.endswith("`") and not line.startswith("`"):
        line = line[:-1]

    # Strip surrounding backticks
    if line.startswith("`") and line.endswith("`"):
        line = line[1:-1]

    return line.strip() if line.strip() else None


def _execute_tool_cmd(cmd: str) -> str:
    """Execute a whitelisted command and return captured output.

    Security improvements:
    - Use shlex.split and shell=False to avoid shell injection.
    - Validate the command tokens against whitelist prefixes before execution.
    """
    normalized = _normalize_tool_cmd(cmd)
    ln = normalized.lower()
    # cat commands for workspace-level files need WORKSPACE as cwd, not scripts/
    if ln.startswith("cat "):
        work_dir = str(WORKSPACE)
    else:
        work_dir = str(WORKSPACE / "scripts")
    try:
        # Split into argv to avoid shell=True execution
        argv = shlex.split(normalized)
        if not argv:
            return "(no command)"
        # Double-check first part matches a whitelist prefix (defense-in-depth)
        first = " ".join(argv[:2]) if len(argv) >= 2 else argv[0]
        if not any(ln.startswith(p.lower()) for p in _CMD_WHITELIST_PREFIXES if p):
            return "(blocked: not in whitelist)"
        p = subprocess.run(
            argv,
            shell=False,
            capture_output=True,
            text=True,
            timeout=TOOL_USE_CMD_TIMEOUT,
            cwd=work_dir,
            check=False,
        )
        out = (p.stdout or "").strip()
        err = (p.stderr or "").strip()
        if p.returncode != 0 and err:
            result = f"[rc={p.returncode}] {err[:500]}"
            if out:
                result += f"\n{out[:500]}"
            return result[:TOOL_USE_STDOUT_CAP]
        return out[:TOOL_USE_STDOUT_CAP] if out else "(no output)"
    except subprocess.TimeoutExpired:
        return f"(timeout after {TOOL_USE_CMD_TIMEOUT}s)"
    except Exception as e:
        return f"(exec error: {str(e)[:200]})"


def llm_execute(agent: str, task_title: str, task_body: str, context: str = "") -> tuple[bool, str]:
    """Call gateway LLM with enriched context and quality gate.

    Improvements over v1:
    - Rich system prompts with output format, quality criteria, and domain expertise
    - Auto-context injection from context_builder (ontology, conviction, docs, history)
    - max_tokens 4000 (was 1500), context budget 8000 (was 2000)
    - Quality gate: retries once if response is too short or generic
    """
    system_msg = AGENT_ROLE_PROMPTS.get(agent, "작업을 실행하고 결과를 보고하라.")
    started_at = time.time()

    def _remaining_budget() -> float:
        return float(LLM_BUDGET_SEC) - (time.time() - started_at)

    def _next_timeout() -> int:
        remaining = _remaining_budget()
        if remaining <= 0:
            return 0
        return max(5, int(min(float(LLM_TIMEOUT), remaining)))

    # Auto-enrich context
    auto_ctx = _build_auto_context(agent, f"{task_title} {task_body}")
    all_context = "\n\n".join(filter(None, [context, auto_ctx]))

    user_msg = f"[작업] {task_title}\n\n{task_body}"
    if all_context:
        user_msg += f"\n\n[수집된 컨텍스트]\n{all_context[:8000]}"

    model_chain = get_model_chain(default_model="openclaw:main", include_default=False, agent_name=agent)

    def _call_llm(sys_msg: str, usr_msg: str, max_tokens: int = 4000) -> tuple[bool, str, str]:
        from shared.llm import llm_chat_with_fallback
        call_timeout = _next_timeout()
        if call_timeout <= 0:
            return False, "llm budget exceeded", ""
        messages = [
            {"role": "system", "content": sys_msg},
            {"role": "user", "content": usr_msg[:16000]},
        ]
        content, used_model, error = llm_chat_with_fallback(
            messages, model_chain, temperature=0.3,
            max_tokens=max_tokens, timeout=call_timeout,
        )
        if content:
            return True, content, used_model
        return False, error or "empty_response", ""

    # Multi-turn message support for tool-use loop
    def _call_llm_multi(messages: list[dict], max_tokens: int = 4000) -> tuple[bool, str, str]:
        from shared.llm import llm_chat_with_fallback
        call_timeout = _next_timeout()
        if call_timeout <= 0:
            return False, "llm budget exceeded", ""
        content, used_model, error = llm_chat_with_fallback(
            messages, model_chain, temperature=0.3,
            max_tokens=max_tokens, timeout=call_timeout,
        )
        if content:
            return True, content, used_model
        return False, error or "empty_response", ""

    try:
        ok, content, used_model = _call_llm(system_msg, user_msg)
        if not ok:
            return False, content or "LLM returned empty response"

        # Tool-use loop: parse [액션] → execute → inject results → re-call
        if agent in TOOL_USE_AGENTS:
            messages = [
                {"role": "system", "content": system_msg},
                {"role": "user", "content": user_msg[:16000]},
                {"role": "assistant", "content": content},
            ]
            for _turn in range(TOOL_USE_MAX_TURNS):
                if _remaining_budget() <= 0:
                    break
                tool_cmds = _extract_tool_calls(content)
                if not tool_cmds:
                    break

                # Execute safe commands and collect results
                results_parts = []
                for cmd in tool_cmds:
                    if _is_safe_command(cmd):
                        result = _execute_tool_cmd(cmd)
                        results_parts.append(f"$ {_normalize_tool_cmd(cmd)}\n{result}")
                    else:
                        results_parts.append(f"$ {cmd}\n(blocked: not in whitelist)")

                if not results_parts:
                    break

                # Inject tool results and re-call LLM
                tool_output = "\n\n".join(results_parts)
                messages.append({
                    "role": "user",
                    "content": f"[도구 실행 결과]\n{tool_output}\n\n위 결과를 바탕으로 분석과 판단을 완성하세요.",
                })

                ok2, content2, model2 = _call_llm_multi(messages)
                if not ok2:
                    break
                content = content2
                used_model = model2 or used_model
                messages.append({"role": "assistant", "content": content})

        # Quality gate: retry once if response is too short or generic
        is_too_short = len(content.strip()) < MIN_RESPONSE_LEN
        is_generic = any(p in content[:100] for p in QUALITY_REJECT_PATTERNS)
        if (is_too_short or is_generic) and _remaining_budget() >= 15:
            retry_msg = (
                f"{user_msg}\n\n"
                f"[품질 보완 요청] 이전 응답이 너무 짧거나 형식적입니다. "
                f"구체적 데이터, 수치, 분석을 포함하여 최소 200자 이상 작성해주세요. "
                f"단순 acknowledge가 아닌 실질적인 분석/판단/액션을 포함하세요."
            )
            ok2, content2, used_model2 = _call_llm(system_msg, retry_msg)
            if ok2 and len(content2.strip()) > len(content.strip()):
                content = content2
                used_model = used_model2 or used_model

        # Bus에 결과 공유 (extended to 800 chars)
        bus_post(agent, f"[model={used_model}] {content[:760]}", task_title)
        return True, shorten(content, 800)

    except Exception as e:
        return False, f"LLM call failed: {str(e)[:120]}"


def _is_dm_noise(msg_type: str, body: str) -> bool:
    """DM 노이즈 필터: ack/status 타입, 짧은 메시지, thinking 키워드 차단."""
    if msg_type in ("ack", "heartbeat"):
        return True
    body_stripped = body.strip()
    if len(body_stripped) < 30:
        return True
    noise_kw = ["thinking", "처리 중", "확인했습니다", "알겠습니다", "진행합니다",
                 "작업을 시작", "분석을 시작", "점검을 시작"]
    body_lower = body_stripped.lower()
    if any(kw in body_lower for kw in noise_kw):
        return True
    return False


def bus_post(agent: str, content: str, ref: str = "", msg_type: str = "status") -> None:
    """Post a status message to the bus. Noisy messages are logged only, not sent to DM."""
    body = f"[{agent} 실행결과] {content[:800]}"
    if _is_dm_noise(msg_type, body):
        return  # 노이즈 차단 — bus 로그에만 기록, DM 발송 안 함
    try:
        jpost("/api/bus/send", {
            "from": agent,
            "to": "harry",
            "type": msg_type,
            "body": body,
        })
    except Exception:
        pass

PLAYBOOKS_DIR_CANDIDATES = [
    Path("/Users/ron/.openclaw/workspace/knowledge/300 운영/320 플레이북/329 비넘버 통합"),
    Path("/Users/ron/.openclaw/workspace/knowledge/300 운영/320 플레이북"),
]
PLAYBOOKS_DIR = next((p for p in PLAYBOOKS_DIR_CANDIDATES if p.exists()), PLAYBOOKS_DIR_CANDIDATES[0])


def read_relevant_playbook(agent: str, text: str) -> str:
    """Search playbooks for entries relevant to the current task.
    Returns matching playbook hints as context string (max 500 chars).
    """
    if not PLAYBOOKS_DIR.exists():
        return ""
    # Search all playbook files for keyword matches
    keywords = [w for w in text.lower().split() if len(w) > 3][:10]
    matches = []
    try:
        for pb_file in PLAYBOOKS_DIR.rglob("*.md"):
            content = pb_file.read_text(encoding="utf-8", errors="replace")
            lines = content.split("\n")
            for line in lines:
                ll = line.lower()
                if any(k in ll for k in keywords) and ("힌트" in ll or "에러" in ll or "패턴" in ll or "해결" in ll):
                    matches.append(line.strip()[:120])
            if len(matches) >= 3:
                break
    except Exception:
        pass
    return "\n".join(matches[:3]) if matches else ""


BASE = "http://127.0.0.1:3344"
_BUS_TOKEN_FILE = Path.home() / ".openclaw" / ".bus-token"
_BUS_TOKEN = _BUS_TOKEN_FILE.read_text().strip() if _BUS_TOKEN_FILE.exists() else ""
# WORKSPACE already defined at module top (line 52)
CONFIG_PATH = Path("/Users/ron/.openclaw/openclaw.json")
APPROVAL_DB = WORKSPACE / "data" / "approvals.db"
TELEGRAM_CHAT_ID = 492860021

# --- Critical action classification ---
CRITICAL_KEYWORDS = [
    "삭제", "제거", "drop", "delete", "remove",
    "재시작", "restart", "reboot", "kill",
    "배포", "deploy", "push", "릴리즈",
    "마이그레이션", "migration", "스키마 변경",
    "크론 변경", "cron 수정", "schedule",
    "모델 변경", "model switch", "라우팅 변경",
    "권한", "permission", "auth", "토큰",
    "백업 복구", "restore", "롤백", "rollback",
]

def _get_bot_token() -> str:
    try:
        cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        return cfg["channels"]["telegram"]["botToken"]
    except Exception:
        return ""

def _send_telegram_dm(text: str) -> bool:
    token = _get_bot_token()
    if not token:
        return False
    from urllib.request import Request as _Req, urlopen as _open
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    payload = json.dumps({
        "chat_id": TELEGRAM_CHAT_ID,
        "text": text,
        "parse_mode": "HTML",
    }).encode("utf-8")
    req = _Req(url, data=payload, headers={"Content-Type": "application/json"})
    try:
        with _open(req, timeout=15) as r:
            return r.status == 200
    except Exception:
        return False

def _init_approval_db():
    APPROVAL_DB.parent.mkdir(parents=True, exist_ok=True)
    with db_transaction(APPROVAL_DB) as con:
        con.execute("""CREATE TABLE IF NOT EXISTS approvals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            cmd_id INTEGER,
            agent TEXT,
            title TEXT,
            reason TEXT,
            status TEXT DEFAULT 'pending',
            created_at TEXT DEFAULT (datetime('now','localtime')),
            resolved_at TEXT,
            resolved_by TEXT
        )""")

def is_critical_action(title: str, body: str) -> tuple[bool, str]:
    """Check if a command requires human approval."""
    text = f"{title} {body}".lower()
    matched = [k for k in CRITICAL_KEYWORDS if k in text]
    if matched:
        return True, f"critical keywords: {', '.join(matched[:3])}"
    return False, ""

def request_approval(cmd_id: int, agent: str, title: str, reason: str) -> int:
    """Register approval request and send Telegram DM."""
    _init_approval_db()
    with db_transaction(APPROVAL_DB) as con:
        cur = con.execute(
            "INSERT INTO approvals (cmd_id, agent, title, reason) VALUES (?,?,?,?)",
            (cmd_id, agent, title, reason),
        )
        approval_id = cur.lastrowid

    # Send Telegram DM
    msg = (
        f"<b>🔐 승인 요청 #{approval_id}</b>\n\n"
        f"<b>명령:</b> CMD#{cmd_id}\n"
        f"<b>에이전트:</b> {agent}\n"
        f"<b>제목:</b> {title[:80]}\n"
        f"<b>사유:</b> {reason}\n\n"
        f"대시보드에서 확인: http://localhost:3355/system\n"
        f"승인: /approve {approval_id}\n"
        f"거부: /reject {approval_id}"
    )
    _send_telegram_dm(msg)
    return approval_id

def check_approval_status(approval_id: int) -> str:
    """Check if approval is granted. Returns 'pending', 'approved', 'rejected'."""
    import sqlite3
    if not APPROVAL_DB.exists():
        return "pending"
    with db_connection(APPROVAL_DB, row_factory=sqlite3.Row) as con:
        row = con.execute("SELECT status FROM approvals WHERE id=?", (approval_id,)).fetchone()
    return row["status"] if row else "pending"
RON_BRIEF_SCRIPT = str(WORKSPACE / "scripts" / "ron_structure_brief.py")
RON_BRIEF_JSON = WORKSPACE / "knowledge" / "system" / "ron_structure_brief.json"
TRIAD_SYNC_JSON = WORKSPACE / "knowledge" / "system" / "triad_directive_sync.json"
TRIAD_SYNC_MD = WORKSPACE / "knowledge" / "00-System" / "TRIAD_DIRECTIVE_SYNC.md"

RON_BRIEF_CACHE = {"summary": "", "phase": "", "hash": "", "last_sync": 0.0}
AGENT_START_STAGGER = {
    "ron": 0.0,
    "codex": 0.9,
    "cowork": 1.8,
}

# Rate-limit backoff: (consecutive_failure_threshold, sleep_seconds)
BACKOFF_THRESHOLDS = [(3, 30), (5, 60), (10, 300)]


def _bus_headers(extra=None):
    h = {}
    if _BUS_TOKEN:
        h["X-Ops-Token"] = _BUS_TOKEN
    if extra:
        h.update(extra)
    return h


def jget(path: str, timeout: float = 10.0) -> dict:
    req = Request(BASE + path, headers=_bus_headers(), method="GET")
    with urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def jpost(path: str, payload: dict, timeout: float = 15.0) -> dict:
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = Request(
        BASE + path,
        data=data,
        headers=_bus_headers({"Content-Type": "application/json"}),
        method="POST",
    )
    try:
        with urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        return {"error": f"http_{exc.code}", "body": body}
    except URLError as exc:
        return {"error": "url_error", "body": str(exc)}


def _sha256_of_file(p: Path) -> str:
    try:
        import hashlib
        h = hashlib.sha256()
        with p.open('rb') as f:
            for chunk in iter(lambda: f.read(8192), b''):
                h.update(chunk)
        return h.hexdigest()
    except Exception:
        return ""


def run_cmd(cmd: list[str], timeout: int = 120) -> tuple[int, str, str]:
    """
    Secure wrapper around subprocess.run with least-privilege checks.
    - Refuse to execute if running as root (prevent accidental escalation).
    - Use shell=False (already used) and shlex-safe argv.
    - If the command appears to modify workspace files, compute and log sha256 before/after for whitelist-only paths.
    """
    try:
        # Prevent running dangerous escalation as root
        if hasattr(os, 'geteuid') and os.geteuid() == 0:
            return 1, "", "refused: running as root"
    except Exception:
        pass

    # Detect potential workspace-modifying commands
    cmd_line = " ".join(cmd)
    modifies_workspace = any(k in cmd_line for k in ["export-obsidian", "run-cycle", "migrate", "push", "deploy", "knowledge_os.py", "export-obsidian"]) or str(WORKSPACE) in cmd_line

    pre_hashes = {}
    if modifies_workspace:
        # Only allow hashing/inspecting whitelisted paths inside workspace
        for candidate in [WORKSPACE / "knowledge", WORKSPACE / "memory", WORKSPACE / "scripts"]:
            if candidate.exists():
                # compute hashes for top-level files (not recursing deeply)
                for p in candidate.iterdir():
                    if p.is_file() and p.stat().st_size < 5 * 1024 * 1024:  # limit 5MB per file
                        pre_hashes[str(p)] = _sha256_of_file(p)

    p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, check=False)

    post_hashes = {}
    if modifies_workspace:
        for path_str, old_hash in pre_hashes.items():
            pth = Path(path_str)
            post_hashes[path_str] = _sha256_of_file(pth) if pth.exists() else "(deleted)"

        # Log before/after diffs for changed files
        for path_str, before in pre_hashes.items():
            after = post_hashes.get(path_str, "")
            if before != after:
                log(f"[file-hash] {path_str} before={before[:8]} after={after[:8]}")

    return p.returncode, (p.stdout or ""), (p.stderr or "")


def shorten(s: str, n: int = 400) -> str:
    s = " ".join((s or "").split())
    if len(s) <= n:
        return s
    return s[: n - 3] + "..."


def post_queue_update(path: str, payload: dict, retries: int = 4, base_sleep: float = 0.7) -> tuple[bool, dict]:
    last: dict = {}
    for i in range(max(1, int(retries))):
        res = jpost(path, payload)
        if not res.get("error"):
            return True, res
        last = res
        time.sleep(base_sleep * float(i + 1))
    return False, last


def _load_cached_brief_from_file() -> None:
    if not RON_BRIEF_JSON.exists():
        return
    try:
        data = json.loads(RON_BRIEF_JSON.read_text(encoding="utf-8"))
    except Exception:
        return
    RON_BRIEF_CACHE["summary"] = str(data.get("summary") or "").strip()
    RON_BRIEF_CACHE["phase"] = str(data.get("transition_phase") or "").strip()
    RON_BRIEF_CACHE["hash"] = str(data.get("context_hash") or "").strip()


def sync_ron_structure_brief(force: bool = False) -> tuple[bool, str]:
    now = time.time()
    if not force and (now - float(RON_BRIEF_CACHE.get("last_sync") or 0.0)) < 300:
        summary = str(RON_BRIEF_CACHE.get("summary") or "").strip()
        return True, summary or "brief-cached"
    RON_BRIEF_CACHE["last_sync"] = now

    if not os.path.exists(RON_BRIEF_SCRIPT):
        _load_cached_brief_from_file()
        summary = str(RON_BRIEF_CACHE.get("summary") or "").strip()
        if summary:
            return True, summary
        return False, "brief-script-missing"

    rc, out, err = run_cmd(["/usr/bin/python3", RON_BRIEF_SCRIPT, "--quiet"], timeout=30)
    if rc != 0:
        _load_cached_brief_from_file()
        summary = str(RON_BRIEF_CACHE.get("summary") or "").strip()
        if summary:
            return True, summary
        return False, f"brief-sync-failed: {shorten(err)}"

    out_s = (out or "").strip()
    parsed = None
    if out_s.startswith("{"):
        try:
            parsed = json.loads(out_s)
        except Exception:
            parsed = None
    if isinstance(parsed, dict):
        RON_BRIEF_CACHE["summary"] = str(parsed.get("summary") or "").strip()
        RON_BRIEF_CACHE["phase"] = str(parsed.get("transition_phase") or "").strip()
        RON_BRIEF_CACHE["hash"] = str(parsed.get("context_hash") or "").strip()
    else:
        _load_cached_brief_from_file()
    summary = str(RON_BRIEF_CACHE.get("summary") or "").strip()
    return True, summary or "brief-refreshed"


def read_triad_sync_snapshot() -> dict:
    if not TRIAD_SYNC_JSON.exists():
        return {}
    try:
        data = json.loads(TRIAD_SYNC_JSON.read_text(encoding="utf-8"))
    except Exception:
        return {}
    if not isinstance(data, dict):
        return {}
    return data


def _handle_triad_sync(agent: str, text: str) -> tuple[bool, str] | None:
    """Handle triad sync commands. Returns None if not a triad sync command."""
    if not any(k in text for k in ["공통 지시 동기화", "directive sync", "triad sync", "[sync:"]):
        return None

    snap = read_triad_sync_snapshot()
    digest = str(snap.get("digest_short") or snap.get("digest") or "")[:8]
    cnt = int(snap.get("directive_count") or 0)
    md_ok = TRIAD_SYNC_MD.exists()
    js_ok = TRIAD_SYNC_JSON.exists()

    if agent == "ron":
        okb, note = sync_ron_structure_brief(force=True)
        if not okb:
            return False, f"triad sync failed (brief): {note}"
        return True, (
            f"triad sync applied: digest={digest or 'na'} directives={cnt} "
            f"files(md={int(md_ok)},json={int(js_ok)})"
        )

    if agent == "codex":
        if not js_ok:
            return False, "triad sync json missing"
        return True, (
            f"triad sync acknowledged by codex: digest={digest or 'na'} directives={cnt} "
            f"source={TRIAD_SYNC_JSON}"
        )

    if agent == "cowork":
        return True, (
            f"triad sync acknowledged by cowork: digest={digest or 'na'} directives={cnt} "
            f"source={TRIAD_SYNC_MD}"
        )

    return None


def _handle_ron(title: str, body: str, text: str) -> tuple[bool, str]:
    """Handle ron agent commands."""

    # ── 할일 관리 (텔레그램 → Ron) ──
    _TODO_ADD_KW = ["할일 추가", "할일 등록"]
    _TODO_CHECK_KW = ["할일 확인", "할일 목록", "할일 브리핑", "/todo"]
    _TODO_DONE_KW = ["할일 완료"]
    _TODO_CANCEL_KW = ["할일 삭제", "할일 취소"]

    if any(k in text for k in _TODO_ADD_KW):
        # "할일 추가: 블로그 파이프라인 구축 !urgent" 형식 파싱
        import re
        # title에서 키워드 뒤 콘텐츠 추출 (title 또는 body에서)
        todo_text = text
        for kw in _TODO_ADD_KW:
            idx = todo_text.find(kw)
            if idx >= 0:
                todo_text = todo_text[idx + len(kw):]
                break
        # 구분자 제거 (: 또는 공백)
        todo_text = todo_text.lstrip(":： ").strip()
        if not todo_text:
            return False, "[액션] 할일 추가 실패\n[분석] 제목이 비어 있음\n[판단] '할일 추가: 제목' 형식으로 입력해주세요"
        # 우선순위 파싱
        priority = "normal"
        for tag, pri in [("!urgent", "urgent"), ("!high", "high"), ("!low", "low")]:
            if tag in todo_text:
                priority = pri
                todo_text = todo_text.replace(tag, "").strip()
                break
        # ID 추출 시도 안함, 제목으로 직접 추가
        try:
            from pipeline.task_briefing import add_todo
            new_id = add_todo(todo_text, priority=priority, source="telegram")
            return True, (
                f"[액션] 할일 추가 완료\n"
                f"[분석] #{new_id} {todo_text} (priority={priority})\n"
                f"[판단] 할일이 등록되었습니다"
            )
        except Exception as e:
            return False, f"[액션] 할일 추가 실패\n[분석] {e}\n[판단] DB 오류 — 로그 확인 필요"

    if any(k in text for k in _TODO_CHECK_KW):
        rc, out, err = run_cmd([
            "/usr/bin/python3",
            str(WORKSPACE / "scripts" / "pipeline" / "task_briefing.py"),
            "--on-demand",
        ], timeout=30)
        if rc != 0:
            return False, f"[액션] 할일 확인 실패\n[분석] rc={rc} err={shorten(err)}\n[판단] 파이프라인 실행 오류"
        # 인라인 버튼 메시지도 발송
        run_cmd([
            "/usr/bin/python3",
            str(WORKSPACE / "scripts" / "pipeline" / "task_briefing.py"),
            "--buttons",
        ], timeout=30)
        return True, f"[액션] 할일 현황 조회\n[분석]\n{shorten(out, 800)}\n[판단] 할일 목록 + 버튼 발송 완료"

    if any(k in text for k in _TODO_DONE_KW):
        import re
        m = re.search(r"#?(\d+)", text[text.find("완료"):] if "완료" in text else text)
        if not m:
            return False, "[액션] 할일 완료 실패\n[분석] ID를 찾을 수 없음\n[판단] '할일 완료 #42' 형식으로 입력해주세요"
        todo_id = int(m.group(1))
        try:
            from pipeline.task_briefing import complete_todo
            ok = complete_todo(todo_id)
            if ok:
                return True, f"[액션] 할일 #{todo_id} 완료 처리\n[분석] status → done\n[판단] 정상 완료"
            return False, f"[액션] 할일 #{todo_id} 완료 실패\n[분석] 이미 완료되었거나 존재하지 않음\n[판단] ID 확인 필요"
        except Exception as e:
            return False, f"[액션] 할일 완료 실패\n[분석] {e}\n[판단] DB 오류"

    if any(k in text for k in _TODO_CANCEL_KW):
        import re
        m = re.search(r"#?(\d+)", text[text.find("취소"):] if "취소" in text else (text[text.find("삭제"):] if "삭제" in text else text))
        if not m:
            return False, "[액션] 할일 취소 실패\n[분석] ID를 찾을 수 없음\n[판단] '할일 취소 #42' 형식으로 입력해주세요"
        todo_id = int(m.group(1))
        try:
            from pipeline.task_briefing import cancel_todo
            ok = cancel_todo(todo_id)
            if ok:
                return True, f"[액션] 할일 #{todo_id} 취소 처리\n[분석] status → cancelled\n[판단] 정상 취소"
            return False, f"[액션] 할일 #{todo_id} 취소 실패\n[분석] 이미 취소되었거나 존재하지 않음\n[판단] ID 확인 필요"
        except Exception as e:
            return False, f"[액션] 할일 취소 실패\n[분석] {e}\n[판단] DB 오류"

    if any(k in text for k in ["구조 인지", "전체 구조", "structure brief", "아키텍처 브리프", "context sync"]):
        okb, note = sync_ron_structure_brief(force=True)
        if not okb:
            return False, note
        phase = str(RON_BRIEF_CACHE.get("phase") or "").strip()
        return True, f"structure brief refreshed: {shorten(note, 120)}" + (f" (phase={phase})" if phase else "")

    # Ron: runtime/automation/knowledge cycle responsibilities.
    if any(k in text for k in ["run-cycle", "지식 순환", "knowledge cycle"]):
        rc, out, err = run_cmd([
            "/usr/bin/python3",
            str(WORKSPACE / "scripts" / "knowledge_os.py"),
            "run-cycle",
            "--domain",
            "strategy",
        ])
        if rc != 0:
            return False, f"run-cycle failed rc={rc} err={shorten(err)}"
        return True, f"[액션] run-cycle 실행 완료\n[분석] {shorten(out, 350)}\n[판단] 지식 순환 정상 완료 — obsidian export refreshed"

    if any(k in text for k in ["헬스", "health check", "health", "시스템 전체 상태 점검"]):
        rc, out, err = run_cmd([
            "/usr/bin/python3",
            str(WORKSPACE / "scripts" / "health_check.py"),
        ])
        if rc != 0:
            return False, f"health-check failed rc={rc} err={shorten(err)}"
        # Keep dashboard snapshot fresh after runtime checks.
        run_cmd([
            "/usr/bin/python3",
            str(WORKSPACE / "scripts" / "knowledge_os.py"),
            "refresh-status-snapshot",
        ], timeout=60)
        return True, f"[액션] health_check.py --brief 실행 완료\n[분석] {shorten(out, 350)}\n[판단] 헬스체크 정상"

    if any(k in text for k in ["obsidian", "vault 동기화", "vault sync", "mcp 상태 지식 업데이트"]):
        rc, out, err = run_cmd([
            "/usr/bin/python3",
            str(WORKSPACE / "scripts" / "knowledge_os.py"),
            "export-obsidian",
        ])
        if rc != 0:
            return False, f"export-obsidian failed rc={rc} err={shorten(err)}"
        return True, f"[액션] export-obsidian 실행 완료\n[분석] {shorten(out, 350)}\n[판단] Obsidian vault 동기화 완료"

    if any(k in text for k in ["진화 메트릭", "evolve", "metrics"]):
        rc1, out1, err1 = run_cmd([
            "/usr/bin/python3",
            str(WORKSPACE / "scripts" / "self_evolve.py"),
            "metrics",
        ])
        if rc1 != 0:
            return False, f"self_evolve metrics failed rc={rc1} err={shorten(err1)}"
        rc2, out2, err2 = run_cmd([
            "/usr/bin/python3",
            str(WORKSPACE / "scripts" / "knowledge_os.py"),
            "refresh-status-snapshot",
        ], timeout=60)
        if rc2 != 0:
            return False, f"snapshot refresh failed rc={rc2} err={shorten(err2)}"
        return True, f"[액션] self_evolve.py metrics + snapshot refresh 실행\n[분석] {shorten(out1, 300)}\n[판단] 진화 메트릭 갱신 완료"

    # 인사이트 생성 워크플로우: 파이프라인 직접 실행 (§10 인사이트 자율 생성)
    # "인사이트 품질" 전에 매칭되어야 함 — 가설/인사이트/오늘의 키워드
    _INSIGHT_KW = ["인사이트", "가설", "오늘의 인사이트", "insight", "hypothesis"]
    _INSIGHT_QUALITY_ONLY = ["인사이트 품질", "insight quality"]
    is_quality_check = any(k in text for k in _INSIGHT_QUALITY_ONLY)
    is_insight = any(k in text for k in _INSIGHT_KW) and not is_quality_check

    if is_insight:
        results = []
        # Step 1: discovery_filter (최신 데이터 필터링)
        rc1, out1, err1 = run_cmd([
            "/usr/bin/python3",
            str(WORKSPACE / "scripts" / "pipeline" / "discovery_filter.py"),
        ], timeout=120)
        results.append(f"discovery_filter: rc={rc1} {shorten(out1, 200)}")
        # Step 2: hypothesis_engine (가설 생성/갱신)
        rc2, out2, err2 = run_cmd([
            "/usr/bin/python3",
            str(WORKSPACE / "scripts" / "pipeline" / "hypothesis_engine.py"),
        ], timeout=180)
        results.append(f"hypothesis_engine: rc={rc2} {shorten(out2, 200)}")
        # Step 3: sector_insights (섹터 교차분석)
        rc3, out3, err3 = run_cmd([
            "/usr/bin/python3",
            str(WORKSPACE / "scripts" / "ontology_core.py"),
            "--action", "sector_insights",
        ], timeout=120)
        results.append(f"sector_insights: rc={rc3} {shorten(out3, 200)}")
        # 부분 성공 허용: 1개라도 성공하면 ok=True (전체 실패만 False)
        pipeline = [
            ("discovery_filter", rc1),
            ("hypothesis_engine", rc2),
            ("sector_insights", rc3),
        ]
        failed_steps = [name for name, rc in pipeline if rc != 0]
        ok_steps = [name for name, rc in pipeline if rc == 0]
        any_ok = len(ok_steps) > 0
        detail = "\n".join(results)
        if not failed_steps:
            judgment = "정상 완료"
        elif any_ok:
            judgment = f"정상 완료 (일부 실패: {', '.join(failed_steps)})"
        else:
            judgment = f"실패({', '.join(failed_steps)}) — 로그 확인 필요"
        return any_ok, (
            f"[액션] discovery_filter + hypothesis_engine + sector_insights 파이프라인 실행\n"
            f"[분석] {detail}\n"
            f"[판단] 인사이트 파이프라인 {judgment}"
        )

    if is_quality_check:
        rc1, out1, err1 = run_cmd([
            "/usr/bin/python3",
            str(WORKSPACE / "scripts" / "knowledge_os.py"),
            "refresh-status-snapshot",
        ], timeout=60)
        if rc1 != 0:
            return False, f"snapshot refresh failed rc={rc1} err={shorten(err1)}"
        rc2, out2, err2 = run_cmd([
            "/usr/bin/python3",
            str(WORKSPACE / "scripts" / "knowledge_os.py"),
            "status",
        ], timeout=60)
        if rc2 != 0:
            return False, f"knowledge status failed rc={rc2} err={shorten(err2)}"
        return True, f"[액션] insight scan + knowledge status 실행\n[분석] {shorten(out2, 350)}\n[판단] 인사이트 품질 점검 완료"

    # 능동적 연구 태스크 (§10): LLM으로 연구 수행 → ZK 저장 (다른 키워드보다 우선)
    if any(k in text for k in ["연구", "research", "능동적", "지식 공백", "탐구"]):
        pb = read_relevant_playbook("ron", text)
        extra_ctx = f"[플레이북힌트] {pb}" if pb else ""
        ok, result = llm_execute("ron", title, body, context=extra_ctx)
        # 연구 결과를 버스에 공유 (지식사랑방으로 텔레그램 전달 가능)
        if ok:
            try:
                jpost("/api/bus/send", {
                    "from": "ron",
                    "to": "harry",
                    "type": "research",
                    "body": f"[능동적 연구] {title}\n\n{result[:400]}",
                })
            except Exception:
                pass
        return ok, result

    # 분석/판단이 필요한 복잡한 작업은 LLM으로 라우팅
    analysis_keywords = ["분석", "평가", "제안", "리스크", "전략", "추천", "검토",
                       "비교", "판단", "진단", "설계", "최적화", "개선", "재검증",
                       "재할당", "조사", "해결", "보고", "권고", "식별"]
    # Title에 분석 키워드가 있으면 LLM으로 (body 유무 불문)
    has_analysis_in_title = any(k in title for k in analysis_keywords)
    has_analysis_in_body = any(k in text for k in analysis_keywords) and len(body) > 50
    needs_llm = has_analysis_in_title or has_analysis_in_body

    # 온톨로지 관련 작업 (단순 점검만 — 분석 필요시 LLM)
    if not needs_llm and any(k in text for k in ["온톨로지", "ontology", "무결성", "integrity", "트리플", "triple"]):
        rc, out, err = run_cmd([
            "/usr/bin/python3",
            str(WORKSPACE / "scripts" / "ontology_core.py"),
            "--action", "check_integrity",
        ], timeout=120)
        if rc != 0:
            return False, f"ontology integrity check failed rc={rc} err={shorten(err)}"
        return True, f"ontology integrity: {shorten(out, 400)}"

    # 온톨로지 통계 (단순 조회만 — 분석 필요시 LLM)
    if not needs_llm and any(k in text for k in ["종목", "etf", "섹터", "sector", "포트폴리오", "portfolio", "통계"]):
        rc, out, err = run_cmd([
            "/usr/bin/python3",
            str(WORKSPACE / "scripts" / "ontology_core.py"),
            "--action", "stats",
        ], timeout=60)
        if rc != 0:
            return False, f"ontology stats failed rc={rc} err={shorten(err)}"
        return True, f"ontology stats: {shorten(out, 400)}"

    # 크론 작업 확인 (단순 조회만 — 분석 필요시 LLM)
    if not needs_llm and any(k in text for k in ["크론", "cron", "스케줄", "schedule", "배치"]):
        cron_file = str(WORKSPACE.parent / "cron" / "jobs.json")
        if os.path.exists(cron_file):
            with open(cron_file) as f:
                data = json.load(f)
            jobs = data.get("jobs", []) if isinstance(data, dict) else data if isinstance(data, list) else []
            active = [j for j in jobs if isinstance(j, dict) and j.get("enabled", True)]
            return True, f"cron jobs: {len(jobs)} total, {len(active)} active"
        return False, "cron jobs.json not found"

    # Fallback: 플레이북 힌트 수집 후 LLM 실행 (auto-context는 llm_execute 내부에서 자동 주입)
    pb = read_relevant_playbook("ron", text)
    extra_ctx = f"[플레이북힌트] {pb}" if pb else ""
    return llm_execute("ron", title, body, context=extra_ctx)


def _handle_codex(title: str, body: str, text: str) -> tuple[bool, str]:
    """Handle codex agent commands, including non-coding reroute to cowork."""
    # Codex 비코딩 태스크 감지 → cowork 재라우팅
    _CODING_KW = {"구현", "작성", "수정", "fix", "implement", "script", "코드", "code",
                   "리팩토", "refactor", "패치", "patch", "버그", "bug", "mcp", "문법",
                   "syntax", "compile", "함수", "클래스", "class", "def ", "import"}
    if not any(kw in text for kw in _CODING_KW):
        log(f"[codex→cowork 재라우팅] 비코딩 태스크 감지: {title[:50]}")
        return llm_execute("cowork", title, body)

    # Codex: 도메인 특화 컨텍스트 수집 + auto-context (llm_execute 내부)
    context_parts = []

    # MCP 상태 (도메인 특화)
    if any(k in text for k in ["mcp", "스킬", "skill"]):
        rc, out, err = run_cmd([
            "/usr/bin/python3",
            str(WORKSPACE / "scripts" / "knowledge_os.py"),
            "mcp-check",
        ])
        context_parts.append(f"[MCP상태] rc={rc} {shorten(out) if rc == 0 else shorten(err)}")

    # 코드 품질 검사 (도메인 특화)
    if any(k in text for k in ["코드 품질", "code quality", "문법", "syntax", "코드", "code"]):
        import glob as _glob
        scripts_dir = str(WORKSPACE / "scripts")
        py_files = _glob.glob(scripts_dir + "/*.py")
        errors = []
        for pf in py_files:
            try:
                with open(pf) as f:
                    compile(f.read(), pf, "exec")
            except SyntaxError as e:
                errors.append(f"{os.path.basename(pf)}: {e}")
        if errors:
            context_parts.append(f"[문법오류] {'; '.join(errors[:5])}")
        else:
            context_parts.append(f"[코드품질] {len(py_files)} scripts, 0 syntax errors")

    pb = read_relevant_playbook("codex", text)
    if pb:
        context_parts.append(f"[플레이북힌트] {pb}")

    ctx = "\n".join(context_parts) if context_parts else ""
    return llm_execute("codex", title, body, context=ctx)


def _handle_cowork(title: str, body: str, text: str) -> tuple[bool, str]:
    """Handle cowork agent commands."""
    # Cowork: 도메인 특화 컨텍스트 수집 + auto-context (llm_execute 내부)
    context_parts = []

    # 에이전트 조율 현황 (도메인 특화)
    if any(k in text for k in ["조율", "coordination", "리뷰", "review", "현황", "에이전트"]):
        try:
            agents_data = jget("/api/bus/agents")
            queue_data = jget("/api/bus/command-queue?limit=20")
            agents_list = agents_data.get("agents", [])
            counts = queue_data.get("counts", {})
            parts = []
            for a in agents_list:
                name = a.get("agent", "?")
                alive = "ON" if a.get("alive") else "OFF"
                task = str(a.get("current_task", "-"))[:40]
                parts.append(f"{name}:{alive}|{task}")
            status = " / ".join(parts)
            status += f" || q={counts.get('queued',0)} c={counts.get('claimed',0)} d={counts.get('done',0)}"
            context_parts.append(f"[에이전트현황] {status}")
        except Exception:
            pass

    # 진화 메트릭 (도메인 특화)
    if any(k in text for k in ["진화", "evolve", "메트릭", "metrics"]):
        rc, out, err = run_cmd([
            "/usr/bin/python3",
            str(WORKSPACE / "scripts" / "self_evolve.py"),
            "metrics",
        ])
        context_parts.append(f"[진화메트릭] {shorten(out) if rc == 0 else shorten(err)}")

    pb = read_relevant_playbook("cowork", text)
    if pb:
        context_parts.append(f"[플레이북힌트] {pb}")

    ctx = "\n".join(context_parts) if context_parts else ""
    return llm_execute("cowork", title, body, context=ctx)


def _handle_guardian(title: str, body: str, text: str) -> tuple[bool, str]:
    """Handle guardian agent commands."""
    # Guardian: 시스템 수호 — 도메인 특화 컨텍스트 수집
    context_parts = []

    # 프로세스 생존 현황
    if any(k in text for k in ["프로세스", "생존", "health", "헬스", "무결성", "점검", "감시"]):
        for proc_name, label in [("node.*openclaw", "Gateway"), ("ollama", "Ollama"), ("orchestrator", "Orchestrator")]:
            rc, out, _ = run_cmd(["pgrep", "-f", proc_name])
            status = f"PID={out.strip()}" if rc == 0 and out.strip() else "DOWN"
            context_parts.append(f"[{label}] {status}")

    # DB 무결성
    if any(k in text for k in ["db", "DB", "데이터베이스", "무결성", "integrity"]):
        db_path = "/Users/ron/.openclaw/data/ops_multiagent.db"
        try:
            with db_connection(db_path) as conn:
                integrity = conn.execute("PRAGMA integrity_check").fetchone()[0]
                row_count = conn.execute("SELECT COUNT(*) FROM bus_commands").fetchone()[0]
            wal_size = os.path.getsize(db_path + "-wal") if os.path.exists(db_path + "-wal") else 0
            context_parts.append(f"[DB] integrity={integrity}, bus_commands={row_count}건, WAL={wal_size//1024}KB")
        except Exception as e:
            context_parts.append(f"[DB오류] {str(e)[:100]}")

    # 큐 상태 (stale 태스크)
    if any(k in text for k in ["큐", "queue", "stale", "태스크", "동기화"]):
        try:
            queue_data = jget("/api/bus/command-queue?limit=30")
            counts = queue_data.get("counts", {})
            context_parts.append(f"[큐] queued={counts.get('queued',0)} claimed={counts.get('claimed',0)} done={counts.get('done',0)}")
        except Exception:
            pass

    # 디스크
    if any(k in text for k in ["디스크", "disk", "용량", "로그"]):
        rc, out, _ = run_cmd(["df", "-h", "/"])
        if rc == 0:
            lines = out.strip().split("\n")
            if len(lines) >= 2:
                context_parts.append(f"[디스크] {lines[1]}")

    pb = read_relevant_playbook("guardian", text)
    if pb:
        context_parts.append(f"[플레이북힌트] {pb}")

    ctx = "\n".join(context_parts) if context_parts else ""
    return llm_execute("guardian", title, body, context=ctx)


def _handle_data_analyst(title: str, body: str, text: str) -> tuple[bool, str]:
    """Handle data-analyst agent commands."""
    # Data-analyst: 데이터 분석 — 도메인 특화 컨텍스트 수집
    context_parts = []

    # ETF / 온톨로지 통계
    if any(k in text for k in ["etf", "ETF", "conviction", "포트폴리오", "섹터", "가중치"]):
        rc, out, err = run_cmd([
            "/usr/bin/python3",
            str(WORKSPACE / "scripts" / "ontology_core.py"),
            "--action", "stats",
        ])
        if rc == 0:
            context_parts.append(f"[OntologyStats] {shorten(out)}")

    # ZK 지식 현황
    if any(k in text for k in ["지식", "ZK", "제텔", "노트", "공백", "연결", "볼트"]):
        vault = _VAULT_PATH
        inbox_count = len(list((vault / "100 지식" / "110 수신함").glob("*.md"))) if (vault / "100 지식" / "110 수신함").exists() else 0
        # v3: 5 category dirs + legacy 120 노트
        cat_dirs = ["120 기업", "125 시장", "130 산업분석", "135 프로그래밍", "140 인사이트"]
        notes_count = 0
        for cd in cat_dirs:
            d = vault / "100 지식" / cd
            if d.exists():
                notes_count += len(list(d.glob("*.md")))
        legacy_d = vault / "100 지식" / "120 노트"
        if legacy_d.exists():
            notes_count += len(list(legacy_d.glob("*.md")))
        context_parts.append(f"[ZK현황] 수신함={inbox_count}건, 노트={notes_count}건")
        # 파이프라인 결과
        filtered_dir = WORKSPACE / "memory" / "filtered-ideas"
        if filtered_dir.exists():
            filtered_count = len(list(filtered_dir.glob("filtered_*.json")))
            context_parts.append(f"[파이프라인] filtered_ideas={filtered_count}건")
        conn_dir = WORKSPACE / "memory" / "knowledge-connections"
        if conn_dir.exists():
            conn_count = len(list(conn_dir.glob("connections_*.json")))
            context_parts.append(f"[연결분석] connections={conn_count}건")

    # 지능엔진 결과
    if any(k in text for k in ["발견", "discovery", "필터", "인사이트", "아이디어"]):
        ideas_dir = WORKSPACE / "memory" / "github-ideas"
        if ideas_dir.exists():
            idea_count = len(list(ideas_dir.glob("*.md")))
            context_parts.append(f"[GitHub아이디어] {idea_count}건")

    pb = read_relevant_playbook("data-analyst", text)
    if pb:
        context_parts.append(f"[플레이북힌트] {pb}")

    ctx = "\n".join(context_parts) if context_parts else ""
    return llm_execute("data-analyst", title, body, context=ctx)


# Agent handler dispatch table
_AGENT_HANDLERS = {
    "ron": _handle_ron,
    "codex": _handle_codex,
    "cowork": _handle_cowork,
    "guardian": _handle_guardian,
    "data-analyst": _handle_data_analyst,
}


def execute_command(agent: str, cmd_row: dict) -> tuple[bool, str]:
    title = str(cmd_row.get("title") or "")
    body = str(cmd_row.get("body") or "")
    text = f"{title} {body}".lower()

    # Minimal inbound payload validation (least-privilege): ensure expected keys and types
    if not isinstance(cmd_row, dict):
        return False, "invalid payload: cmd_row must be a dict"
    for k in ("id", "title", "body"):
        if k not in cmd_row:
            return False, f"invalid payload: missing {k}"
    # Whitelist-only file operations check: refuse payloads that reference absolute paths outside workspace
    abs_path_pattern = re.compile(r"(/[^\s]+)")
    for m in abs_path_pattern.findall(body):
        if m.startswith(str(WORKSPACE)):
            continue
        # Allow localhost URLs and simple tokens, but refuse system absolute paths
        if m.startswith("/usr") or m.startswith("/etc") or m.startswith("/bin") or m.startswith("/sbin"):
            return False, f"refused: payload references system path {m}"
    # limit body size
    if len(body) > 2000:
        return False, "refused: body too large"

    # 공통: triad 지시 동기화 명령은 3에이전트 모두 동일 digest를 인지해야 한다.
    triad_result = _handle_triad_sync(agent, text)
    if triad_result is not None:
        return triad_result

    # Route to per-agent handler
    handler = _AGENT_HANDLERS.get(agent)
    if handler:
        return handler(title, body, text)

    # Unknown agent fallback
    if agent in AGENT_MODEL_MAP:
        return llm_execute(agent, title, body)

    return False, f"unknown agent: {agent}"


LAST_TASK_DONE = {}

def descriptive_status(agent):
    """Show what the agent just did or is ready for, not just 'polling'"""
    last = LAST_TASK_DONE.get(agent, "")
    ron_suffix = ""
    if agent == "ron":
        summary = str(RON_BRIEF_CACHE.get("summary") or "").strip()
        phase = str(RON_BRIEF_CACHE.get("phase") or "").strip()
        h = str(RON_BRIEF_CACHE.get("hash") or "").strip()
        hs = h[:8] if h else ""
        parts = []
        if phase:
            parts.append(f"phase={phase}")
        if hs:
            parts.append(f"h={hs}")
        if summary:
            parts.append(shorten(summary, 46))
        if parts:
            ron_suffix = " | 구조인지 " + " ".join(parts)
    role_map = {
        "ron": "지식관리 대기 (run-cycle/헬스/인사이트)" + ron_suffix,
        "codex": "코드관리 대기 (MCP/스킬/품질검사)",
        "cowork": "조율 대기 (진화메트릭/구조리뷰/버스분석)",
    }
    if last:
        return last + " 완료 → 다음 작업 대기"
    return role_map.get(agent, "작업 대기중")


def update_status(agent: str, task: str) -> None:
    jpost(
        "/api/bus/agent-status",
        {
            "agent": agent,
            "alive": True,
            "current_task": task,
        },
    )


STALE_CLAIM_SECONDS = 300  # 5 minutes — reclaim if stuck

def pick_command(agent: str) -> dict | None:
    query = urlencode({"agent": agent, "stale_sec": STALE_CLAIM_SECONDS})
    data = jget(f"/api/bus/command-queue/pick?{query}")
    if data and data.get("command"):
        return data["command"]
    return None


def process_once(agent: str, dry_run: bool = False) -> dict:
    if agent == "ron":
        sync_ron_structure_brief(force=False)
    update_status(agent, descriptive_status(agent))
    row = pick_command(agent)
    if not row:
        return {"status": "idle", "agent": agent}

    cid = int(row.get("id"))
    title = str(row.get("title") or "")
    already_claimed = str(row.get("status") or "") == "claimed" and str(row.get("claimed_by") or "") == agent

    if already_claimed:
        update_status(agent, f"re-processing stale #{cid} {title}")
    else:
        update_status(agent, f"claiming #{cid} {title}")
        claim = jpost("/api/bus/command-queue/claim", {"id": cid, "agent": agent})
        if claim.get("error"):
            return {"status": "skipped", "reason": "claim_conflict", "command_id": cid, "detail": claim}

    if dry_run:
        note = "dry-run: command claimed and marked complete without execution"
        ok_done, done = post_queue_update("/api/bus/command-queue/complete", {"id": cid, "agent": agent, "note": note})
        if not ok_done:
            fail_note = f"dry-run complete update failed: {shorten(json.dumps(done, ensure_ascii=False), 180)}"
            post_queue_update("/api/bus/command-queue/fail", {"id": cid, "agent": agent, "note": fail_note})
            update_status(agent, descriptive_status(agent))
            return {"status": "failed", "dry_run": True, "command_id": cid, "note": fail_note, "detail": done}
        update_status(agent, descriptive_status(agent))
        return {"status": "done", "dry_run": True, "command_id": cid, "detail": done}

    try:
        ok, note = execute_command(agent, row)
    except Exception as exc:
        ok, note = False, f"execute_command exception: {type(exc).__name__}: {str(exc)[:200]}"

    if ok:
        ok_done, done = post_queue_update("/api/bus/command-queue/complete", {"id": cid, "agent": agent, "note": note})
        if not ok_done:
            fail_note = f"complete update failed after execution: {shorten(json.dumps(done, ensure_ascii=False), 180)}"
            post_queue_update("/api/bus/command-queue/fail", {"id": cid, "agent": agent, "note": fail_note})
            LAST_TASK_DONE[agent] = title[:20] + " (완료기록실패)"
            log_to_memory(agent, title, f"FAILED: {fail_note}", "critical")
            update_status(agent, descriptive_status(agent))
            return {"status": "failed", "command_id": cid, "note": fail_note, "detail": done}
        LAST_TASK_DONE[agent] = title[:20]
        # Observational memory auto-log
        pri = str(row.get("priority") or "normal")
        if pri == "high" or "fail" in note.lower() or "error" in note.lower():
            log_to_memory(agent, title, note, "critical")
        elif "passed" not in note and "refreshed" not in note:
            log_to_memory(agent, title, note, "low")
        update_status(agent, descriptive_status(agent))
        return {"status": "done", "command_id": cid, "note": note, "detail": done}

    ok_fail, fail = post_queue_update("/api/bus/command-queue/fail", {"id": cid, "agent": agent, "note": note})
    if not ok_fail:
        fail_note = f"fail update error: {shorten(json.dumps(fail, ensure_ascii=False), 180)}"
        log_to_memory(agent, title, f"FAILED: {note} / {fail_note}", "critical")
        update_status(agent, descriptive_status(agent))
        return {"status": "failed", "command_id": cid, "note": f"{note} | {fail_note}", "detail": fail}
    LAST_TASK_DONE[agent] = title[:20] + " (실패)"
    log_to_memory(agent, title, f"FAILED: {note}", "critical")
    update_status(agent, descriptive_status(agent))
    return {"status": "failed", "command_id": cid, "note": note, "detail": fail}


def process_burst(agent: str, dry_run: bool, burst_max: int) -> dict:
    max_n = max(1, int(burst_max))
    results: list[dict] = []
    for _ in range(max_n):
        r = process_once(agent, dry_run=dry_run)
        results.append(r)
        st = str(r.get("status") or "idle")
        if st in {"idle", "skipped"}:
            break
        if st in {"done", "failed"}:
            continue
        break

    if not results:
        return {"status": "idle", "agent": agent, "handled": 0, "results": []}

    statuses = [str(r.get("status") or "idle") for r in results]
    if "failed" in statuses:
        top_status = "failed"
    elif "done" in statuses:
        top_status = "done"
    else:
        top_status = statuses[-1]
    return {
        "status": top_status,
        "agent": agent,
        "handled": sum(1 for s in statuses if s in {"done", "failed"}),
        "results": results,
    }


def compute_sleep_seconds(status: str, handled: int, interval: float, fast_interval: float, jitter: float, consecutive_idle: int = 0) -> float:
    if status in {"done", "failed", "skipped"} or handled >= 1:
        # Active: fast polling
        base = float(fast_interval)
    else:
        # Idle: exponential backoff — 2s, 4s, 8s, 16s, max 30s
        base = min(float(interval) * (2 ** min(consecutive_idle, 4)), 30.0)
    base = max(0.8, base)
    jitter = max(0.0, float(jitter))
    low = max(0.8, base - jitter)
    high = max(low, base + jitter)
    return random.uniform(low, high)


def main() -> None:
    ap = argparse.ArgumentParser(description="Agent command-queue worker")
    ap.add_argument("--agent", required=True, choices=["ron", "codex", "cowork", "guardian", "data-analyst"])
    ap.add_argument("--once", action="store_true", help="run one cycle and exit")
    ap.add_argument("--interval", type=float, default=2.0, help="base poll interval seconds")
    ap.add_argument(
        "--fast-interval",
        type=float,
        default=0.45,
        help="poll interval after a task was handled",
    )
    ap.add_argument(
        "--jitter",
        type=float,
        default=0.35,
        help="random +/- jitter to avoid synchronized polling",
    )
    ap.add_argument(
        "--burst-max",
        type=int,
        default=2,
        help="max commands to process per loop when queue is non-empty",
    )
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if args.once:
        print(json.dumps(process_burst(args.agent, dry_run=args.dry_run, burst_max=args.burst_max), ensure_ascii=False, indent=2))
        return

    stagger = AGENT_START_STAGGER.get(args.agent, 0.0)
    if stagger > 0:
        time.sleep(stagger)

    consecutive_failures = 0
    consecutive_idle = 0

    while True:
        status = "idle"
        handled = 0
        try:
            result = process_burst(args.agent, dry_run=args.dry_run, burst_max=args.burst_max)
            status = str(result.get("status") or "idle")
            handled = int(result.get("handled") or 0)
            print(json.dumps(result, ensure_ascii=False), flush=True)
        except Exception as exc:  # noqa: BLE001
            print(json.dumps({"status": "error", "agent": args.agent, "error": str(exc)}, ensure_ascii=False), flush=True)
            status = "error"

        # --- Idle backoff tracking ---
        if status == "idle" and handled == 0:
            consecutive_idle += 1
        else:
            consecutive_idle = 0

        # --- Rate-limit backoff logic ---
        if status in {"failed", "error"}:
            consecutive_failures += 1
        elif status == "done":
            if consecutive_failures > 0:
                print(json.dumps({"backoff": "reset", "agent": args.agent, "prev_failures": consecutive_failures}, ensure_ascii=False), flush=True)
            consecutive_failures = 0

        backoff_sleep = 0
        for threshold, sleep_sec in BACKOFF_THRESHOLDS:
            if consecutive_failures >= threshold:
                backoff_sleep = sleep_sec

        if backoff_sleep > 0:
            if consecutive_failures >= 10:
                print(json.dumps({"backoff": "RATE-LIMITED", "agent": args.agent, "consecutive_failures": consecutive_failures, "sleep_sec": backoff_sleep, "message": "RATE-LIMITED: agent may be at quota"}, ensure_ascii=False), flush=True)
            else:
                print(json.dumps({"backoff": "active", "agent": args.agent, "consecutive_failures": consecutive_failures, "sleep_sec": backoff_sleep, "message": f"BACKOFF: {consecutive_failures} consecutive failures, sleeping {backoff_sleep}s"}, ensure_ascii=False), flush=True)
            time.sleep(backoff_sleep)
        else:
            time.sleep(compute_sleep_seconds(status, handled, args.interval, args.fast_interval, args.jitter, consecutive_idle))


if __name__ == "__main__":
    main()
