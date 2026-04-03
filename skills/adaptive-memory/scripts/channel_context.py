#!/usr/bin/env python3
"""
Adaptive Memory — Channel Context Manager

Manages per-channel conversation summaries for multi-channel setups.
Prevents cross-channel confusion after context compaction.

Usage:
    python channel_context.py list                        # List all channel context files
    python channel_context.py show <channel>              # Show a channel's context
    python channel_context.py update <channel> <section> <text>  # Update a section
    python channel_context.py init <channel>              # Create a new channel context file
    python channel_context.py stale [--hours 24]          # Show channels not updated recently

Environment:
    MEMORY_DIR — path to memory/ directory (default: ./memory)
"""

import argparse
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

JST = timezone(timedelta(hours=9))

TEMPLATE = """# {channel}

## Current Topics
<!-- Active discussion topics in this channel -->

## Recent Decisions
<!-- Decisions made recently -->

## Unresolved
<!-- Open questions or issues -->

---
*Last updated: {date}*
"""


def get_context_dir(memory_dir: str | None = None) -> Path:
    """Resolve channel_context/ directory."""
    base = Path(memory_dir) if memory_dir else Path(os.environ.get("MEMORY_DIR", "./memory"))
    return base / "channel_context"


def sanitize_channel_name(name: str) -> str:
    """Convert channel name to safe filename."""
    # Remove # prefix, replace spaces/special chars with hyphens
    name = name.lstrip("#").strip()
    name = re.sub(r"[^\w\-]", "-", name)
    return name.lower()


def cmd_list(args):
    """List all channel context files."""
    ctx_dir = get_context_dir(args.memory_dir)
    if not ctx_dir.exists():
        print("No channel_context/ directory found.")
        return

    files = sorted(ctx_dir.glob("*.md"))
    files = [f for f in files if f.name != "README.md"]

    if not files:
        print("No channel context files.")
        return

    print(f"Channel contexts ({len(files)}):")
    for f in files:
        stat = f.stat()
        mtime = datetime.fromtimestamp(stat.st_mtime, tz=JST)
        age = datetime.now(JST) - mtime
        age_str = f"{age.days}d" if age.days > 0 else f"{age.seconds // 3600}h"
        size = stat.st_size
        print(f"  📄 {f.stem:30s}  {size:>6,} bytes  (updated {age_str} ago)")


def cmd_show(args):
    """Show a channel's context."""
    ctx_dir = get_context_dir(args.memory_dir)
    name = sanitize_channel_name(args.channel)
    path = ctx_dir / f"{name}.md"

    if not path.exists():
        print(f"No context file for channel: {args.channel}", file=sys.stderr)
        print(f"  Expected at: {path}", file=sys.stderr)
        print(f"  Use 'init {args.channel}' to create one.", file=sys.stderr)
        sys.exit(1)

    print(path.read_text(encoding="utf-8"))


def cmd_init(args):
    """Create a new channel context file."""
    ctx_dir = get_context_dir(args.memory_dir)
    ctx_dir.mkdir(parents=True, exist_ok=True)

    name = sanitize_channel_name(args.channel)
    path = ctx_dir / f"{name}.md"

    if path.exists() and not args.force:
        print(f"Already exists: {path}", file=sys.stderr)
        print("Use --force to overwrite.", file=sys.stderr)
        sys.exit(1)

    content = TEMPLATE.format(
        channel=args.channel,
        date=datetime.now(JST).strftime("%Y-%m-%d %H:%M"),
    )
    path.write_text(content, encoding="utf-8")
    print(f"Created: {path}")


def cmd_update(args):
    """Append text to a section in a channel context file."""
    ctx_dir = get_context_dir(args.memory_dir)
    name = sanitize_channel_name(args.channel)
    path = ctx_dir / f"{name}.md"

    if not path.exists():
        print(f"No context file for: {args.channel}. Run 'init' first.", file=sys.stderr)
        sys.exit(1)

    content = path.read_text(encoding="utf-8")
    section_header = f"## {args.section}"

    if section_header not in content:
        print(f"Section not found: {args.section}", file=sys.stderr)
        print(f"Available sections:", file=sys.stderr)
        for line in content.split("\n"):
            if line.startswith("## "):
                print(f"  {line[3:]}", file=sys.stderr)
        sys.exit(1)

    # Insert text after the section header (and any HTML comment)
    lines = content.split("\n")
    new_lines = []
    found = False
    inserted = False

    for i, line in enumerate(lines):
        new_lines.append(line)
        if line.strip() == section_header:
            found = True
        elif found and not inserted:
            # Skip HTML comments
            if line.strip().startswith("<!--") and line.strip().endswith("-->"):
                continue
            new_lines.append(f"- {args.text}")
            inserted = True
            found = False

    # Update the last-updated timestamp
    timestamp = datetime.now(JST).strftime("%Y-%m-%d %H:%M")
    updated_content = "\n".join(new_lines)
    updated_content = re.sub(
        r"\*Last updated:.*\*",
        f"*Last updated: {timestamp}*",
        updated_content,
    )

    path.write_text(updated_content, encoding="utf-8")
    print(f"Updated {name} / {args.section}: {args.text}")


def cmd_stale(args):
    """Show channels not updated within threshold."""
    ctx_dir = get_context_dir(args.memory_dir)
    if not ctx_dir.exists():
        print("No channel_context/ directory.")
        return

    threshold = timedelta(hours=args.hours)
    now = datetime.now(JST)
    stale = []

    for f in sorted(ctx_dir.glob("*.md")):
        if f.name == "README.md":
            continue
        mtime = datetime.fromtimestamp(f.stat().st_mtime, tz=JST)
        age = now - mtime
        if age > threshold:
            stale.append((f.stem, age))

    if not stale:
        print(f"All channels updated within {args.hours}h.")
        return

    print(f"Stale channels (not updated in {args.hours}h):")
    for name, age in stale:
        print(f"  ⚠️  {name:30s}  ({age.days}d {age.seconds // 3600}h ago)")


def main():
    parser = argparse.ArgumentParser(description="Channel context manager")
    parser.add_argument("--memory-dir", default=None)
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("list", help="List channel contexts")

    p_show = sub.add_parser("show", help="Show channel context")
    p_show.add_argument("channel")

    p_init = sub.add_parser("init", help="Create channel context")
    p_init.add_argument("channel")
    p_init.add_argument("--force", action="store_true")

    p_up = sub.add_parser("update", help="Update channel section")
    p_up.add_argument("channel")
    p_up.add_argument("section")
    p_up.add_argument("text")

    p_stale = sub.add_parser("stale", help="Show stale channels")
    p_stale.add_argument("--hours", type=int, default=24)

    args = parser.parse_args()
    {
        "list": cmd_list,
        "show": cmd_show,
        "init": cmd_init,
        "update": cmd_update,
        "stale": cmd_stale,
    }[args.command](args)


if __name__ == "__main__":
    main()
