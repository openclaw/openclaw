#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.memory_hub.review_queue import list_review_items


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--hub-root")
    ap.add_argument("--review-file")
    args = ap.parse_args()
    if args.hub_root:
        data = list_review_items(Path(args.hub_root))
    else:
        from scripts.memory_hub.jsonio import read_json

        data = read_json(Path(args.review_file), default={})
    print(json.dumps(data, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
