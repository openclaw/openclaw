#!/usr/bin/env python3
"""
knowledge_sync.py - Sync key decisions from checkpoint to knowledge-graph.

Usage:
    python3 knowledge_sync.py push [--dir <dir>]
    python3 knowledge_sync.py pull [--dir <dir>]
    python3 knowledge_sync.py diff
    python3 knowledge_sync.py status
"""
import sys
from pathlib import Path

_DEFAULT_CHECKPOINT = Path.home() / ".openclaw/workspace/memory/session-checkpoint.md"
_DEFAULT_KNOWLEDGE_GRAPH = Path.home() / ".openclaw/workspace/memory/knowledge-graph.md"
PREFIX_MATCH_CHARS = 50


def _resolve_files(target_dir: Path | None) -> tuple[Path, Path]:
    """Return (checkpoint_file, knowledge_graph_file) based on optional --dir override."""
    if target_dir is not None:
        checkpoint = target_dir / "session-checkpoint.md"
        knowledge_graph = target_dir / "knowledge-graph.md"
    else:
        checkpoint = _DEFAULT_CHECKPOINT
        knowledge_graph = _DEFAULT_KNOWLEDGE_GRAPH
    return checkpoint, knowledge_graph


def extract_key_decisions(text: str) -> list[str]:
    """Extract items from the Key Decisions section of a checkpoint."""
    decisions: list[str] = []
    in_section = False
    for line in text.splitlines():
        if "### \U0001f5dd Key Decisions" in line or "### Key Decisions" in line:
            in_section = True
            continue
        if in_section:
            if line.startswith("### ") or line.startswith("## "):
                break
            stripped = line.strip()
            if stripped.startswith("- ") and len(stripped) > 2:
                decisions.append(stripped[2:].strip())
    return decisions


def get_pending_updates(text: str) -> list[str]:
    """Extract items from the pending update section of knowledge-graph."""
    updates: list[str] = []
    in_section = False
    for line in text.splitlines():
        if "pending-update" in line.lower():
            in_section = True
            continue
        if in_section:
            if line.startswith("##") and "pending" not in line.lower():
                break
            stripped = line.strip()
            if stripped.startswith("- ") and len(stripped) > 2:
                updates.append(stripped[2:].strip())
    return updates


def _normalize_existing(lines: list[str]) -> list[str]:
    """Strip list-item prefix from existing file lines for duplicate comparison."""
    result = []
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("- ") and len(stripped) > 2:
            result.append(stripped[2:].strip())
        else:
            result.append(stripped)
    return result


def is_duplicate(decision: str, existing_normalized: list[str]) -> bool:
    prefix = decision[:PREFIX_MATCH_CHARS].lower()
    return any(e[:PREFIX_MATCH_CHARS].lower() == prefix for e in existing_normalized)


def cmd_push(target_dir: Path | None = None) -> None:
    """Push key decisions from checkpoint into knowledge-graph."""
    checkpoint_file, knowledge_graph_file = _resolve_files(target_dir)
    if not checkpoint_file.exists():
        print(f"ERROR: Checkpoint file not found: {checkpoint_file}")
        sys.exit(1)
    checkpoint_text = checkpoint_file.read_text()
    decisions = extract_key_decisions(checkpoint_text)
    if not decisions:
        print("No key decisions found in checkpoint.")
        return
    existing_text = knowledge_graph_file.read_text() if knowledge_graph_file.exists() else ""
    existing_normalized = _normalize_existing(existing_text.splitlines())
    new_items = [d for d in decisions if not is_duplicate(d, existing_normalized)]
    if not new_items:
        print("All decisions already present in knowledge-graph. Nothing to push.")
        return
    knowledge_graph_file.parent.mkdir(parents=True, exist_ok=True)
    with open(knowledge_graph_file, "a") as f:
        f.write("\n")
        for item in new_items:
            f.write(f"- {item}\n")
    print(f"Pushed {len(new_items)} new decision(s) to knowledge-graph.")


def cmd_pull(target_dir: Path | None = None) -> None:
    """Pull pending updates from knowledge-graph back into checkpoint."""
    checkpoint_file, knowledge_graph_file = _resolve_files(target_dir)
    if not knowledge_graph_file.exists():
        print(f"ERROR: Knowledge graph file not found: {knowledge_graph_file}")
        sys.exit(1)
    kg_text = knowledge_graph_file.read_text()
    updates = get_pending_updates(kg_text)
    if not updates:
        print("No pending updates found in knowledge-graph.")
        return
    existing_text = checkpoint_file.read_text() if checkpoint_file.exists() else ""
    existing_normalized = _normalize_existing(existing_text.splitlines())
    new_items = [u for u in updates if not is_duplicate(u, existing_normalized)]
    if not new_items:
        print("All pending updates already in checkpoint. Nothing to pull.")
        return
    checkpoint_file.parent.mkdir(parents=True, exist_ok=True)
    with open(checkpoint_file, "a") as f:
        f.write("\n### \U0001f4e5 Pulled from Knowledge Graph\n")
        for item in new_items:
            f.write(f"- {item}\n")
    print(f"Pulled {len(new_items)} update(s) from knowledge-graph into checkpoint.")


def cmd_diff(target_dir: Path | None = None) -> None:
    """Show decisions in checkpoint not yet in knowledge-graph."""
    checkpoint_file, knowledge_graph_file = _resolve_files(target_dir)
    if not checkpoint_file.exists():
        print(f"ERROR: Checkpoint file not found: {checkpoint_file}")
        sys.exit(1)
    checkpoint_text = checkpoint_file.read_text()
    decisions = extract_key_decisions(checkpoint_text)
    existing_text = knowledge_graph_file.read_text() if knowledge_graph_file.exists() else ""
    existing_normalized = _normalize_existing(existing_text.splitlines())
    new_items = [d for d in decisions if not is_duplicate(d, existing_normalized)]
    if not new_items:
        print("knowledge-graph is up to date. No diff.")
    else:
        print(f"{len(new_items)} decision(s) not yet in knowledge-graph:")
        for item in new_items:
            print(f"  + {item}")


def cmd_status(target_dir: Path | None = None) -> None:
    """Print sync status summary."""
    checkpoint_file, knowledge_graph_file = _resolve_files(target_dir)
    cp_exists = checkpoint_file.exists()
    kg_exists = knowledge_graph_file.exists()
    print(f"checkpoint: {'found' if cp_exists else 'missing'} ({checkpoint_file})")
    print(f"knowledge_graph: {'found' if kg_exists else 'missing'} ({knowledge_graph_file})")
    if cp_exists:
        decisions = extract_key_decisions(checkpoint_file.read_text())
        print(f"decisions_in_checkpoint: {len(decisions)}")
    if kg_exists:
        kg_text = knowledge_graph_file.read_text()
        lines = [l for l in kg_text.splitlines() if l.strip().startswith("- ")]
        print(f"entries_in_knowledge_graph: {len(lines)}")


def main() -> None:
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        sys.exit(1)
    cmd = args[0]
    rest = args[1:]
    target_dir: Path | None = None
    if "--dir" in rest:
        idx = rest.index("--dir")
        if idx + 1 < len(rest):
            target_dir = Path(rest[idx + 1])
    if cmd == "push":
        cmd_push(target_dir)
    elif cmd == "pull":
        cmd_pull(target_dir)
    elif cmd == "diff":
        cmd_diff(target_dir)
    elif cmd == "status":
        cmd_status(target_dir)
    else:
        print(f"Unknown command: {cmd}")
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()
