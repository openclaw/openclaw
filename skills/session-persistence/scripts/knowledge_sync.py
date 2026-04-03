#!/usr/bin/env python3
"""
knowledge_sync.py - Sync Key Decisions from checkpoint to knowledge-graph.

Usage:
    python3 knowledge_sync.py sync
    python3 knowledge_sync.py dry-run
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
        if "### 🔑 Key Decisions" in line or "### Key Decisions" in line:
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
    """Extract items from the pending-update section of knowledge-graph."""
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


def cmd_sync() -> None:
    if not CHECKPOINT_FILE.exists():
        print(f"ERROR: Checkpoint not found: {CHECKPOINT_FILE}")
        sys.exit(1)

    checkpoint_text = CHECKPOINT_FILE.read_text()
    decisions = extract_key_decisions(checkpoint_text)
    if not decisions:
        print("No Key Decisions found in checkpoint.")
        return

    kg_text = KNOWLEDGE_GRAPH_FILE.read_text() if KNOWLEDGE_GRAPH_FILE.exists() else ""
    existing = get_pending_updates(kg_text)

    new_items = [d for d in decisions if not is_duplicate(d, existing)]
    if not new_items:
        print("No new items to sync (all already in pending-update).")
        return

    append_block = "\n"
    for item in new_items:
        append_block += f"- {item}\n"

    if "pending-update" in kg_text.lower():
        lines = kg_text.splitlines(keepends=True)
        result: list[str] = []
        inserted = False
        for i, line in enumerate(lines):
            result.append(line)
            if not inserted and "pending-update" in line.lower():
                # Find end of pending-update section
                j = i + 1
                while j < len(lines) and not (lines[j].startswith("##") and "pending" not in lines[j].lower()):
                    j += 1
                result.extend(lines[i + 1:j])
                for item in new_items:
                    result.append(f"- {item}\n")
                result.extend(lines[j:])
                inserted = True
                break
        KNOWLEDGE_GRAPH_FILE.write_text("".join(result))
    else:
        with open(KNOWLEDGE_GRAPH_FILE, "a") as f:
            f.write(f"\n## pending-update\n{append_block}")

    print(f"Synced {len(new_items)} new decision(s) to knowledge-graph.")
    for item in new_items:
        print(f"  + {item}")


def cmd_dry_run() -> None:
    if not CHECKPOINT_FILE.exists():
        print(f"ERROR: Checkpoint not found: {CHECKPOINT_FILE}")
        sys.exit(1)

    checkpoint_text = CHECKPOINT_FILE.read_text()
    decisions = extract_key_decisions(checkpoint_text)
    kg_text = KNOWLEDGE_GRAPH_FILE.read_text() if KNOWLEDGE_GRAPH_FILE.exists() else ""
    existing = get_pending_updates(kg_text)

    new_items = [d for d in decisions if not is_duplicate(d, existing)]
    print(f"Would sync {len(new_items)} new item(s):")
    for item in new_items:
        print(f"  + {item}")
    if not new_items:
        print("  (nothing to sync)")


def cmd_status() -> None:
    checkpoint_exists = CHECKPOINT_FILE.exists()
    kg_exists = KNOWLEDGE_GRAPH_FILE.exists()
    print(f"checkpoint: {'found' if checkpoint_exists else 'missing'}")
    print(f"knowledge-graph: {'found' if kg_exists else 'missing'}")
    if checkpoint_exists:
        decisions = extract_key_decisions(CHECKPOINT_FILE.read_text())
        print(f"key_decisions_in_checkpoint: {len(decisions)}")
    if kg_exists:
        updates = get_pending_updates(KNOWLEDGE_GRAPH_FILE.read_text())
        print(f"pending_updates_in_graph: {len(updates)}")


def main() -> None:
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        sys.exit(1)
    cmd = args[0]
    if cmd == "sync":
        cmd_sync()
    elif cmd == "dry-run":
        cmd_dry_run()
    elif cmd == "status":
        cmd_status()
    else:
        print(f"Unknown command: {cmd}")
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()
