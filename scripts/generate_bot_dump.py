#!/usr/bin/env python3
"""v16.7 — Generate OpenClaw_Bot_Dump.md for NotebookLM ingestion.

Compact variant: Python-only sources (src/*.py, src/pipeline/*.py, tests/*.py)
+ root docs. Stays well below NotebookLM's 500 000-word-per-source limit.

Usage:
    python scripts/generate_bot_dump.py
"""
import os
import sys
import time

_project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _project_root not in sys.path:
    sys.path.insert(0, _project_root)

from src.memory_mcp import export_bot_codebase_compact  # noqa: E402


def main() -> None:
    print("🤖 OpenClaw Bot — Compact Python Dump Generator v16.7")
    print("=" * 55)
    print("  Target: NotebookLM (<500 000 words limit)")
    print()

    t0 = time.perf_counter()
    body = export_bot_codebase_compact()
    elapsed = time.perf_counter() - t0

    dump_path = os.path.join(_project_root, "OpenClaw_Bot_Dump.md")
    lines = body.splitlines()
    size_kb = os.path.getsize(dump_path) / 1024
    word_count = len(body.split())
    file_count = body.count("## File:")

    print(f"✅ Done in {elapsed:.2f}s")
    print(f"   Files exported : {file_count}")
    print(f"   Total lines    : {len(lines):,}")
    print(f"   Word count     : {word_count:,}  (limit: 500 000)")
    print(f"   File size      : {size_kb:,.1f} KB")
    print(f"   Output         : {dump_path}")

    limit = 500_000
    pct = word_count / limit * 100
    bar_filled = int(pct / 5)
    bar = "█" * bar_filled + "░" * (20 - bar_filled)
    status = "✅ SAFE" if word_count < limit else "❌ OVER LIMIT"
    print()
    print(f"   NotebookLM usage: [{bar}] {pct:.1f}%  {status}")
    print()
    print("--- Table of Contents (first 20 entries) ---")
    toc_lines = [l for l in lines if l.startswith("- [")]
    for line in toc_lines[:20]:
        print(line)
    if len(toc_lines) > 20:
        print(f"   ... and {len(toc_lines) - 20} more files")
    print()
    print(f"📎 Upload to NotebookLM: {dump_path}")


if __name__ == "__main__":
    main()
