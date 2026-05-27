#!/usr/bin/env python3
"""Verify every explicit `COPY <src>` in Dockerfile.multitenant is covered by
on.push.paths in .github/workflows/build-runtime-image.yml. Class-fix for
rockie-workspace#915 (instance-fix was #914). Catch-all `COPY . .` and
downstream pnpm build steps are out of scope — the human-curated trigger
covers those. Exits 0 if covered, 1 on drift."""
from __future__ import annotations

import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DOCKERFILE = REPO / "Dockerfile.multitenant"
WORKFLOW = REPO / ".github" / "workflows" / "build-runtime-image.yml"


def parse_explicit_copy_sources(text: str) -> set[str]:
    sources: set[str] = set()
    for raw in text.splitlines():
        line = raw.strip()
        if not line.startswith("COPY "):
            continue
        if "--from=" in line:
            continue
        tokens = [t for t in line[5:].split() if not t.startswith("--")]
        if len(tokens) < 2:
            continue
        for src in tokens[:-1]:
            if src == "." or src == "./":
                continue
            sources.add(src.rstrip("/"))
    return sources


def parse_workflow_paths(text: str) -> list[str]:
    push_match = re.search(r"^\s*push:\s*\n", text, re.MULTILINE)
    if not push_match:
        raise SystemExit("ERROR: workflow has no on.push section")
    block = text[push_match.end():]
    paths_match = re.search(r"^(\s+)paths:\s*\n", block, re.MULTILINE)
    if not paths_match:
        raise SystemExit("ERROR: on.push has no paths list")
    indent = paths_match.group(1)
    out: list[str] = []
    for raw in block[paths_match.end():].splitlines():
        if not raw.strip():
            continue
        if not raw.startswith(indent + " "):
            break
        m = re.match(r"\s*-\s+(.+?)\s*$", raw)
        if not m:
            break
        out.append(m.group(1).strip().strip('"').strip("'"))
    return out


def glob_to_regex(glob: str) -> str:
    out: list[str] = []
    i = 0
    while i < len(glob):
        c = glob[i]
        if c == "*" and i + 1 < len(glob) and glob[i + 1] == "*":
            out.append(".*")
            i += 2
        elif c == "*":
            out.append("[^/]*")
            i += 1
        elif c == "?":
            out.append("[^/]")
            i += 1
        elif c in ".+()|^$[]{}\\":
            out.append("\\" + c)
            i += 1
        else:
            out.append(c)
            i += 1
    return "^" + "".join(out) + "$"


def covered(probe: str, globs: list[str]) -> bool:
    return any(re.match(glob_to_regex(g), probe) for g in globs)


def required_probes(src: str) -> list[str]:
    """Probes that must match — for a dir we test a file under it; for a file we test the literal."""
    full = REPO / src
    if full.is_dir():
        return [f"{src}/probe-file", f"{src}/sub/probe-file"]
    return [src]


def main() -> int:
    df = DOCKERFILE.read_text()
    wf = WORKFLOW.read_text()

    sources = parse_explicit_copy_sources(df)
    workflow_paths = parse_workflow_paths(wf)

    missing: list[tuple[str, str]] = []
    for src in sorted(sources):
        for probe in required_probes(src):
            if not covered(probe, workflow_paths):
                missing.append((src, probe))
                break

    if missing:
        print("BUILD-TRIGGER DRIFT — Dockerfile.multitenant COPY paths not covered by workflow trigger:", file=sys.stderr)
        for src, probe in missing:
            print(f"  - COPY source `{src}` (probe `{probe}` matches no trigger glob)", file=sys.stderr)
        print("", file=sys.stderr)
        print(f"Fix: add the missing paths to on.push.paths in {WORKFLOW.relative_to(REPO)}.", file=sys.stderr)
        print("See rockie-workspace#915 for context.", file=sys.stderr)
        return 1

    print(f"OK — {len(sources)} explicit Dockerfile.multitenant COPY sources covered by {len(workflow_paths)} trigger paths.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
