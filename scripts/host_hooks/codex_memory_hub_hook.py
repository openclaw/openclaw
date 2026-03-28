#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path("/Users/mianfeishitou/OpenClaw/state/workspace-daily/.worktrees/memory-hub")
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.memory_hub.codex_hook_bridge import CODEX_HUB_ROOT, build_task_completed_event, build_user_confirmed_event

INGEST = ROOT / "scripts" / "memory_hub_ingest_event.py"


def run_ingest(event: dict) -> None:
    event_json = CODEX_HUB_ROOT / "tmp-codex-hook-event.json"
    event_json.parent.mkdir(parents=True, exist_ok=True)
    event_json.write_text(json.dumps(event, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    subprocess.run(
        [sys.executable, str(INGEST), "--hub-root", str(CODEX_HUB_ROOT), "--event-json", str(event_json)],
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--event", choices=["user_confirmed", "task_completed"], required=True)
    ap.add_argument("--payload-json", required=True)
    args = ap.parse_args()

    payload = json.loads(Path(args.payload_json).read_text(encoding="utf-8"))
    if args.event == "user_confirmed":
        event = build_user_confirmed_event(payload)
    else:
        event = build_task_completed_event(payload)

    if event is None:
        print(json.dumps({"ok": False, "reason": "event_not_built"}, ensure_ascii=False, indent=2))
        return

    run_ingest(event)
    print(json.dumps({"ok": True, "event_type": event["event_type"], "source_file": event["source_file"]}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
