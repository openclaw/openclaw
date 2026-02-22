"""
OpenClaw Native Wrapper for Governed Agents.
Uses sessions_spawn tool directly (via inspect/call) and performs verification + reputation.
"""
from __future__ import annotations

import json
import time
import inspect
import os
import re
import uuid
import shutil
import subprocess
from pathlib import Path
from typing import Optional, Any

from .contract import TaskContract, TaskResult, TaskStatus
from .orchestrator import score_result
from .verification import run_full_verification
from .reputation import init_db, get_reputation, update_reputation, get_supervision_level

DEFAULT_DB_PATH = os.environ.get(
    "GOVERNED_DB_PATH",
    str(Path.home() / ".governed_agents" / "reputation.db")
)
DEFAULT_WORK_DIR = os.environ.get("GOVERNED_WORK_DIR", "/tmp/governed")
WORKSPACE = Path(os.environ.get("OPENCLAW_WORKSPACE", Path.cwd()))
CODEX53_CLI = shutil.which("codex") or os.environ.get("CODEX_CLI", "codex")


def _find_tool(name: str):
    """
    Locate an OpenClaw tool callable injected into the current call stack frames.

    OpenClaw performs frame injection for tool functions (e.g., sessions_spawn,
    sessions_history). If this wrapper is invoked outside an OpenClaw tool
    context, the injected callables will not exist and this will raise.
    """
    frame = inspect.currentframe()
    while frame:
        if name in frame.f_locals:
            return frame.f_locals[name]
        if name in frame.f_globals:
            return frame.f_globals[name]
        frame = frame.f_back
    raise RuntimeError(
        f"Tool '{name}' not found. OpenClaw injects tool callables via frame injection; "
        "ensure this wrapper is called from an OpenClaw tool context (not a standalone script)."
    )


def _flatten_content(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                if item.get("type") == "text":
                    parts.append(item.get("text", ""))
            else:
                parts.append(str(item))
        return "".join(parts)
    if isinstance(content, dict) and "text" in content:
        return str(content.get("text", ""))
    return str(content)


def _extract_session_text(messages: list[dict]) -> str:
    output_parts = []
    for msg in messages:
        role = msg.get("role") or msg.get("message", {}).get("role")
        content = msg.get("content") if "content" in msg else msg.get("message", {}).get("content")
        if role == "assistant":
            output_parts.append(_flatten_content(content))
    return "\n".join(p for p in output_parts if p)


def _poll_session_output(session_key: str, timeout: int, poll_interval: float = 1.0) -> str:
    sessions_history = _find_tool("sessions_history")

    start = time.time()
    last_len = -1
    stable_count = 0
    raw_output = ""

    while time.time() - start < timeout:
        data = sessions_history(sessionKey=session_key, limit=200)
        messages = data.get("messages", []) if isinstance(data, dict) else []

        raw_output = _extract_session_text(messages)
        msg_len = len(messages)
        if msg_len == last_len:
            stable_count += 1
        else:
            stable_count = 0
        last_len = msg_len

        # If we already have a JSON block, assume completion
        if "```json" in raw_output and "```" in raw_output:
            break

        # If log is stable for a few polls, assume completion
        if stable_count >= 3 and raw_output:
            break

        time.sleep(poll_interval)

    if not raw_output:
        raw_output = "[no output captured]"

    return raw_output


def _build_prompt(contract: TaskContract, agent_id: str, model: str, rep: float, supervision: dict) -> str:
    prompt = contract.to_prompt()
    prompt += f"""
---
## YOUR CURRENT STATUS
- Agent ID: {agent_id}
- Requested Model: {model}
- Reputation Score: {rep:.2f}/1.0
- Supervision Level: {supervision['level']}
- Note: Your score goes UP for honest work (including honest failure reports).
  Your score goes DOWN for hallucinated success or missing JSON output.
"""
    if supervision.get("checkpoints"):
        prompt += "\n⚠️ You are under INCREASED SUPERVISION. Be extra careful.\n"
    return prompt


def spawn_governed(
    contract: TaskContract,
    engine: str = "codex53",
    agent_id: str = "main",
) -> TaskResult:
    """
    Spawnt einen governed Sub-Agent — engine-unabhängig.

    engine="codex53"  → Codex 5.3 CLI (bevorzugt für Code-Tasks)
    engine="openclaw" → openclaw agent CLI (Fallback / non-code)

    KEINE Command Center Abhängigkeit.
    Governance (Verification + Reputation) läuft bei beiden Engines identisch.
    """
    task_id = contract.task_id or str(uuid.uuid4())[:8]
    if engine == "codex53" and agent_id == "main":
        agent_id = "codex/gpt-5.3-codex"

    criteria_block = "\n".join(f"- {c}" for c in contract.acceptance_criteria)
    files_block = "\n".join(f"- {f}" for f in contract.required_files)
    prompt = f"""GOVERNED TASK [{task_id}]

Objective: {contract.objective}

Acceptance Criteria:
{criteria_block}

Required Files:
{files_block}

When complete, output exactly this JSON block:
{{"status": "SUCCESS" | "BLOCKED" | "FAILED", "what_done": "brief summary", "what_failed": "if applicable, else null", "files_created": ["list"], "self_report": "honest assessment"}}"""

    timeout = getattr(contract, "timeout_seconds", 300)
    task_dir = None

    try:
        if engine == "codex53":
            task_dir = Path(f"/tmp/governed-{task_id}")
            task_dir.mkdir(exist_ok=True)
            subprocess.run(["git", "init"], cwd=str(task_dir), capture_output=True)

            cmd = [CODEX53_CLI, "-m", "gpt-5.3-codex", "exec", "--full-auto", prompt]
            env = {**os.environ, "NO_COLOR": "1"}
            cwd = str(task_dir)
        else:
            cmd = [
                "openclaw",
                "agent",
                "--agent",
                agent_id,
                "--message",
                prompt,
                "--json",
                "--session-id",
                f"governed-{task_id}",
                "--timeout",
                str(timeout),
            ]
            env = os.environ.copy()
            cwd = str(WORKSPACE)

        run_result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout + 30,
            cwd=cwd,
            env=env,
        )
        output = run_result.stdout or run_result.stderr
    except subprocess.TimeoutExpired:
        return _make_result(
            task_id,
            contract,
            "FAILED",
            0.0,
            False,
            what_failed=f"{engine} CLI timeout",
        )
    except FileNotFoundError:
        return _make_result(
            task_id,
            contract,
            "FAILED",
            0.0,
            False,
            what_failed=f"{engine} CLI not found in PATH",
        )
    except Exception as e:
        return _make_result(
            task_id,
            contract,
            "FAILED",
            0.0,
            False,
            what_failed=f"CLI error ({engine}): {e}",
        )
    finally:
        if task_dir and task_dir.exists():
            shutil.rmtree(str(task_dir), ignore_errors=True)

    agent_status = "FAILED"
    agent_output: dict[str, Any] = {}

    match = re.search(r"```json\s*(\{.*?\})\s*```", output, re.DOTALL)
    if not match:
        match = re.search(
            r'\{[^{}]*"status"\s*:\s*"(?:SUCCESS|BLOCKED|FAILED)"[^{}]*\}',
            output,
        )
    if match:
        try:
            raw = match.group(1) if match.lastindex else match.group(0)
            agent_output = json.loads(raw)
            agent_status = agent_output.get("status", "FAILED")
        except json.JSONDecodeError:
            agent_status = "FAILED"

    verification_passed = True
    missing_files = []
    for req_file in contract.required_files:
        path = Path(req_file) if Path(req_file).is_absolute() else WORKSPACE / req_file
        if not path.exists():
            verification_passed = False
            missing_files.append(str(req_file))

    score_map = {"SUCCESS": 1.0, "BLOCKED": 0.5, "FAILED": 0.0}
    task_score = score_map.get(agent_status, 0.0)
    if agent_status == "SUCCESS" and not verification_passed:
        task_score = -1.0

    _update_reputation_direct(
        agent_id=agent_id,
        task_id=task_id,
        score=task_score,
        status=agent_status,
        objective=contract.objective,
    )

    return _make_result(
        task_id,
        contract,
        agent_status,
        task_score,
        verification_passed,
        missing_files=missing_files,
        what_done=agent_output.get("what_done"),
        what_failed=agent_output.get("what_failed"),
    )


def _update_reputation_direct(
    agent_id: str,
    task_id: str,
    score: float,
    status: str,
    objective: str = "",
) -> None:
    """
    Direkter Reputation-Write in SQLite ohne Command Center Abhängigkeit.
    """
    db_target = DEFAULT_DB_PATH
    Path(db_target).parent.mkdir(parents=True, exist_ok=True)
    conn = init_db(db_target)
    update_reputation(
        agent_id=agent_id,
        task_id=task_id,
        score=score,
        status=status.lower(),
        details=json.dumps({"objective": objective, "status": status, "score": score}),
        objective=objective,
        conn=conn,
    )
    conn.close()


def _make_result(
    task_id: str,
    contract: TaskContract,
    status: str,
    score: float,
    verified: bool,
    missing_files: Optional[list[str]] = None,
    what_done: Optional[str] = None,
    what_failed: Optional[str] = None,
) -> TaskResult:
    result = TaskResult(task_id=task_id)
    result.objective = contract.objective
    status_map = {
        "SUCCESS": TaskStatus.SUCCESS,
        "BLOCKED": TaskStatus.BLOCKED,
        "FAILED": TaskStatus.FAILED,
    }
    result.status = status_map.get(status, TaskStatus.FAILED)
    result.verification_passed = verified
    result.task_score = score
    result.missing_files = missing_files or []
    result.what_done = what_done
    result.what_failed = what_failed or ""
    return result


def spawn_governed_http(
    contract: TaskContract,
    endpoint: str = "http://localhost:3010/api/governed/spawn",
    auth_token: Optional[str] = None,
    db_path: Optional[str] = None,
) -> TaskResult:
    """
    HTTP-Mode: Spawnt governed sub-agent via Command Center API.
    Funktioniert aus JEDEM Kontext (subprocess, cron, CLI, exec).
    Kein Frame-Injection nötig.

    Fallback: Returns FAILED TaskResult wenn Endpoint nicht erreichbar.
    """
    import urllib.request
    import urllib.error

    if auth_token is None:
        auth_token = os.environ.get("GOVERNED_AUTH_TOKEN") or os.environ.get("AUTH_TOKEN")
        if not auth_token:
            # Fallback: look for .env in OPENCLAW_WORKSPACE/command-center/
            env_path = WORKSPACE / "command-center" / ".env"
            if env_path.exists():
                for line in env_path.read_text().splitlines():
                    line = line.strip()
                    if line.startswith(("API_TOKEN=", "CC_AUTH_TOKEN=", "AUTH_TOKEN=")):
                        auth_token = line.split("=", 1)[1].strip().strip('"').strip("'")
                        break

    payload = json.dumps({
        "objective": contract.objective,
        "acceptance_criteria": contract.acceptance_criteria,
        "required_files": contract.required_files,
        "model": "Codex",
        "timeout_seconds": contract.timeout_seconds,
        "agent_id": "main",
    }).encode()

    headers = {"Content-Type": "application/json"}
    if auth_token:
        headers["Authorization"] = f"Bearer {auth_token}"

    result = TaskResult(task_id=contract.task_id)
    result.objective = contract.objective

    try:
        req = urllib.request.Request(endpoint, data=payload, headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=contract.timeout_seconds + 60) as resp:
            data = json.loads(resp.read())
    except urllib.error.URLError as e:
        result.status = TaskStatus.FAILED
        result.what_failed = f"HTTP endpoint unreachable: {e}"
        return result
    except Exception as e:
        result.status = TaskStatus.FAILED
        result.what_failed = f"spawn_governed_http error: {e}"
        return result

    status_map = {
        "SUCCESS": TaskStatus.SUCCESS,
        "BLOCKED": TaskStatus.BLOCKED,
        "FAILED": TaskStatus.FAILED,
    }
    result.status = status_map.get(data.get("status"), TaskStatus.FAILED)
    result.verification_passed = data.get("verification_passed", False)
    result.task_score = data.get("task_score", 0.0)
    result.what_failed = data.get("output", {}).get("what_failed", "")
    result.reputation_delta = 0.0  # Already updated server-side
    return result
