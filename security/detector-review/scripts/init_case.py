#!/usr/bin/env python3
"""
Create a scratch workspace for one GHSA detector review.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path


REPORT_TEMPLATE = """# {ghsa} Detector Review

## Advisory

- GHSA: `{ghsa}`
- URL: ``
- Fix commit: ``
- Vulnerable commit or tree state: ``

## Vulnerable Code

- File: ``
- Vulnerable snippet summary:
- Fixed snippet summary:

## Root Cause

- Input:
- Sink:
- Missing or wrong guard:
- Why this bug exists:

## Detector Decision

| detector | decision | why |
| --- | --- | --- |
| `A` reusable OpenGrep | pending | |
| `B` custom CodeQL | pending | |
| `C` broad OpenGrep | pending | |

## Artifacts

- `A`:
- `B`:
- `C`:

## Validation

### `A` reusable OpenGrep

- positive:
- family-variant positive:
- negative:
- repo scan:

### `B` custom CodeQL

- positive:
- negative:
- repo scan or targeted db:

### `C` broad OpenGrep

- positive:
- repo scan:
- manual review value:

## Recommendation

- Best detector for this bug family:
- Why:
- Next follow-up:
"""


def normalize_ghsa(raw: str) -> str:
    value = raw.strip()
    match = re.search(r"(GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})", value, re.IGNORECASE)
    if match:
        value = match.group(1)
    value = value.upper()
    if not re.fullmatch(r"GHSA-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}", value):
        raise ValueError(f"Invalid GHSA identifier: {raw!r}")
    return value


def write_file(path: Path, content: str, force: bool) -> None:
    if path.exists() and not force:
        return
    path.write_text(content)


def build_case(root: Path, ghsa: str, force: bool) -> Path:
    case_root = root / ".tmp" / "ghsa-detector-review" / ghsa.lower()
    directories = [
        case_root,
        case_root / "opengrep",
        case_root / "opengrep" / "tests",
        case_root / "opengrep" / "tests" / "positive",
        case_root / "opengrep" / "tests" / "negative",
        case_root / "codeql",
        case_root / "codeql" / "queries",
        case_root / "codeql" / "fixtures",
        case_root / "codeql" / "fixtures" / "positive",
        case_root / "codeql" / "fixtures" / "negative",
    ]
    for directory in directories:
        directory.mkdir(parents=True, exist_ok=True)

    write_file(case_root / "report.md", REPORT_TEMPLATE.format(ghsa=ghsa), force)
    write_file(case_root / "opengrep" / "general-rule.yml", "# Add reusable rule here.\n", force)
    write_file(case_root / "opengrep" / "broad-rule.yml", "# Add broad review-aid rule here.\n", force)
    write_file(
        case_root / "codeql" / "queries" / "custom-query.ql",
        "/** Add custom query here. */\n",
        force,
    )
    return case_root


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("ghsa", help="GHSA identifier or advisory URL")
    parser.add_argument(
        "--root",
        default=".",
        help="Repository root where .tmp/ghsa-detector-review should be created",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Overwrite seeded files if they already exist",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        ghsa = normalize_ghsa(args.ghsa)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    case_root = build_case(Path(args.root).resolve(), ghsa, args.force)
    print(case_root)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
