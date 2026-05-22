#!/usr/bin/env python3
"""Wrap ClawTwin deck SVGs to 16:9 (1920x1080): uniform scale + letterbox + footer band.

Reads legacy slides authored at width 1200 (various heights). Already-wrapped files
(width 1920 + inner translate scale group) are skipped.

After editing slide content in 1200 coordinates, run this once to rebuild the outer frame.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FILES: list[tuple[str, int, str]] = [
    ("CLAWTWIN-SVG-01-OVERVIEW.svg", 688, "1/5"),
    ("CLAWTWIN-SVG-02-PLATFORM.svg", 748, "2/5"),
    ("CLAWTWIN-SVG-03-FLYWHEEL.svg", 668, "3/5"),
    ("CLAWTWIN-SVG-04-BUSINESS-TRUST.svg", 700, "4/5"),
    ("CLAWTWIN-SVG-05-SAFE-AGENT-GOVERNANCE.svg", 720, "5/5"),
]

SRC_W = 1200
CANVAS_W = 1920
CANVAS_H = 1080
FOOTER_H = 52
CONTENT_H = CANVAS_H - FOOTER_H


def wrap_footer(film_label: str) -> str:
    fy = CONTENT_H
    return f"""  </g>
  <line x1="0" y1="{fy}" x2="{CANVAS_W}" y2="{fy}" stroke="#2C5282" stroke-width="1"/>
  <rect x="0" y="{fy}" width="{CANVAS_W}" height="{FOOTER_H}" fill="#0D2340"/>
  <text x="44" y="{fy + 30}" font-size="13" fill="#94A3B8">ClawTwin</text>
  <text x="{CANVAS_W - 44}" y="{fy + 30}" font-size="13" fill="#94A3B8" text-anchor="end">图 {film_label}</text>
</svg>"""


def main() -> None:
    for name, src_h, film_label in FILES:
        path = ROOT / name
        raw = path.read_text(encoding="utf-8")

        if 'width="1920"' in raw and 'height="1080"' in raw and "<g transform=\"translate(" in raw:
            print(f"{name}: skip (already 16:9 wrapped)")
            continue

        s = min(CANVAS_W / SRC_W, CONTENT_H / src_h)
        tx = (CANVAS_W - SRC_W * s) / 2
        ty = (CONTENT_H - src_h * s) / 2

        raw = re.sub(
            r'<text x="1180"[^>]*>\s*ClawTwin · \d/5\s*</text>\s*',
            "",
            raw,
        )

        raw = re.sub(
            r'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 \d+"',
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{CANVAS_W}" height="{CANVAS_H}" '
            f'viewBox="0 0 {CANVAS_W} {CANVAS_H}" preserveAspectRatio="xMidYMid meet"',
            raw,
            count=1,
        )

        raw = re.sub(
            r'<rect width="1200" height="\d+" fill="#F8FAFD"/>',
            f'<rect width="{CANVAS_W}" height="{CANVAS_H}" fill="#F8FAFD"/>',
            raw,
            count=1,
        )

        group_open = f'<g transform="translate({tx:.4f},{ty:.4f}) scale({s:.6f})">'
        needle = f'<rect width="{CANVAS_W}" height="{CANVAS_H}" fill="#F8FAFD"/>'
        if needle not in raw:
            print(f"{name}: error — missing bg rect anchor (need 1200×H source)", file=sys.stderr)
            sys.exit(1)
        raw = raw.replace(needle, needle + "\n  " + group_open, 1)

        footer = wrap_footer(film_label)

        if raw.count("</svg>") != 1:
            print(f"{name}: error — expected single </svg>", file=sys.stderr)
            sys.exit(1)
        raw = raw.replace("</svg>", footer)

        path.write_text(raw, encoding="utf-8")
        print(f"{name}: scale={s:.4f} translate=({tx:.1f},{ty:.1f})")


if __name__ == "__main__":
    main()
