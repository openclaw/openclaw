#!/usr/bin/env python3
"""
Adaptive Memory — Pending Tasks Manager

CLI for managing pending_tasks.json. Prevents promises from being lost
after context compaction.

Usage:
    python pending_tasks.py list                          # Show all non-done tasks
    python pending_tasks.py add "Title" [--priority high] # Add a task
    python pending_tasks.py update <id> --status done     # Update status
    python pending_tasks.py prune                         # Remove done tasks older than 7 days
    python pending_tasks.py overdue                       # Show tasks pending > 24h

Environment:
    MEMORY_DIR — path to memory/ directory (default: ./memory)
"""

import argparse
import json
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

JST = timezone(timedelta(hours=9))
VALID_STATUSES = {"pending", "in_progress", "blocked", "done"}
VALID_PRIORITIES = {"low", "normal", "high", "critical"}


def get_tasks_path(memory_dir: str | None = None) -> Path:
    """Resolve pending_tasks.json path."""
    import os
    base = Path(memory_dir) if memory_dir else Path(os.environ.get("MEMORY_DIR", "./memory"))
    return base / "pending_tasks.json"


def load_tasks(path: Path) -> dict:
    """Load tasks from JSON file."""
    if path.exists():
        with open(path) as f:
            return json.load(f)
    return {"lastUpdated": "", "tasks": []}


def save_tasks(path: Path, data: dict) -> None:
    """Save tasks to JSON file."""
    data["lastUpdated"] = datetime.now(JST).isoformat()
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


def cmd_list(args):
    """List tasks, optionally filtering by status."""
    path = get_tasks_path(args.memory_dir)
    data = load_tasks(path)
    tasks = data.get("tasks", [])

    if args.status:
        tasks = [t for t in tasks if t.get("status") == args.status]
    elif not args.all:
        tasks = [t for t in tasks if t.get("status") != "done"]

    if not tasks:
        print("No tasks found.")
        return

    # Sort: critical > high > normal > low, then by date
    priority_order = {"critical": 0, "high": 1, "normal": 2, "low": 3}
    tasks.sort(key=lambda t: (priority_order.get(t.get("priority", "normal"), 2), t.get("createdAt", "")))

    for t in tasks:
        status_icon = {"pending": "⏳", "in_progress": "🔄", "blocked": "🚫", "done": "✅"}.get(t.get("status"), "❓")
        priority = t.get("priority", "normal")
        priority_tag = f" [{priority.upper()}]" if priority in ("high", "critical") else ""
        print(f"  {status_icon} {t['id'][:8]}  {t['title']}{priority_tag}")
        if t.get("note"):
            print(f"              {t['note']}")


def cmd_add(args):
    """Add a new task."""
    path = get_tasks_path(args.memory_dir)
    data = load_tasks(path)

    task = {
        "id": str(uuid.uuid4())[:8],
        "title": args.title,
        "status": "pending",
        "priority": args.priority or "normal",
        "createdAt": datetime.now(JST).isoformat(),
        "note": args.note or "",
    }

    data["tasks"].append(task)
    save_tasks(path, data)
    print(f"Added: {task['id']}  {task['title']}")


def cmd_update(args):
    """Update an existing task."""
    path = get_tasks_path(args.memory_dir)
    data = load_tasks(path)

    found = None
    for t in data["tasks"]:
        if t["id"].startswith(args.id):
            found = t
            break

    if not found:
        print(f"Task not found: {args.id}", file=sys.stderr)
        sys.exit(1)

    changes = []
    if args.status:
        if args.status not in VALID_STATUSES:
            print(f"Invalid status: {args.status}. Valid: {VALID_STATUSES}", file=sys.stderr)
            sys.exit(1)
        found["status"] = args.status
        changes.append(f"status={args.status}")
        if args.status == "done":
            found["completedAt"] = datetime.now(JST).isoformat()

    if args.priority:
        if args.priority not in VALID_PRIORITIES:
            print(f"Invalid priority: {args.priority}. Valid: {VALID_PRIORITIES}", file=sys.stderr)
            sys.exit(1)
        found["priority"] = args.priority
        changes.append(f"priority={args.priority}")

    if args.note is not None:
        found["note"] = args.note
        changes.append("note updated")

    save_tasks(path, data)
    print(f"Updated {found['id']}: {', '.join(changes)}")


def cmd_prune(args):
    """Remove done tasks older than N days."""
    path = get_tasks_path(args.memory_dir)
    data = load_tasks(path)

    cutoff = datetime.now(JST) - timedelta(days=args.days)
    before = len(data["tasks"])
    data["tasks"] = [
        t for t in data["tasks"]
        if not (
            t.get("status") == "done"
            and t.get("completedAt")
            and datetime.fromisoformat(t["completedAt"]) < cutoff
        )
    ]
    pruned = before - len(data["tasks"])
    save_tasks(path, data)
    print(f"Pruned {pruned} completed tasks (older than {args.days} days)")


def cmd_overdue(args):
    """Show tasks pending for more than threshold hours."""
    path = get_tasks_path(args.memory_dir)
    data = load_tasks(path)

    threshold = timedelta(hours=args.hours)
    now = datetime.now(JST)
    overdue = []

    for t in data["tasks"]:
        if t.get("status") in ("pending", "in_progress"):
            try:
                created = datetime.fromisoformat(t["createdAt"])
                if now - created > threshold:
                    age_hours = (now - created).total_seconds() / 3600
                    overdue.append((t, age_hours))
            except (ValueError, KeyError):
                continue

    if not overdue:
        print("No overdue tasks.")
        return

    print(f"Tasks pending > {args.hours}h:")
    for t, hours in overdue:
        print(f"  ⚠️  {t['id'][:8]}  {t['title']}  ({hours:.0f}h old)")


def main():
    parser = argparse.ArgumentParser(description="Adaptive Memory task tracker")
    parser.add_argument("--memory-dir", default=None, help="Path to memory/ directory")
    sub = parser.add_subparsers(dest="command", required=True)

    # list
    p_list = sub.add_parser("list", help="List tasks")
    p_list.add_argument("--status", choices=VALID_STATUSES)
    p_list.add_argument("--all", action="store_true", help="Include done tasks")

    # add
    p_add = sub.add_parser("add", help="Add a task")
    p_add.add_argument("title")
    p_add.add_argument("--priority", choices=VALID_PRIORITIES, default="normal")
    p_add.add_argument("--note", default="")

    # update
    p_up = sub.add_parser("update", help="Update a task")
    p_up.add_argument("id")
    p_up.add_argument("--status", choices=VALID_STATUSES)
    p_up.add_argument("--priority", choices=VALID_PRIORITIES)
    p_up.add_argument("--note")

    # prune
    p_prune = sub.add_parser("prune", help="Remove old done tasks")
    p_prune.add_argument("--days", type=int, default=7)

    # overdue
    p_over = sub.add_parser("overdue", help="Show overdue tasks")
    p_over.add_argument("--hours", type=int, default=24)

    args = parser.parse_args()
    {"list": cmd_list, "add": cmd_add, "update": cmd_update, "prune": cmd_prune, "overdue": cmd_overdue}[args.command](args)


if __name__ == "__main__":
    main()
