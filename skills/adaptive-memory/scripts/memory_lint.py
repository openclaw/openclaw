#!/usr/bin/env python3
"""
Adaptive Memory — Memory Lint

Scans memory files for common problems:
- Leaked credentials (API keys, tokens, passwords)
- Stale active context entries
- Empty daily notes
- Oversized MEMORY.md
- Missing required files

Usage:
    python memory_lint.py [workspace_dir]
    python memory_lint.py --fix   # Auto-fix what's possible
"""

import argparse
import json
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

JST = timezone(timedelta(hours=9))

# Patterns that suggest leaked credentials
CREDENTIAL_PATTERNS = [
    (r"(?:api[_-]?key|apikey)\s*[:=]\s*['\"]?[\w\-]{20,}", "API key"),
    (r"(?:secret|token|password|passwd|pwd)\s*[:=]\s*['\"]?[\w\-]{8,}", "Secret/token"),
    (r"sk-[a-zA-Z0-9]{20,}", "OpenAI-style key"),
    (r"ghp_[a-zA-Z0-9]{36,}", "GitHub PAT"),
    (r"xoxb-[0-9]+-[a-zA-Z0-9]+", "Slack bot token"),
    (r"xoxp-[0-9]+-[a-zA-Z0-9]+", "Slack user token"),
    (r"Bearer\s+[a-zA-Z0-9\-_.]{20,}", "Bearer token"),
    (r"-----BEGIN\s+(RSA\s+)?PRIVATE KEY-----", "Private key"),
]

ISSUES = []


def warn(file: str, message: str, fixable: bool = False):
    tag = "🔧" if fixable else "⚠️"
    ISSUES.append({"file": file, "message": message, "fixable": fixable})
    print(f"  {tag} [{file}] {message}")


def check_credentials(workspace: Path):
    """Scan all memory files for leaked credentials."""
    print("\n🔒 Credential scan:")
    found = False

    targets = list((workspace / "memory").rglob("*.md")) if (workspace / "memory").exists() else []
    if (workspace / "MEMORY.md").exists():
        targets.append(workspace / "MEMORY.md")

    for filepath in targets:
        content = filepath.read_text(encoding="utf-8", errors="ignore")
        rel = filepath.relative_to(workspace)
        for pattern, label in CREDENTIAL_PATTERNS:
            matches = re.findall(pattern, content, re.IGNORECASE)
            if matches:
                found = True
                warn(str(rel), f"Possible {label} found ({len(matches)} match(es))")

    if not found:
        print("  ✅ No credentials detected")


def check_active_context(workspace: Path):
    """Check active_context.md for staleness."""
    print("\n📋 Active context:")
    path = workspace / "memory" / "active_context.md"

    if not path.exists():
        warn("memory/active_context.md", "File missing — create with init_memory.sh", fixable=True)
        return

    content = path.read_text(encoding="utf-8")
    if not content.strip() or len(content.strip()) < 50:
        warn("memory/active_context.md", "File is nearly empty — may need updating")

    # Check modification time
    mtime = datetime.fromtimestamp(path.stat().st_mtime, tz=JST)
    age = datetime.now(JST) - mtime
    if age > timedelta(days=3):
        warn("memory/active_context.md", f"Not updated in {age.days} days — may be stale")
    else:
        print(f"  ✅ Updated {age.days}d {age.seconds // 3600}h ago")


def check_daily_notes(workspace: Path):
    """Check daily notes for issues."""
    print("\n📝 Daily notes:")
    memory_dir = workspace / "memory"
    if not memory_dir.exists():
        warn("memory/", "Directory missing", fixable=True)
        return

    pattern = re.compile(r"^\d{4}-\d{2}-\d{2}\.md$")
    notes = sorted([f for f in memory_dir.iterdir() if pattern.match(f.name)])

    if not notes:
        warn("memory/", "No daily notes found")
        return

    print(f"  📊 {len(notes)} daily notes found")
    print(f"  📅 Range: {notes[0].stem} → {notes[-1].stem}")

    # Check for empty notes
    empty = [n for n in notes if len(n.read_text(encoding="utf-8").strip()) < 30]
    if empty:
        warn("daily notes", f"{len(empty)} nearly empty notes: {', '.join(n.stem for n in empty[:5])}")

    # Check today's note exists
    today = datetime.now(JST).strftime("%Y-%m-%d")
    today_path = memory_dir / f"{today}.md"
    if not today_path.exists():
        warn(f"memory/{today}.md", "Today's daily note doesn't exist yet")
    else:
        print(f"  ✅ Today's note exists ({today})")


def check_memory_md(workspace: Path):
    """Check MEMORY.md size and structure."""
    print("\n🧠 MEMORY.md:")
    path = workspace / "MEMORY.md"

    if not path.exists():
        warn("MEMORY.md", "File missing — create with init_memory.sh", fixable=True)
        return

    content = path.read_text(encoding="utf-8")
    size_kb = len(content.encode("utf-8")) / 1024
    lines = content.count("\n")

    print(f"  📊 Size: {size_kb:.1f} KB, {lines} lines")

    if size_kb > 50:
        warn("MEMORY.md", f"Large file ({size_kb:.0f} KB) — consider pruning during distillation")
    elif size_kb > 100:
        warn("MEMORY.md", f"Very large ({size_kb:.0f} KB) — this will consume significant context window")

    # Check for sections
    sections = [l for l in content.split("\n") if l.startswith("## ")]
    if sections:
        print(f"  📑 Sections: {len(sections)}")
    else:
        warn("MEMORY.md", "No ## sections found — consider organizing by topic")


def check_pending_tasks(workspace: Path):
    """Check pending_tasks.json health."""
    print("\n📋 Pending tasks:")
    path = workspace / "memory" / "pending_tasks.json"

    if not path.exists():
        warn("memory/pending_tasks.json", "File missing", fixable=True)
        return

    try:
        with open(path) as f:
            data = json.load(f)
    except json.JSONDecodeError as e:
        warn("memory/pending_tasks.json", f"Invalid JSON: {e}")
        return

    tasks = data.get("tasks", [])
    by_status = {}
    for t in tasks:
        s = t.get("status", "unknown")
        by_status[s] = by_status.get(s, 0) + 1

    print(f"  📊 {len(tasks)} tasks: {by_status}")

    # Check for old non-done tasks
    now = datetime.now(JST)
    for t in tasks:
        if t.get("status") in ("pending", "in_progress"):
            try:
                created = datetime.fromisoformat(t["createdAt"])
                age = now - created
                if age > timedelta(days=7):
                    warn("pending_tasks.json", f"Task '{t['title'][:40]}' is {age.days} days old")
            except (ValueError, KeyError):
                pass

    # Old done tasks
    done_old = [
        t for t in tasks
        if t.get("status") == "done" and t.get("completedAt")
        and (now - datetime.fromisoformat(t["completedAt"])) > timedelta(days=7)
    ]
    if done_old:
        warn("pending_tasks.json", f"{len(done_old)} completed tasks older than 7 days — run prune", fixable=True)


def check_distillation_state(workspace: Path):
    """Check if distillation is overdue."""
    print("\n🔄 Distillation:")
    path = workspace / "memory" / "heartbeat-state.json"

    if not path.exists():
        warn("memory/heartbeat-state.json", "State file missing — distillation not tracked")
        return

    try:
        with open(path) as f:
            state = json.load(f)
    except json.JSONDecodeError:
        warn("memory/heartbeat-state.json", "Invalid JSON")
        return

    last = state.get("lastConsolidatedAt")
    if not last:
        warn("heartbeat-state.json", "Never consolidated — run distill.py")
        return

    try:
        last_dt = datetime.fromisoformat(last.replace("Z", "+00:00") if last.endswith("Z") else last)
        age = datetime.now(JST) - last_dt
        if age > timedelta(hours=96):
            warn("heartbeat-state.json", f"Last distillation was {age.days}d ago — may be overdue")
        else:
            print(f"  ✅ Last distillation: {age.days}d {age.seconds // 3600}h ago")
    except ValueError:
        warn("heartbeat-state.json", f"Cannot parse timestamp: {last}")


def main():
    parser = argparse.ArgumentParser(description="Memory system health check")
    parser.add_argument("workspace", nargs="?", default=".")
    parser.add_argument("--fix", action="store_true", help="Auto-fix where possible")
    args = parser.parse_args()

    workspace = Path(args.workspace).resolve()
    print(f"🏥 Memory lint: {workspace}")

    check_credentials(workspace)
    check_active_context(workspace)
    check_daily_notes(workspace)
    check_memory_md(workspace)
    check_pending_tasks(workspace)
    check_distillation_state(workspace)

    fixable = [i for i in ISSUES if i["fixable"]]
    errors = [i for i in ISSUES if not i["fixable"]]

    print(f"\n{'─' * 50}")
    print(f"Results: {len(errors)} warnings, {len(fixable)} fixable issues")

    if fixable and args.fix:
        print("\n🔧 Auto-fixing...")
        # Run init_memory.sh for missing files
        init_script = Path(__file__).parent / "init_memory.sh"
        if init_script.exists():
            import subprocess
            subprocess.run(["bash", str(init_script), str(workspace)], check=True)
            print("  Ran init_memory.sh")

    sys.exit(1 if errors else 0)


if __name__ == "__main__":
    main()
