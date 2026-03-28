#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.memory_hub.retriever import retrieve


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--hub-root", required=True)
    ap.add_argument("--query-type", required=True)
    ap.add_argument("--query", required=True)
    args = ap.parse_args()
    result = retrieve(Path(args.hub_root) / "hub.sqlite3", args.query_type, args.query)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
