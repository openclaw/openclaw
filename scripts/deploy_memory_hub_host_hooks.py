#!/usr/bin/env python3
from __future__ import annotations

import argparse
import shutil
from pathlib import Path

ROOT = Path("/Users/mianfeishitou/OpenClaw/state/workspace-daily/.worktrees/memory-hub")
HOST_HOOKS = ROOT / "scripts" / "host_hooks"

TARGETS = {
    "claude": HOST_HOOKS / "claude_memory_hub_hook.py",
    "openclaw": HOST_HOOKS / "openclaw_memory_hub_hook.py",
    "codex": HOST_HOOKS / "codex_memory_hub_hook.py",
}

DESTINATIONS = {
    "claude": Path("/Users/mianfeishitou/.claude/hooks/memory_hub_claude_hook.py"),
    "openclaw": Path("/Users/mianfeishitou/OpenClaw/state/workspace-daily/scripts/openclaw_memory_hub_hook.py"),
    "codex": Path("/Users/mianfeishitou/.codex/codex_memory_hub_hook.py"),
}


def deploy(name: str) -> Path:
    src = TARGETS[name]
    dst = DESTINATIONS[name]
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)
    dst.chmod(0o700)
    return dst


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--target", choices=["claude", "openclaw", "codex", "all"], default="all")
    args = ap.parse_args()

    names = [args.target] if args.target != "all" else ["claude", "openclaw", "codex"]
    for name in names:
        dst = deploy(name)
        print(f"{name}: {dst}")


if __name__ == "__main__":
    main()
