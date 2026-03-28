#!/usr/bin/env python3
"""
List dataset refs owned by the authenticated Kaggle user (kaggle datasets list -m).

Auth: KAGGLE_USERNAME + KAGGLE_KEY in the environment, or ~/.kaggle/kaggle.json (never commit credentials).
Pagination: repeats -p 1,2,... until a page has no rows.
"""
from __future__ import annotations

import csv
import io
import subprocess
import sys


def _run_kaggle(argv: list[str]) -> subprocess.CompletedProcess[str]:
    for cmd in (["kaggle", *argv], ["python3", "-m", "kaggle", *argv]):
        try:
            return subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                check=False,
            )
        except FileNotFoundError:
            continue
    print(
        "kaggle CLI not found. Install: pip install -r skills/football-match-analyst/requirements-kaggle.txt",
        file=sys.stderr,
    )
    sys.exit(127)


def main() -> None:
    page = 1
    while page < 10000:
        p = _run_kaggle(["datasets", "list", "-m", "-v", "-p", str(page)])
        if p.returncode != 0:
            print(p.stderr or p.stdout, file=sys.stderr)
            sys.exit(p.returncode)
        r = csv.DictReader(io.StringIO(p.stdout))
        if not r.fieldnames:
            break
        rows = list(r)
        if not rows:
            break
        for row in rows:
            ref = (row.get("ref") or "").strip()
            if ref:
                print(ref)
        page += 1


if __name__ == "__main__":
    main()
