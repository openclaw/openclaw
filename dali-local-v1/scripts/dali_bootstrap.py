#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from memory_store import append_event, bootstrap_workspace, list_recent_events  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Bootstrap the first Dali-local-v1 substrate.")
    parser.add_argument("--root", default=str(ROOT), help="Workspace root for dali-local-v1")
    parser.add_argument("--db-path", default=None, help="Explicit sqlite database path")
    parser.add_argument(
        "--seed-smoke-event",
        action="store_true",
        help="Append a smoke-test bootstrap event after initializing the database",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    summary = bootstrap_workspace(args.root, args.db_path)
    db_path = summary["dbPath"]
    if args.seed_smoke_event:
        summary["smokeEvent"] = append_event(
            db_path,
            event_type="bootstrap_smoke",
            source="dali_bootstrap.py",
            payload={
                "message": "Initial Dali-local-v1 bootstrap completed",
                "root": summary["root"],
            },
        )
        summary["recentEvents"] = list_recent_events(db_path, limit=5)
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
