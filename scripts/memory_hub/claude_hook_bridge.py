from __future__ import annotations

from pathlib import Path

TARGET_PROJECT_CWD = Path("/Users/mianfeishitou/Documents/cc").resolve()
CLAUDE_MEMORY_DIR = Path("/Users/mianfeishitou/.claude/projects/-Users-mianfeishitou-Documents-cc/memory")
CLAUDE_MEMORY_INDEX = CLAUDE_MEMORY_DIR / "MEMORY.md"
CLAUDE_HUB_ROOT = Path("/Users/mianfeishitou/.claude/projects/-Users-mianfeishitou-Documents-cc/memory-hub")


def ensure_claude_memory_targets() -> None:
    CLAUDE_MEMORY_DIR.mkdir(parents=True, exist_ok=True)
    if not CLAUDE_MEMORY_INDEX.exists():
        CLAUDE_MEMORY_INDEX.write_text("", encoding="utf-8")


def is_target_project(cwd: str | None) -> bool:
    if not cwd:
        return False
    return Path(cwd).resolve() == TARGET_PROJECT_CWD


def build_user_prompt_event(payload: dict) -> dict | None:
    if not is_target_project(payload.get("cwd")):
        return None
    prompt = (payload.get("prompt") or "").strip()
    if not prompt:
        return None

    ensure_claude_memory_targets()

    if any(token in prompt for token in ["简短", "简洁", "短一点", "别太长", "简单点"]) and any(
        token in prompt for token in ["以后", "默认", "回复", "回答"]
    ):
        target_memory_file = CLAUDE_MEMORY_DIR / "short_reply.md"
        if not target_memory_file.exists():
            target_memory_file.write_text("", encoding="utf-8")
        return {
            "event_type": "user_confirmed",
            "source_host": "claude-code",
            "source_file": str(target_memory_file),
            "payload": {
                "memory_type": "feedback",
                "summary": "用户希望回复尽量短",
                "content": "优先简短直接",
                "why": "用户明确要求默认回复更简短。",
                "how_to_apply": "默认短答，不重复总结 diff，非必要不展开。",
                "stable": True,
                "target_memory_file": str(target_memory_file),
                "target_index_file": str(CLAUDE_MEMORY_INDEX),
                "title": "短回复偏好",
            },
        }

    if "不要总结 diff" in prompt or "别总结 diff" in prompt:
        target_memory_file = CLAUDE_MEMORY_DIR / "short_reply.md"
        if not target_memory_file.exists():
            target_memory_file.write_text("", encoding="utf-8")
        return {
            "event_type": "user_confirmed",
            "source_host": "claude-code",
            "source_file": str(target_memory_file),
            "payload": {
                "memory_type": "feedback",
                "summary": "用户不希望重复总结 diff",
                "content": "默认不要重复总结 diff。",
                "why": "用户明确要求省略重复性 diff 回顾。",
                "how_to_apply": "完成代码修改后直接给结论或下一步，不追加重复 diff 总结。",
                "stable": True,
                "target_memory_file": str(target_memory_file),
                "target_index_file": str(CLAUDE_MEMORY_INDEX),
                "title": "短回复偏好",
            },
        }

    return None


def build_stop_event(payload: dict) -> dict | None:
    if not is_target_project(payload.get("cwd")):
        return None
    last_message = (payload.get("last_assistant_message") or "").strip()
    if not last_message:
        return None

    ensure_claude_memory_targets()

    return {
        "event_type": "session_ending",
        "source_host": "claude-code",
        "source_file": str(CLAUDE_MEMORY_INDEX),
        "payload": {
            "memory_type": "daily_log",
            "summary": "Claude Code 会话收尾",
            "content": last_message,
            "why": "",
            "how_to_apply": "",
            "stable": False,
        },
    }
