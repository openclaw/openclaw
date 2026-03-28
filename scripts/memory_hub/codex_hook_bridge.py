from __future__ import annotations

from datetime import date
from pathlib import Path

CODEX_MEMORIES_DIR = Path("/Users/mianfeishitou/.codex/memories").resolve()
CODEX_MEMORY_INDEX = CODEX_MEMORIES_DIR / "MEMORY.md"
CODEX_HUB_ROOT = Path("/Users/mianfeishitou/.codex/memory-hub")
TARGET_PROJECT_CWD = Path("/Users/mianfeishitou/Documents/cc").resolve()


def ensure_codex_memory_targets() -> None:
    CODEX_MEMORIES_DIR.mkdir(parents=True, exist_ok=True)
    if not CODEX_MEMORY_INDEX.exists():
        CODEX_MEMORY_INDEX.write_text("", encoding="utf-8")


def is_target_project(cwd: str | None) -> bool:
    if not cwd:
        return False
    return Path(cwd).resolve() == TARGET_PROJECT_CWD


def daily_memory_file(today: date | None = None) -> Path:
    current = today or date.today()
    return CODEX_MEMORIES_DIR / f"{current.isoformat()}.md"


def build_user_confirmed_event(payload: dict) -> dict | None:
    if not is_target_project(payload.get("cwd")):
        return None
    summary = (payload.get("summary") or "").strip()
    content = (payload.get("content") or "").strip()
    if not summary or not content:
        return None

    ensure_codex_memory_targets()
    target_memory_file = payload.get("target_memory_file") or str(CODEX_MEMORIES_DIR / "codex_confirmed.md")
    target_path = Path(target_memory_file)
    if not target_path.exists():
        target_path.write_text("", encoding="utf-8")

    return {
        "event_type": "user_confirmed",
        "source_host": "codex",
        "source_file": str(target_path),
        "payload": {
            "memory_type": payload.get("memory_type", "feedback"),
            "summary": summary,
            "content": content,
            "why": payload.get("why", "Codex 宿主明确确认了该稳定口径。"),
            "how_to_apply": payload.get("how_to_apply", "后续默认按该口径执行。"),
            "stable": True,
            "target_memory_file": str(target_path),
            "target_index_file": str(CODEX_MEMORY_INDEX),
            "title": payload.get("title", summary),
        },
    }


def build_task_completed_event(payload: dict, today: date | None = None) -> dict | None:
    if not is_target_project(payload.get("cwd")):
        return None
    summary = (payload.get("summary") or "").strip()
    content = (payload.get("content") or "").strip()
    if not summary or not content:
        return None

    ensure_codex_memory_targets()
    target_path = daily_memory_file(today)
    if not target_path.exists():
        target_path.write_text("", encoding="utf-8")

    return {
        "event_type": "task_completed",
        "source_host": "codex",
        "source_file": str(target_path),
        "payload": {
            "memory_type": "daily_log",
            "summary": summary,
            "content": content,
            "why": payload.get("why", ""),
            "how_to_apply": payload.get("how_to_apply", ""),
            "stable": False,
            "target_memory_file": str(target_path),
            "target_index_file": str(CODEX_MEMORY_INDEX),
            "title": payload.get("title", summary),
        },
    }
