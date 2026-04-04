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

CHECKPOINT_FILE = Path.home() / ".openclaw/workspace/memory/session-checkpoint.md"
KNOWLEDGE_GRAPH_FILE = Path.home() / ".openclaw/workspace/memory/knowledge-graph.md"
PREFIX_MATCH_CHARS = 50


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


def is_duplicate(decision: str, existing: list[str]) -> bool:
    prefix = decision[:PREFIX_MATCH_CHARS].lower()
    return any(e[:PREFIX_MATCH_CHARS].lower() == prefix for e in existing)


def cmd_push(target_dir: Path | None = None) -> None:
    """Push key decisions from checkpoint into knowledge-graph."""
    if not CHECKPOINT_FILE.exists():
        print("ERROR: Checkpoint file not found.")
        sys.exit(1)
    checkpoint_text = CHECKPOINT_FILE.read_text()
    decisions = extract_key_decisions(checkpoint_text)
    if not decisions:
        print("No key decisions found in checkpoint.")
        return

    existing_text = KNOWLEDGE_GRAPH_FILE.read_text() if KNOWLEDGE_GRAPH_FILE.exists() else ""
    existing = existing_text.splitlines()
    new_items = [d for d in decisions if not is_duplicate(d, existing)]

    if not new_items:
        print("All decisions already present in knowledge-graph. Nothing to push.")
        return

    KNOWLEDGE_GRAPH_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(KNOWLEDGE_GRAPH_FILE, "a") as f:
        f.write("\n")
        for item in new_items:
            f.write(f"- {item}\n")
    print(f"Pushed {len(new_items)} new decision(s) to knowledge-graph.")


def cmd_pull(target_dir: Path | None = None) -> None:
    """Pull pending updates from knowledge-graph back into checkpoint."""
    if not KNOWLEDGE_GRAPH_FILE.exists():
        print("ERROR: Knowledge graph file not found.")
        sys.exit(1)
    kg_text = KNOWLEDGE_GRAPH_FILE.read_text()
    updates = get_pending_updates(kg_text)
    if not updates:
        print("No pending updates found in knowledge-graph.")
        return

    existing_text = CHECKPOINT_FILE.read_text() if CHECKPOINT_FILE.exists() else ""
    existing = existing_text.splitlines()
    new_items = [u for u in updates if not is_duplicate(u, existing)]

    if not new_items:
        print("All pending updates already in checkpoint. Nothing to pull.")
        return

    CHECKPOINT_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(CHECKPOINT_FILE, "a") as f:
        f.write("\n### \U0001f4e5 Pulled from Knowledge Graph\n")
        for item in new_items:
            f.write(f"- {item}\n")
    print(f"Pulled {len(new_items)} update(s) from knowledge-graph into checkpoint.")


def cmd_diff() -> None:
    """Show decisions in checkpoint not yet in knowledge-graph."""
    if not CHECKPOINT_FILE.exists():
        print("ERROR: Checkpoint file not found.")
        sys.exit(1)
    checkpoint_text = CHECKPOINT_FILE.read_text()
    decisions = extract_key_decisions(checkpoint_text)
    existing_text = KNOWLEDGE_GRAPH_FILE.read_text() if KNOWLEDGE_GRAPH_FILE.exists() else ""
    existing = existing_text.splitlines()
    new_items = [d for d in decisions if not is_duplicate(d, existing)]
    if not new_items:
        print("knowledge-graph is up to date. No diff.")
    else:
        print(f"{len(new_items)} decision(s) not yet in knowledge-graph:")
        for item in new_items:
            print(f"  + {item}")


def cmd_status() -> None:
    """Print sync status summary."""
    cp_exists = CHECKPOINT_FILE.exists()
    kg_exists = KNOWLEDGE_GRAPH_FILE.exists()
    print(f"checkpoint: {'found' if cp_exists else 'missing'} ({CHECKPOINT_FILE})")
    print(f"knowledge_graph: {'found' if kg_exists else 'missing'} ({KNOWLEDGE_GRAPH_FILE})")
    if cp_exists:
        decisions = extract_key_decisions(CHECKPOINT_FILE.read_text())
        print(f"decisions_in_checkpoint: {len(decisions)}")
    if kg_exists:
        kg_text = KNOWLEDGE_GRAPH_FILE.read_text()
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
        cmd_diff()
    elif cmd == "status":
        cmd_status()
    else:
        print(f"Unknown command: {cmd}")
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()
