#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

CLAUDE_SETTINGS = Path("/Users/mianfeishitou/.claude/settings.json")
SOURCE = Path("/Users/mianfeishitou/OpenClaw/state/workspace-daily/.worktrees/memory-hub/config/host/claude-settings.memory-hub.json")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--print-only", action="store_true")
    args = ap.parse_args()

    source = json.loads(SOURCE.read_text(encoding="utf-8"))
    current = json.loads(CLAUDE_SETTINGS.read_text(encoding="utf-8"))
    hooks = current.setdefault("hooks", {})
    hooks.update(source["hooks"])

    if args.print_only:
        print(json.dumps(current, ensure_ascii=False, indent=2))
        return

    CLAUDE_SETTINGS.write_text(json.dumps(current, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(str(CLAUDE_SETTINGS))


if __name__ == "__main__":
    main()
