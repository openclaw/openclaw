#!/usr/bin/env python3
"""Local feedback store for the OpenClaw ↔ SofaGenius feedback loop.

Stores execution telemetry, user corrections, learned patterns, and skill
drafts as append-only JSONL files on the persistent volume (/data/feedback/).

Each bridge script imports this module to auto-log execution results.
The sofagenius-feedback skill reads from this store and syncs to SofaGenius.
"""

import json
import os
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

FEEDBACK_DIR = Path(os.environ.get("OPENCLAW_STATE_DIR", "/data")) / "feedback"

# Separate files for each feedback type
EXECUTIONS_FILE = FEEDBACK_DIR / "executions.jsonl"
CORRECTIONS_FILE = FEEDBACK_DIR / "corrections.jsonl"
PATTERNS_FILE = FEEDBACK_DIR / "patterns.jsonl"
SKILL_DRAFTS_FILE = FEEDBACK_DIR / "skill-drafts.jsonl"
SYNC_CURSOR_FILE = FEEDBACK_DIR / ".sync-cursor.json"


def _ensure_dir() -> None:
    FEEDBACK_DIR.mkdir(parents=True, exist_ok=True)


def _append(filepath: Path, record: dict) -> None:
    _ensure_dir()
    with open(filepath, "a") as f:
        f.write(json.dumps(record) + "\n")


def _read_all(filepath: Path) -> list[dict]:
    if not filepath.exists():
        return []
    records = []
    with open(filepath) as f:
        for line in f:
            line = line.strip()
            if line:
                records.append(json.loads(line))
    return records


def _read_since(filepath: Path, since_ts: float) -> list[dict]:
    return [r for r in _read_all(filepath) if r.get("timestamp", 0) >= since_ts]


# -- Execution telemetry --

@contextmanager
def track_execution(skill: str, action: str, args: dict):
    """Context manager that auto-logs execution telemetry.

    Usage in bridge scripts:
        from shared.feedback_store import track_execution
        with track_execution("sofagenius-training", "training-status", {"run_id": "abc"}) as exe:
            result = api_call("/api/training/status", {"run_id": "abc"})
            exe["result"] = result
            exe["success"] = True
    """
    execution = {
        "id": str(uuid.uuid4()),
        "skill": skill,
        "action": action,
        "args": args,
        "timestamp": time.time(),
        "success": False,
        "result": None,
        "error": None,
        "duration_ms": 0,
    }
    start = time.monotonic()
    try:
        yield execution
    except Exception as e:
        execution["error"] = str(e)
        raise
    finally:
        execution["duration_ms"] = round((time.monotonic() - start) * 1000)
        _append(EXECUTIONS_FILE, execution)


def log_execution(skill: str, action: str, args: dict, result: dict,
                  success: bool, duration_ms: int = 0, error: str | None = None) -> str:
    """Log a completed execution. Returns the execution ID."""
    exe_id = str(uuid.uuid4())
    _append(EXECUTIONS_FILE, {
        "id": exe_id,
        "skill": skill,
        "action": action,
        "args": args,
        "result": result,
        "success": success,
        "duration_ms": duration_ms,
        "error": error,
        "timestamp": time.time(),
    })
    return exe_id


# -- User corrections --

def log_correction(skill: str, action: str, original_args: dict,
                   original_result: dict, correction: str,
                   corrected_args: dict | None = None) -> str:
    """Log when the user corrects agent behavior.

    Example: user says "no, use learning_rate=1e-5 not 3e-4"
    """
    corr_id = str(uuid.uuid4())
    _append(CORRECTIONS_FILE, {
        "id": corr_id,
        "skill": skill,
        "action": action,
        "original_args": original_args,
        "original_result": original_result,
        "correction": correction,
        "corrected_args": corrected_args,
        "timestamp": time.time(),
    })
    return corr_id


# -- Learned patterns --

def log_pattern(pattern_type: str, description: str, evidence: list[str],
                suggested_action: str | None = None) -> str:
    """Log a recurring pattern the agent has observed.

    pattern_type: "hyperparameter", "workflow", "anomaly_resolution", "dataset_preference"
    evidence: list of execution IDs or descriptions that support the pattern
    """
    pat_id = str(uuid.uuid4())
    _append(PATTERNS_FILE, {
        "id": pat_id,
        "type": pattern_type,
        "description": description,
        "evidence": evidence,
        "suggested_action": suggested_action,
        "timestamp": time.time(),
    })
    return pat_id


# -- Skill drafts (user-taught workflows) --

def log_skill_draft(name: str, description: str, steps: list[dict],
                    trigger: str | None = None) -> str:
    """Log a new skill taught by the user.

    steps: [{"action": "launch-propose", "args": {...}}, ...]
    trigger: optional condition for proactive execution
    """
    draft_id = str(uuid.uuid4())
    _append(SKILL_DRAFTS_FILE, {
        "id": draft_id,
        "name": name,
        "description": description,
        "steps": steps,
        "trigger": trigger,
        "status": "draft",
        "timestamp": time.time(),
    })
    return draft_id


# -- Query helpers --

def get_executions(since_ts: float = 0, skill: str | None = None) -> list[dict]:
    records = _read_since(EXECUTIONS_FILE, since_ts)
    if skill:
        records = [r for r in records if r.get("skill") == skill]
    return records


def get_corrections(since_ts: float = 0) -> list[dict]:
    return _read_since(CORRECTIONS_FILE, since_ts)


def get_patterns(since_ts: float = 0) -> list[dict]:
    return _read_since(PATTERNS_FILE, since_ts)


def get_skill_drafts(since_ts: float = 0) -> list[dict]:
    return _read_since(SKILL_DRAFTS_FILE, since_ts)


def get_stats() -> dict:
    """Aggregate stats across all feedback types."""
    exes = _read_all(EXECUTIONS_FILE)
    corrections = _read_all(CORRECTIONS_FILE)
    patterns = _read_all(PATTERNS_FILE)
    drafts = _read_all(SKILL_DRAFTS_FILE)

    skill_counts: dict[str, int] = {}
    failure_counts: dict[str, int] = {}
    for exe in exes:
        sk = exe.get("skill", "unknown")
        skill_counts[sk] = skill_counts.get(sk, 0) + 1
        if not exe.get("success"):
            failure_counts[sk] = failure_counts.get(sk, 0) + 1

    return {
        "total_executions": len(exes),
        "total_corrections": len(corrections),
        "total_patterns": len(patterns),
        "total_skill_drafts": len(drafts),
        "executions_by_skill": skill_counts,
        "failures_by_skill": failure_counts,
    }


# -- Sync cursor (tracks what's been sent to SofaGenius) --

def get_sync_cursor() -> dict:
    if SYNC_CURSOR_FILE.exists():
        return json.loads(SYNC_CURSOR_FILE.read_text())
    return {"last_sync_ts": 0, "synced_count": 0}


def set_sync_cursor(ts: float, count: int) -> None:
    _ensure_dir()
    cursor = {"last_sync_ts": ts, "synced_count": count}
    SYNC_CURSOR_FILE.write_text(json.dumps(cursor))


def get_unsynced_feedback() -> dict:
    """Get all feedback that hasn't been synced to SofaGenius yet."""
    cursor = get_sync_cursor()
    since = cursor["last_sync_ts"]
    return {
        "executions": get_executions(since_ts=since),
        "corrections": get_corrections(since_ts=since),
        "patterns": get_patterns(since_ts=since),
        "skill_drafts": get_skill_drafts(since_ts=since),
    }
