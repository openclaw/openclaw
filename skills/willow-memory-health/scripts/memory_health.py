#!/usr/bin/env python3
"""
memory_health.py — OpenClaw memory health diagnostic

Scans a memory directory for four failure modes:
  STALE / DEAD  — file age by bucket (HOT <7d, WARM 7-30d, STALE 30-90d, DEAD >90d)
  REDUNDANT     — near-duplicate titles (Jaccard similarity >= 0.55)
  DARK          — file exists but qmd search can't find it (requires --qmd flag)
  CONTRADICTION — opposing status words in same file

Usage:
  python3 memory_health.py --dir memory/ --limit 50
  python3 memory_health.py --dir memory/ --limit 50 --qmd
  python3 memory_health.py --dir memory/ --json
"""

import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

# ── Config ────────────────────────────────────────────────────────────────────

HOT_DAYS   = 7
WARM_DAYS  = 30
STALE_DAYS = 90

REDUNDANCY_THRESHOLD = 0.55

CONTRADICTION_PAIRS = [
    ("open",      "closed"),
    ("complete",  "incomplete"),
    ("fixed",     "broken"),
    ("deployed",  "not deployed"),
    ("committed", "uncommitted"),
    ("blocked",   "unblocked"),
    ("active",    "archived"),
    ("up",        "down"),
    ("enabled",   "disabled"),
    ("running",   "stopped"),
]

# Files matching this pattern get dates from their filename.
DATED_RE = re.compile(r"(\d{4})-(\d{2})-(\d{2})\.md$")

# Evergreen files — scored for REDUNDANT/CONTRADICTION but never STALE/DEAD.
EVERGREEN_NAMES = {"MEMORY.md", "memory.md"}


# ── Helpers ───────────────────────────────────────────────────────────────────

def file_date(path: Path) -> datetime | None:
    """Return file date from filename (YYYY-MM-DD.md) or mtime."""
    m = DATED_RE.search(path.name)
    if m:
        try:
            return datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)),
                            tzinfo=timezone.utc)
        except ValueError:
            pass
    return datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)


def is_evergreen(path: Path, base: Path) -> bool:
    if path.name in EVERGREEN_NAMES:
        return True
    if path.parent == base and not DATED_RE.search(path.name):
        return True
    return False


def age_bucket(path: Path, base: Path) -> str:
    if is_evergreen(path, base):
        return "EVERGREEN"
    dt = file_date(path)
    if dt is None:
        return "UNKNOWN"
    age_days = (datetime.now(tz=timezone.utc) - dt).days
    if age_days < HOT_DAYS:
        return "HOT"
    elif age_days < WARM_DAYS:
        return "WARM"
    elif age_days < STALE_DAYS:
        return "STALE"
    else:
        return "DEAD"


def read_title(path: Path) -> str:
    """Extract first H1 heading from markdown, falling back to filename stem."""
    try:
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            if line.startswith("# "):
                return line[2:].strip()
    except OSError:
        pass
    return path.stem


def read_snippet(path: Path, max_chars: int = 500) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")[:max_chars]
    except OSError:
        return ""


def word_set(text: str) -> set:
    words = text.lower().replace("-", " ").replace("_", " ").split()
    return {w.strip(".,;:()[]") for w in words if len(w) >= 4}


def jaccard(a: str, b: str) -> float:
    sa, sb = word_set(a), word_set(b)
    if not sa or not sb:
        return 0.0
    return len(sa & sb) / len(sa | sb)


def check_contradiction(title: str, snippet: str) -> list[str]:
    text = f"{title} {snippet}".lower()
    hits = []
    for pos, neg in CONTRADICTION_PAIRS:
        # Strip all occurrences of the negative phrase before checking for the
        # positive so that "not deployed" alone doesn't satisfy both halves.
        # Then use \b so "committed" can't match inside "uncommitted".
        stripped = re.sub(re.escape(neg), "", text)
        if re.search(r"\b" + re.escape(pos) + r"\b", stripped) and neg in text:
            hits.append(f"'{pos}' vs '{neg}'")
    return hits


def check_dark_qmd(title: str) -> tuple[bool, int]:
    """Run qmd query and check if title surfaces. Returns (is_dark, result_count)."""
    try:
        result = subprocess.run(
            ["qmd", "query", title, "--json", "-n", "5"],
            capture_output=True, text=True, timeout=10,
        )
        raw = result.stdout.strip()
        if not raw:
            return True, 0
        data = json.loads(raw)
        results = data if isinstance(data, list) else data.get("results", [])
        for r in results:
            r_title = r.get("title", "") or Path(r.get("file", r.get("path", ""))).stem
            if jaccard(title, r_title) > 0.5:
                return False, len(results)
        return True, len(results)
    except (subprocess.TimeoutExpired, FileNotFoundError, json.JSONDecodeError):
        return False, -1  # qmd unavailable — skip DARK


# ── Main ──────────────────────────────────────────────────────────────────────

def run(memory_dir: str, limit: int, use_qmd: bool, as_json: bool):
    base = Path(memory_dir).expanduser().resolve()
    if not base.exists():
        print(f"ERROR: directory not found: {base}", file=sys.stderr)
        sys.exit(1)

    files = sorted(
        [f for f in base.rglob("*.md") if "archive" not in f.parts],
        key=lambda f: f.stat().st_mtime,
        reverse=True,
    )[:limit]

    if not files:
        print(f"No .md files found in {base}")
        sys.exit(0)

    titles = [(f, read_title(f)) for f in files]
    buckets: dict[str, int] = {"HOT": 0, "WARM": 0, "STALE": 0, "DEAD": 0,
                                "EVERGREEN": 0, "UNKNOWN": 0}
    results = []
    redundant_pairs: list[tuple[tuple[str, str], float]] = []
    dark_list: list[tuple[str, str]] = []
    contradiction_list: list[tuple[str, list[str]]] = []

    for i, (path, title) in enumerate(titles):
        flags = []
        bucket = age_bucket(path, base)
        buckets[bucket] = buckets.get(bucket, 0) + 1
        if bucket in ("STALE", "DEAD"):
            flags.append(bucket)

        # REDUNDANT
        for j, (other_path, other_title) in enumerate(titles):
            if i == j:
                continue
            score = jaccard(title, other_title)
            if score >= REDUNDANCY_THRESHOLD:
                pair = tuple(sorted([str(path.name)[:50], str(other_path.name)[:50]]))
                if pair not in [p[0] for p in redundant_pairs]:
                    redundant_pairs.append((pair, score))
                if "REDUNDANT" not in flags:
                    flags.append("REDUNDANT")

        # CONTRADICTION
        snippet = read_snippet(path)
        contradictions = check_contradiction(title, snippet)
        if contradictions:
            contradiction_list.append((path.name, contradictions))
            flags.append("CONTRADICTION")

        # DARK
        if use_qmd:
            is_dark, count = check_dark_qmd(title)
            if is_dark and count >= 0:
                dark_list.append((path.name, bucket))
                flags.append("DARK")

        results.append({
            "file":   path.name[:40],
            "bucket": bucket,
            "flags":  flags,
            "title":  title[:55],
        })

    # ── Output ────────────────────────────────────────────────────────────────

    if as_json:
        print(json.dumps({
            "dir": str(base),
            "scored": len(results),
            "buckets": buckets,
            "records": results,
            "redundant_pairs": [{"files": list(p), "score": s} for p, s in redundant_pairs[:10]],
            "dark": [{"file": f, "bucket": b} for f, b in dark_list],
            "contradictions": [{"file": f, "hits": h} for f, h in contradiction_list],
        }, indent=2))
        return

    print(f"\nWILLOW MEMORY HEALTH — {memory_dir} ({len(results)} files)")
    print("━" * 60)
    print(f"{'FILE':<42} {'BUCKET':<10} FLAGS")
    print("─" * 80)
    for r in results:
        flag_str = " | ".join(r["flags"]) if r["flags"] else "OK"
        print(f"{r['file']:<42} {r['bucket']:<10} {flag_str}")

    print()
    print("━" * 60)
    print("SUMMARY")
    print(f"  Files scored   : {len(results)}")
    print(f"  HOT  (<7d)     : {buckets['HOT']}")
    print(f"  WARM (7–30d)   : {buckets['WARM']}")
    print(f"  STALE (30–90d) : {buckets['STALE']}")
    print(f"  DEAD (>90d)    : {buckets['DEAD']}")
    print(f"  EVERGREEN      : {buckets['EVERGREEN']}")
    dark_note = "" if use_qmd else "  (--qmd not set, DARK skipped)"
    print(f"  DARK           : {len(dark_list)}{dark_note}")
    print(f"  REDUNDANT pairs: {len(redundant_pairs)}")
    print(f"  CONTRADICTION  : {len(contradiction_list)}")

    if dark_list:
        print()
        print("DARK (exist in memory, invisible to qmd search):")
        for fname, bucket in dark_list:
            print(f"  [{bucket}]  {fname}")
        print("  → Fix: run `qmd update` or `openclaw memory sync`")

    if redundant_pairs:
        print()
        print("REDUNDANT PAIRS (consider merging):")
        for (a, b), score in redundant_pairs[:10]:
            print(f"  {score:.2f}  '{a}' ↔ '{b}'")

    if contradiction_list:
        print()
        print("CONTRADICTION FLAGS (review and clarify):")
        for fname, hits in contradiction_list:
            print(f"  {fname}: {', '.join(hits)}")

    print()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="OpenClaw memory health diagnostic")
    parser.add_argument("--dir",   required=True, help="Path to memory directory")
    parser.add_argument("--limit", type=int, default=50,
                        help="Max files to score, most recent first (default: 50)")
    parser.add_argument("--qmd",  action="store_true",
                        help="Enable DARK detection via qmd query CLI")
    parser.add_argument("--json", action="store_true", dest="as_json",
                        help="Output machine-readable JSON")
    args = parser.parse_args()
    run(args.dir, args.limit, args.qmd, args.as_json)
