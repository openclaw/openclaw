#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path("/Users/mianfeishitou/OpenClaw/state/workspace-daily/.worktrees/memory-hub")
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.memory_hub.claude_hook_bridge import CLAUDE_HUB_ROOT, build_stop_event, build_user_prompt_event

INGEST = ROOT / "scripts" / "memory_hub_ingest_event.py"


def run_ingest(event: dict) -> None:
    event_json = CLAUDE_HUB_ROOT / "tmp-hook-event.json"
    event_json.parent.mkdir(parents=True, exist_ok=True)
    event_json.write_text(json.dumps(event, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    subprocess.run(
        [sys.executable, str(INGEST), "--hub-root", str(CLAUDE_HUB_ROOT), "--event-json", str(event_json)],
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        print("{}")
        return

    hook_event = payload.get("hook_event_name")
    event = None
    if hook_event == "UserPromptSubmit":
        event = build_user_prompt_event(payload)
    elif hook_event == "Stop":
        event = build_stop_event(payload)

    if event is not None:
        run_ingest(event)
    print("{}")


if __name__ == "__main__":
    main()
