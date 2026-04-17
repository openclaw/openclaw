#!/usr/bin/env python3
"""
Atomic ledger helper for the openclaw-security-fix-driver skill.

Usage:
  ledger.py init                         # create empty ledger
  ledger.py load                         # print ledger JSON
  ledger.py upsert-issue <path.json>     # insert or merge one issue object
  ledger.py set-stage <number> <stage> [--notes "..."] [--cause ci|review|merge|human]
  ledger.py set-field <number> <dotted.path> <json-value>
  ledger.py list [--stage merged|queued|...]
  ledger.py resume-plan                  # list next action per in-flight issue

The ledger path defaults to:
  .agents/state/security-fix-driver/ledger.json
Override with --ledger <path>.

Writes go to <ledger>.tmp and rename on top, so concurrent reads never see a
torn file. This is not safe against two concurrent writers — keep the driver
single-threaded per session.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

DEFAULT_LEDGER = Path(".agents/state/security-fix-driver/ledger.json")

TERMINAL_STAGES = {"merged", "skipped", "handed-off-ghsa"}
ALL_STAGES = {
    "queued", "analyzing", "fix-drafted", "tested",
    "pr-filed", "review-requested", "merged",
    "changes-requested", "ci-failed", "blocked",
    "skipped", "handed-off-ghsa",
}


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def load(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {
            "version": 1,
            "campaign": {"startedAt": now_iso(), "rankLimit": 100, "lastRankedAt": None},
            "issues": [],
        }
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def atomic_write(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, sort_keys=False)
        f.write("\n")
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def find_issue(data: dict[str, Any], number: int) -> dict[str, Any] | None:
    for issue in data.get("issues", []):
        if issue.get("number") == number:
            return issue
    return None


def cmd_init(args) -> int:
    path = Path(args.ledger)
    if path.exists() and not args.force:
        print(f"ledger already exists at {path}; pass --force to overwrite", file=sys.stderr)
        return 1
    atomic_write(path, load(Path("/nonexistent")))  # start fresh
    print(str(path))
    return 0


def cmd_load(args) -> int:
    data = load(Path(args.ledger))
    json.dump(data, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


def cmd_upsert_issue(args) -> int:
    path = Path(args.ledger)
    data = load(path)
    with open(args.json_path, "r", encoding="utf-8") as f:
        incoming = json.load(f)
    number = incoming["number"]
    existing = find_issue(data, number)
    if existing is None:
        incoming.setdefault("stage", "queued")
        incoming.setdefault("history", [{"at": now_iso(), "stage": incoming["stage"]}])
        data["issues"].append(incoming)
    else:
        # Shallow merge, preserve history and terminal stages
        if existing.get("stage") in TERMINAL_STAGES and "stage" in incoming:
            incoming.pop("stage", None)
        existing.update({k: v for k, v in incoming.items() if k != "history"})
    atomic_write(path, data)
    return 0


def cmd_set_stage(args) -> int:
    if args.stage not in ALL_STAGES:
        print(f"unknown stage: {args.stage}", file=sys.stderr)
        return 2
    path = Path(args.ledger)
    data = load(path)
    issue = find_issue(data, args.number)
    if issue is None:
        print(f"issue {args.number} not in ledger", file=sys.stderr)
        return 1
    if issue.get("stage") in TERMINAL_STAGES and args.stage != issue.get("stage"):
        print(f"issue {args.number} is already terminal ({issue.get('stage')}); refusing to overwrite", file=sys.stderr)
        return 1
    issue["stage"] = args.stage
    entry: dict[str, Any] = {"at": now_iso(), "stage": args.stage}
    if args.cause:
        entry["cause"] = args.cause
    issue.setdefault("history", []).append(entry)
    if args.notes:
        issue.setdefault("notes", []).append({"at": now_iso(), "text": args.notes})
    atomic_write(path, data)
    return 0


def _set_by_path(obj: dict[str, Any], dotted: str, value: Any) -> None:
    keys = dotted.split(".")
    cur = obj
    for k in keys[:-1]:
        if k not in cur or not isinstance(cur[k], dict):
            cur[k] = {}
        cur = cur[k]
    cur[keys[-1]] = value


def cmd_set_field(args) -> int:
    path = Path(args.ledger)
    data = load(path)
    issue = find_issue(data, args.number)
    if issue is None:
        print(f"issue {args.number} not in ledger", file=sys.stderr)
        return 1
    try:
        value = json.loads(args.json_value)
    except json.JSONDecodeError:
        value = args.json_value  # treat as string
    _set_by_path(issue, args.dotted_path, value)
    atomic_write(path, data)
    return 0


def cmd_list(args) -> int:
    data = load(Path(args.ledger))
    issues = data.get("issues", [])
    if args.stage:
        issues = [i for i in issues if i.get("stage") == args.stage]
    for i in issues:
        score = i.get("score", {}).get("total", "-")
        print(f"{i.get('number','?'):>6}  {i.get('stage','?'):<20}  score={score:<4}  {i.get('title','')}")
    return 0


def cmd_resume_plan(args) -> int:
    data = load(Path(args.ledger))
    next_action = {
        "queued":            "rank-confirm then analyze",
        "analyzing":         "present root-cause at C2",
        "fix-drafted":       "run gates at C3",
        "tested":            "commit + open PR via $openclaw-pr-maintainer",
        "pr-filed":          "watch CI, request review",
        "review-requested":  "nudge reviewers at C5 cadence",
        "changes-requested": "apply review feedback, rerun gates",
        "ci-failed":         "diagnose failing check, rerun gates",
        "blocked":           "surface blocker to user",
    }
    for i in data.get("issues", []):
        stage = i.get("stage", "queued")
        if stage in TERMINAL_STAGES:
            continue
        n = i.get("number", "?")
        title = i.get("title", "")
        print(f"#{n}  stage={stage}  -> {next_action.get(stage, '?')}  :: {title}")
    return 0


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--ledger", default=str(DEFAULT_LEDGER))
    sub = p.add_subparsers(dest="cmd", required=True)

    s_init = sub.add_parser("init")
    s_init.add_argument("--force", action="store_true")
    s_init.set_defaults(func=cmd_init)

    sub.add_parser("load").set_defaults(func=cmd_load)

    s_up = sub.add_parser("upsert-issue")
    s_up.add_argument("json_path")
    s_up.set_defaults(func=cmd_upsert_issue)

    s_st = sub.add_parser("set-stage")
    s_st.add_argument("number", type=int)
    s_st.add_argument("stage")
    s_st.add_argument("--notes")
    s_st.add_argument("--cause", choices=["ci", "review", "merge", "human"])
    s_st.set_defaults(func=cmd_set_stage)

    s_sf = sub.add_parser("set-field")
    s_sf.add_argument("number", type=int)
    s_sf.add_argument("dotted_path")
    s_sf.add_argument("json_value")
    s_sf.set_defaults(func=cmd_set_field)

    s_ls = sub.add_parser("list")
    s_ls.add_argument("--stage")
    s_ls.set_defaults(func=cmd_list)

    sub.add_parser("resume-plan").set_defaults(func=cmd_resume_plan)

    args = p.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
