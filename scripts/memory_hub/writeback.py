from __future__ import annotations

from pathlib import Path

from scripts.memory_hub.host_adapters import claude_code, codex, openclaw
from scripts.memory_hub.review_queue import enqueue_review_item
from scripts.memory_hub.rollback import create_backup
from scripts.memory_hub.types import SourceRevision


def decide_writeback(candidate: dict) -> dict:
    if candidate.get("risk_level") == "low":
        return {"action": "auto_write"}
    if candidate.get("risk_level") == "medium":
        return {"action": "enqueue_review"}
    return {"action": "raise_conflict"}


def execute_writeback(
    action: dict,
    source_host: str,
    host_roots: dict[str, Path],
    payload: dict,
    expected_revision: SourceRevision,
    hub_root: Path | None = None,
    memory_id: str = "",
) -> dict:
    if action.get("action") == "enqueue_review":
        if hub_root is not None:
            item = enqueue_review_item(
                hub_root,
                {
                    "memory_id": memory_id,
                    "source_host": source_host,
                    "reason": "medium risk",
                    "risk_level": "medium",
                },
            )
            return {"action": "enqueue_review", "review_item": item}
        return action

    if action.get("action") != "auto_write":
        return action

    adapters = {
        "claude-code": claude_code.write_memory_entry,
        "openclaw": openclaw.write_memory_entry,
        "codex": codex.write_memory_entry,
    }
    memory_file = Path(payload["target_memory_file"])
    index_file = Path(payload["target_index_file"])
    memory_backup = create_backup(host_roots[source_host], memory_file)
    index_backup = create_backup(host_roots[source_host], index_file)
    try:
        adapters[source_host](
            root=host_roots[source_host],
            memory_file=memory_file,
            index_file=index_file,
            title=payload["title"],
            body=payload["content"],
            expected_revision=expected_revision,
        )
    except RuntimeError:
        return {"action": "raise_conflict", "memory_backup": str(memory_backup), "index_backup": str(index_backup)}
    return {"action": "auto_write", "memory_backup": str(memory_backup), "index_backup": str(index_backup)}
