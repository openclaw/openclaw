#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.memory_hub.rollback import latest_backup, rollback_file


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--hub-root", required=True)
    ap.add_argument("--target", required=True)
    args = ap.parse_args()

    root = Path(args.hub_root)
    target = Path(args.target)
    backup = latest_backup(root, target.name)
    if backup is None:
        print(json.dumps({"rolled_back": False, "reason": "backup_not_found", "target": str(target)}, ensure_ascii=False, indent=2))
        return

    rollback_file(target, backup)
    print(json.dumps({"rolled_back": True, "target": str(target), "backup": str(backup)}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
