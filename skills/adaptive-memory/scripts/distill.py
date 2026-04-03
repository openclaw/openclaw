#!/usr/bin/env python3
"""
Adaptive Memory — Distillation Cycle Runner

Four-phase distillation: Orient → Gather → Consolidate → Prune
Merges daily notes into MEMORY.md on a schedule or when staleness
conditions are met (48h+ since last run AND 3+ unprocessed notes).

Usage:
    python distill.py [workspace_dir]
    python distill.py --check          # Check if distillation is needed (exit 0=yes, 1=no)
    python distill.py --dry-run        # Show what would be consolidated without writing

Environment:
    MEMORY_STALENESS_HOURS  — hours before distillation triggers (default: 48)
    MEMORY_MIN_NOTES        — minimum unprocessed notes to trigger (default: 3)
"""

import argparse
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

JST = timezone(timedelta(hours=9))


def get_workspace(args_dir: str | None = None) -> Path:
    """Resolve workspace root."""
    if args_dir:
        return Path(args_dir).resolve()
    return Path.cwd()


def load_state(workspace: Path) -> dict:
    """Load heartbeat-state.json."""
    state_path = workspace / "memory" / "heartbeat-state.json"
    if state_path.exists():
        with open(state_path) as f:
            return json.load(f)
    return {"lastConsolidatedAt": None}


def save_state(workspace: Path, state: dict) -> None:
    """Save heartbeat-state.json."""
    state_path = workspace / "memory" / "heartbeat-state.json"
    state_path.parent.mkdir(parents=True, exist_ok=True)
    with open(state_path, "w") as f:
        json.dump(state, f, indent=2, ensure_ascii=False)


def get_daily_notes(workspace: Path) -> list[Path]:
    """Find all daily note files sorted by date."""
    memory_dir = workspace / "memory"
    if not memory_dir.exists():
        return []
    pattern = re.compile(r"^\d{4}-\d{2}-\d{2}\.md$")
    notes = [f for f in memory_dir.iterdir() if pattern.match(f.name)]
    return sorted(notes, key=lambda p: p.name)


def get_unprocessed_notes(workspace: Path, state: dict) -> list[Path]:
    """Find daily notes created after last consolidation."""
    all_notes = get_daily_notes(workspace)
    last = state.get("lastConsolidatedAt")
    if not last:
        return all_notes

    # Parse the last consolidated timestamp
    try:
        if last.endswith("Z"):
            last_dt = datetime.fromisoformat(last.replace("Z", "+00:00"))
        else:
            last_dt = datetime.fromisoformat(last)
        last_date = last_dt.date()
    except (ValueError, AttributeError):
        return all_notes

    # Notes with date > last consolidated date
    unprocessed = []
    for note in all_notes:
        try:
            note_date_str = note.stem  # YYYY-MM-DD
            note_date = datetime.strptime(note_date_str, "%Y-%m-%d").date()
            if note_date > last_date:
                unprocessed.append(note)
        except ValueError:
            continue

    return unprocessed


def should_distill(workspace: Path, staleness_hours: int = 48, min_notes: int = 3) -> tuple[bool, str]:
    """Check if distillation conditions are met."""
    state = load_state(workspace)
    unprocessed = get_unprocessed_notes(workspace, state)

    last = state.get("lastConsolidatedAt")
    now = datetime.now(JST)

    if not last:
        if len(unprocessed) >= min_notes:
            return True, f"Never consolidated, {len(unprocessed)} notes waiting"
        return False, f"Never consolidated but only {len(unprocessed)} notes (need {min_notes})"

    try:
        if last.endswith("Z"):
            last_dt = datetime.fromisoformat(last.replace("Z", "+00:00"))
        else:
            last_dt = datetime.fromisoformat(last)
    except (ValueError, AttributeError):
        return True, "Cannot parse lastConsolidatedAt, running distillation"

    hours_since = (now - last_dt).total_seconds() / 3600
    stale = hours_since >= staleness_hours
    enough_notes = len(unprocessed) >= min_notes

    if stale and enough_notes:
        return True, f"{hours_since:.0f}h since last run, {len(unprocessed)} unprocessed notes"
    elif stale:
        return False, f"Stale ({hours_since:.0f}h) but only {len(unprocessed)} notes (need {min_notes})"
    elif enough_notes:
        return False, f"{len(unprocessed)} notes ready but only {hours_since:.0f}h since last run (need {staleness_hours}h)"
    else:
        return False, f"{hours_since:.0f}h elapsed, {len(unprocessed)} notes — no action needed"


def orient(workspace: Path) -> str:
    """Phase 1: Read MEMORY.md to understand current state."""
    memory_path = workspace / "MEMORY.md"
    if memory_path.exists():
        return memory_path.read_text(encoding="utf-8")
    return ""


def gather(workspace: Path, state: dict) -> list[tuple[str, str]]:
    """Phase 2: Read unprocessed daily notes. Returns [(filename, content)]."""
    notes = get_unprocessed_notes(workspace, state)
    result = []
    for note in notes:
        content = note.read_text(encoding="utf-8")
        if content.strip():
            result.append((note.name, content))
    return result


def extract_sections(content: str) -> dict[str, list[str]]:
    """Extract h2 sections from markdown content."""
    sections: dict[str, list[str]] = {}
    current = None
    for line in content.split("\n"):
        if line.startswith("## "):
            current = line[3:].strip()
            sections[current] = []
        elif current is not None:
            sections[current].append(line)
    # Clean up empty trailing lines
    for key in sections:
        while sections[key] and not sections[key][-1].strip():
            sections[key].pop()
    return sections


def print_report(notes: list[tuple[str, str]], dry_run: bool = False) -> None:
    """Print what would be consolidated."""
    prefix = "[DRY RUN] " if dry_run else ""
    print(f"{prefix}Distillation report:")
    print(f"  Notes to process: {len(notes)}")
    for name, content in notes:
        sections = extract_sections(content)
        non_empty = {k: v for k, v in sections.items() if any(l.strip() for l in v)}
        section_names = ", ".join(non_empty.keys()) if non_empty else "(no sections)"
        print(f"    {name}: {section_names}")


def main():
    parser = argparse.ArgumentParser(description="Adaptive Memory distillation cycle")
    parser.add_argument("workspace", nargs="?", default=None, help="Workspace root directory")
    parser.add_argument("--check", action="store_true", help="Check if distillation is needed (exit 0=yes, 1=no)")
    parser.add_argument("--dry-run", action="store_true", help="Show report without writing")
    parser.add_argument("--force", action="store_true", help="Run regardless of staleness conditions")
    parser.add_argument("--staleness-hours", type=int, default=None)
    parser.add_argument("--min-notes", type=int, default=None)
    args = parser.parse_args()

    staleness = args.staleness_hours or int(os.environ.get("MEMORY_STALENESS_HOURS", "48"))
    min_notes = args.min_notes or int(os.environ.get("MEMORY_MIN_NOTES", "3"))

    workspace = get_workspace(args.workspace)

    if args.check:
        needed, reason = should_distill(workspace, staleness, min_notes)
        print(reason)
        sys.exit(0 if needed else 1)

    if not args.force:
        needed, reason = should_distill(workspace, staleness, min_notes)
        if not needed:
            print(f"Skipping: {reason}")
            sys.exit(0)
        print(f"Distillation triggered: {reason}")

    # Phase 1: Orient
    print("\n[Phase 1: Orient]")
    current_memory = orient(workspace)
    if current_memory:
        sections = extract_sections(current_memory)
        print(f"  Current MEMORY.md sections: {list(sections.keys())}")
    else:
        print("  MEMORY.md is empty or missing")

    # Phase 2: Gather
    print("\n[Phase 2: Gather]")
    state = load_state(workspace)
    notes = gather(workspace, state)
    if not notes:
        print("  No unprocessed notes found")
        sys.exit(0)

    print_report(notes, dry_run=args.dry_run)

    if args.dry_run:
        print("\n[DRY RUN] No files modified")
        sys.exit(0)

    # Phase 3 & 4: Consolidate & Prune
    # NOTE: Actual consolidation requires LLM judgment to extract lasting knowledge
    # from daily notes and merge into MEMORY.md. This script handles the mechanical
    # parts (finding notes, checking staleness, updating state). The agent reads this
    # output and performs the actual consolidation.
    print("\n[Phase 3: Consolidate]")
    print("  Unprocessed notes ready for agent consolidation:")
    for name, content in notes:
        print(f"\n  --- {name} ---")
        # Print first 20 non-empty lines as preview
        lines = [l for l in content.split("\n") if l.strip()][:20]
        for l in lines:
            print(f"    {l}")
        if len([l for l in content.split("\n") if l.strip()]) > 20:
            print("    ...")

    print("\n[Phase 4: Prune]")
    print("  Agent should review MEMORY.md for outdated entries")

    # Update state
    state["lastConsolidatedAt"] = datetime.now(JST).isoformat()
    save_state(workspace, state)
    print(f"\n  Updated lastConsolidatedAt: {state['lastConsolidatedAt']}")
    print("Done.")


if __name__ == "__main__":
    main()
