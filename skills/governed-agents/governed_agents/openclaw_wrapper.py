"""
OpenClaw Native Wrapper for Governed Agents.
Uses sessions_spawn tool directly (via inspect/call) and performs verification + reputation.
"""
from __future__ import annotations

import json
import time
import inspect
from pathlib import Path
from typing import Optional, Any

from .contract import TaskContract, TaskResult, TaskStatus
from .orchestrator import score_result
from .verification import run_full_verification
from .reputation import init_db, get_reputation, update_reputation, get_supervision_level

DEFAULT_DB_PATH = "/home/hardy/.openclaw/workspace/.state/governed_agents/reputation.db"
DEFAULT_WORK_DIR = "/tmp/governed"


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
    agent_id: str = "main",
    model: str = "Codex",
    work_dir: str = DEFAULT_WORK_DIR,
    db_path: Optional[str] = None,
) -> TaskResult:
    """
    Spawn a governed sub-agent via OpenClaw sessions_spawn (native).
    Poll session log, parse JSON output, verify, update reputation.
    """
    sessions_spawn = _find_tool("sessions_spawn")

    db_target = db_path or DEFAULT_DB_PATH
    Path(db_target).parent.mkdir(parents=True, exist_ok=True)
    conn = init_db(db_target)
    rep = get_reputation(agent_id, conn)
    supervision = get_supervision_level(rep)

    Path(work_dir).mkdir(parents=True, exist_ok=True)
    prompt = _build_prompt(contract, agent_id, model, rep, supervision)

    # Spawn agent
    spawn_result = sessions_spawn(
        task=prompt,
        agentId=agent_id,
        model=model,
        cleanup="keep",
        runTimeoutSeconds=contract.timeout_seconds,
    )

    session_key = None
    if isinstance(spawn_result, dict):
        session_key = spawn_result.get("childSessionKey")
    if not session_key:
        raise RuntimeError(f"sessions_spawn did not return childSessionKey: {spawn_result}")

    start = time.time()
    raw_output = _poll_session_output(session_key, contract.timeout_seconds)
    elapsed = time.time() - start

    # Parse result
    result = TaskResult.from_agent_output(raw_output, contract.task_id)
    result.objective = contract.objective
    result.retry_count = 0
    result.elapsed_seconds = elapsed

    # Verify if claimed success
    if result.status == TaskStatus.SUCCESS:
        verification = run_full_verification(contract, work_dir)
        result.verification_passed = verification.passed
        if not verification.passed:
            result.what_failed = verification.summary

    # Score + update reputation
    task_score = score_result(result)
    rep_change = update_reputation(
        agent_id=agent_id,
        task_id=contract.task_id,
        score=task_score,
        status=result.status.value,
        details=json.dumps(result.to_dict()),
        objective=contract.objective,
        conn=conn,
    )
    conn.close()

    # Attach reputation delta
    result.reputation_delta = rep_change["delta"]
    result.reputation_before = rep_change["reputation_before"]
    result.reputation_after = rep_change["reputation_after"]

    return result
