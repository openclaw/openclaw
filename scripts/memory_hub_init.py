#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.memory_hub.index_db import init_db


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--hub-root", required=True)
    args = ap.parse_args()
    root = Path(args.hub_root).resolve()
    init_db(root / "hub.sqlite3")


if __name__ == "__main__":
    main()
