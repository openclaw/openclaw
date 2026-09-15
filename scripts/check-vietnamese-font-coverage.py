#!/usr/bin/env python3
"""Prove the self-hosted Vietnamese Noto subset covers required cmap + unicode-range.

Usage (from repo root):
  python3 scripts/check-vietnamese-font-coverage.py

Requires: fonttools, brotli (for woff2).
Exit 0 on pass; non-zero with missing codepoints on fail.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

try:
    from fontTools.ttLib import TTFont
except ImportError:
    print("fonttools is required: pip install fonttools brotli", file=sys.stderr)
    sys.exit(2)

ROOT = Path(__file__).resolve().parents[1]
FONTS = ROOT / "ui" / "public" / "fonts"
CSS = FONTS / "noto-sans-vietnamese.css"
WOFF2 = [
    FONTS / "noto-sans-vietnamese.woff2",
    FONTS / "noto-sans-vietnamese-italic.woff2",
]

# Authoritative V1 FAIL gaps: U+1EBF, U+1EA0–U+1EF1, U+031B (plus NFD marks).
REQUIRED = set(range(0x1EA0, 0x1EF2)) | {0x1EBF, 0x031B, 0x0323, 0x0329}
REQUIRED |= set(range(0x0300, 0x030A))


def css_codepoints(text: str) -> set[int]:
    covered: set[int] = set()
    for token in re.findall(r"U\+[0-9A-Fa-f]+(?:-[0-9A-Fa-f]+)?", text):
        parts = token.replace("U+", "").split("-")
        start = int(parts[0], 16)
        end = int(parts[1], 16) if len(parts) > 1 else start
        covered.update(range(start, end + 1))
    return covered


def cmap_codepoints(path: Path) -> set[int]:
    font = TTFont(path)
    covered: set[int] = set()
    for table in font["cmap"].tables:
        covered.update(table.cmap)
    return covered


def missing(have: set[int]) -> list[str]:
    return [f"U+{cp:04X}" for cp in sorted(REQUIRED - have)]


def main() -> int:
    errors = 0
    if not CSS.is_file():
        print(f"FAIL missing stylesheet: {CSS.relative_to(ROOT)}")
        return 1
    for woff in WOFF2:
        if not woff.is_file():
            print(f"FAIL missing font asset: {woff.relative_to(ROOT)}")
            errors += 1
    if errors:
        return 1
    css_miss = missing(css_codepoints(CSS.read_text(encoding="utf-8")))
    if css_miss:
        print(f"FAIL unicode-range in {CSS.name}: missing {', '.join(css_miss)}")
        errors += 1
    else:
        print(f"PASS unicode-range in {CSS.name} covers VN required set")

    for woff in WOFF2:
        cmap_miss = missing(cmap_codepoints(woff))
        if cmap_miss:
            print(f"FAIL cmap in {woff.name}: missing {', '.join(cmap_miss)}")
            errors += 1
        else:
            print(f"PASS cmap in {woff.name} covers VN required set")

    instr = FONTS / "instrument-sans.css"
    instr_cov = css_codepoints(instr.read_text(encoding="utf-8"))
    leaked = sorted(cp for cp in range(0x1EA0, 0x1EF2) if cp in instr_cov)
    if leaked:
        print(
            "WARN instrument-sans.css now claims some U+1EA0–U+1EF1 codepoints: "
            + ", ".join(f"U+{cp:04X}" for cp in leaked)
        )
    else:
        print("PASS instrument-sans.css still skips U+1EA0–U+1EF1 (fallback required)")

    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
