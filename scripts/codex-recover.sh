#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/codex-recover.sh [--all]

Print a ranked local recovery table for git worktrees, recent Codex sessions,
and the latest tmux-resurrect snapshot. Default output focuses on likely-active
entries. Use --all to include stale/clean entries too.
EOF
}

SHOW_ALL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --all)
      SHOW_ALL=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Error: unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if ! git rev-parse --show-toplevel >/dev/null 2>&1; then
  echo "Error: run this script from inside a git worktree." >&2
  exit 1
fi

python3 - "$SHOW_ALL" <<'PY'
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

SHOW_ALL = sys.argv[1] == "1"
HOME = Path.home()
CODEX_HOME = HOME / ".codex"
TMUX_LAST = HOME / ".tmux" / "resurrect" / "last"


def run(cmd: list[str], cwd: Path | None = None) -> str:
    return subprocess.check_output(cmd, cwd=str(cwd) if cwd else None, text=True)


def run_optional(cmd: list[str], cwd: Path | None = None) -> str:
    completed = subprocess.run(
        cmd,
        cwd=str(cwd) if cwd else None,
        text=True,
        capture_output=True,
    )
    if completed.returncode != 0:
        return ""
    return completed.stdout


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def parse_iso(ts: str) -> datetime | None:
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return None


def human_age(ts: datetime | None) -> str:
    if ts is None:
        return "-"
    delta = now_utc() - ts.astimezone(timezone.utc)
    seconds = max(delta.total_seconds(), 0)
    days = int(seconds // 86400)
    hours = int((seconds % 86400) // 3600)
    minutes = int((seconds % 3600) // 60)
    if days > 0:
      return f"{days}d{hours}h"
    if hours > 0:
      return f"{hours}h{minutes}m"
    return f"{minutes}m"


def load_worktrees() -> dict[str, dict]:
    text = run(["git", "worktree", "list", "--porcelain"])
    entries: dict[str, dict] = {}
    current: dict[str, str | bool] = {}
    for raw in text.splitlines() + [""]:
        line = raw.strip()
        if not line:
            path = current.get("path")
            if path:
                entries[str(path)] = {
                    "path": str(path),
                    "branch": current.get("branch", "-"),
                    "head": current.get("head", "-"),
                    "detached": bool(current.get("detached")),
                }
            current = {}
            continue
        if line.startswith("worktree "):
            current["path"] = line.split(" ", 1)[1]
        elif line.startswith("branch "):
            current["branch"] = line.split("refs/heads/", 1)[1]
        elif line.startswith("HEAD "):
            current["head"] = line.split(" ", 1)[1]
        elif line == "detached":
            current["detached"] = True

    for item in entries.values():
        wt = Path(item["path"])
        status = run_optional(["git", "-C", str(wt), "status", "--short"])
        dirty = bool(status.strip())
        upstream = run_optional(
            ["git", "for-each-ref", "--format=%(upstream:short)", f"refs/heads/{item['branch']}"]
        ).strip()
        item["dirty"] = dirty
        item["upstream"] = upstream or "-"
    return entries


def load_session_names() -> dict[str, str]:
    index_path = CODEX_HOME / "session_index.jsonl"
    names: dict[str, str] = {}
    if not index_path.exists():
        return names
    with index_path.open("r", errors="ignore") as handle:
        for line in handle:
            try:
                data = json.loads(line)
            except json.JSONDecodeError:
                continue
            session_id = data.get("id")
            if session_id:
                names[session_id] = data.get("thread_name", "")
    return names


def load_latest_sessions() -> dict[str, dict]:
    sessions: dict[str, dict] = {}
    names = load_session_names()
    sessions_root = CODEX_HOME / "sessions"
    if not sessions_root.exists():
        return sessions

    for path in sessions_root.rglob("*.jsonl"):
        try:
            with path.open("r", errors="ignore") as handle:
                first_meta = None
                for line in handle:
                    if '"type":"session_meta"' not in line:
                        continue
                    try:
                        obj = json.loads(line)
                    except json.JSONDecodeError:
                        break
                    payload = obj.get("payload", {})
                    first_meta = {
                        "session_id": payload.get("id", ""),
                        "cwd": payload.get("cwd", ""),
                        "timestamp": payload.get("timestamp", ""),
                        "file": str(path),
                    }
                    break
        except OSError:
            continue

        if not first_meta or not first_meta["cwd"]:
            continue

        ts = parse_iso(first_meta["timestamp"])
        cwd = first_meta["cwd"]
        existing = sessions.get(cwd)
        if existing and existing["timestamp_obj"] and ts and existing["timestamp_obj"] >= ts:
            continue

        first_meta["thread_name"] = names.get(first_meta["session_id"], "")
        first_meta["timestamp_obj"] = ts
        sessions[cwd] = first_meta
    return sessions


def load_tmux_snapshot() -> dict[str, dict]:
    panes: dict[str, dict] = {}
    if not TMUX_LAST.exists():
        return panes

    resume_re = re.compile(r"codex resume(?: ([0-9a-f-]{36}))?")
    with TMUX_LAST.open("r", errors="ignore") as handle:
        for line in handle:
            if not line.startswith("pane\t"):
                continue
            parts = line.rstrip("\n").split("\t")
            if len(parts) < 11:
                continue
            cwd = parts[7].lstrip(":")
            cmd = parts[10].lstrip(":")
            match = resume_re.search(cmd)
            pane = {
                "session": parts[1],
                "window": parts[2],
                "pane": parts[5],
                "cwd": cwd,
                "cmd": cmd,
                "resume_id": match.group(1) if match else "",
                "has_resume": bool(match),
            }
            panes[cwd] = pane
    return panes


def classify(entry: dict) -> tuple[str, int]:
    session = entry.get("session")
    tmux = entry.get("tmux")
    dirty = entry.get("dirty", False)
    detached = entry.get("detached", False)
    age = None
    if session and session.get("timestamp_obj"):
        age = (now_utc() - session["timestamp_obj"].astimezone(timezone.utc)).total_seconds() / 86400

    if dirty:
        return ("active", 0)
    if tmux and tmux.get("has_resume") and age is not None and age <= 7:
        return ("recoverable", 1)
    if session and age is not None and age <= 3:
        return ("recent", 2)
    if detached:
        return ("detached", 4)
    return ("stale", 5)


worktrees = load_worktrees()
sessions = load_latest_sessions()
tmux = load_tmux_snapshot()

paths = set(worktrees) | set(sessions) | set(tmux)
rows: list[dict] = []
for path in sorted(paths):
    wt = worktrees.get(path, {})
    session = sessions.get(path)
    tmux_item = tmux.get(path)
    row = {
        "path": path,
        "branch": wt.get("branch", "-"),
        "dirty": wt.get("dirty", False),
        "detached": wt.get("detached", False),
        "upstream": wt.get("upstream", "-"),
        "session": session,
        "tmux": tmux_item,
    }
    status, rank = classify(row)
    row["status"] = status
    row["rank"] = rank
    row["age"] = human_age(session.get("timestamp_obj") if session else None)
    row["session_id"] = session.get("session_id", "") if session else ""
    row["thread_name"] = session.get("thread_name", "") if session else ""
    row["resume_id"] = tmux_item.get("resume_id", "") if tmux_item else ""
    row["resume"] = "yes" if tmux_item and tmux_item.get("has_resume") else "-"
    rows.append(row)

rows.sort(key=lambda item: (item["rank"], item["age"], item["path"]))

if not SHOW_ALL:
    rows = [row for row in rows if row["status"] != "stale"]

if not rows:
    print("No recoverable worktree/session rows found.")
    raise SystemExit(0)

headers = ["status", "dirty", "resume", "age", "branch", "session_id", "thread", "path"]
table: list[list[str]] = [headers]
for row in rows:
    table.append(
        [
            row["status"],
            "dirty" if row["dirty"] else "-",
            row["resume"],
            row["age"],
            row["branch"],
            row["resume_id"] or row["session_id"] or "-",
            (row["thread_name"] or "-")[:36],
            row["path"],
        ]
    )

widths = [max(len(r[i]) for r in table) for i in range(len(headers))]
for idx, row in enumerate(table):
    rendered = "  ".join(value.ljust(widths[i]) for i, value in enumerate(row))
    print(rendered)
    if idx == 0:
        print("  ".join("-" * widths[i] for i in range(len(headers))))

print()
print(f"rows={len(rows)} show_all={'yes' if SHOW_ALL else 'no'}")
print("Legend: active=dirty worktree, recoverable=tmux resume trail + recent session, recent=session seen recently, stale=no strong recovery signal.")
PY
