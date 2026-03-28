from __future__ import annotations

from datetime import date
from pathlib import Path

OPENCLAW_ROOT = Path("/Users/mianfeishitou/OpenClaw/state/workspace-daily").resolve()
OPENCLAW_MEMORY_INDEX = OPENCLAW_ROOT / "MEMORY.md"
OPENCLAW_MEMORY_DIR = OPENCLAW_ROOT / "memory"
OPENCLAW_HUB_ROOT = OPENCLAW_ROOT / "memory-hub"


def ensure_openclaw_memory_targets() -> None:
    OPENCLAW_MEMORY_DIR.mkdir(parents=True, exist_ok=True)
    if not OPENCLAW_MEMORY_INDEX.exists():
        OPENCLAW_MEMORY_INDEX.write_text("", encoding="utf-8")


def is_target_workspace(cwd: str | None) -> bool:
    if not cwd:
        return False
    return Path(cwd).resolve() == OPENCLAW_ROOT


def daily_memory_file(today: date | None = None) -> Path:
    current = today or date.today()
    return OPENCLAW_MEMORY_DIR / f"{current.isoformat()}.md"


def build_user_confirmed_event(payload: dict) -> dict | None:
    if not is_target_workspace(payload.get("cwd")):
        return None
    summary = (payload.get("summary") or "").strip()
    content = (payload.get("content") or "").strip()
    if not summary or not content:
        return None

    ensure_openclaw_memory_targets()
    target_memory_file = payload.get("target_memory_file") or str(OPENCLAW_MEMORY_DIR / "openclaw_confirmed.md")
    target_path = Path(target_memory_file)
    if not target_path.exists():
        target_path.write_text("", encoding="utf-8")

    return {
        "event_type": "user_confirmed",
        "source_host": "openclaw",
        "source_file": str(target_path),
        "payload": {
            "memory_type": payload.get("memory_type", "feedback"),
            "summary": summary,
            "content": content,
            "why": payload.get("why", "OpenClaw 宿主明确确认了该稳定口径。"),
            "how_to_apply": payload.get("how_to_apply", "后续默认按该口径执行。"),
            "stable": True,
            "target_memory_file": str(target_path),
            "target_index_file": str(OPENCLAW_MEMORY_INDEX),
            "title": payload.get("title", summary),
        },
    }


def build_task_completed_event(payload: dict, today: date | None = None) -> dict | None:
    if not is_target_workspace(payload.get("cwd")):
        return None
    summary = (payload.get("summary") or "").strip()
    content = (payload.get("content") or "").strip()
    if not summary or not content:
        return None

    ensure_openclaw_memory_targets()
    target_path = daily_memory_file(today)
    if not target_path.exists():
        target_path.write_text("", encoding="utf-8")

    return {
        "event_type": "task_completed",
        "source_host": "openclaw",
        "source_file": str(target_path),
        "payload": {
            "memory_type": "daily_log",
            "summary": summary,
            "content": content,
            "why": payload.get("why", ""),
            "how_to_apply": payload.get("how_to_apply", ""),
            "stable": False,
            "target_memory_file": str(target_path),
            "target_index_file": str(OPENCLAW_MEMORY_INDEX),
            "title": payload.get("title", summary),
        },
    }
