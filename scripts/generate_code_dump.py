#!/usr/bin/env python3
"""v16.6 — Generate OpenClaw_Codebase_Dump.md for NotebookLM ingestion.

Usage:
    python scripts/generate_code_dump.py
"""
import os
import sys
import time

# Ensure project root on sys.path
_project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _project_root not in sys.path:
    sys.path.insert(0, _project_root)

from src.memory_mcp import export_openclaw_codebase  # noqa: E402


def main() -> None:
    print("🧬 OpenClaw Codebase Mega-Dump Generator v16.6")
    print("=" * 50)
    t0 = time.perf_counter()

    body = export_openclaw_codebase()

    elapsed = time.perf_counter() - t0
    lines = body.splitlines()
    dump_path = os.path.join(_project_root, "OpenClaw_Codebase_Dump.md")
    size_kb = os.path.getsize(dump_path) / 1024

    print(f"✅ Done in {elapsed:.2f}s")
    print(f"   Files exported : {body.count('## File:')}")
    print(f"   Total lines    : {len(lines):,}")
    print(f"   File size      : {size_kb:,.1f} KB")
    print(f"   Output         : {dump_path}")
    print()
    print("--- Table of Contents (first 15 entries) ---")
    toc_lines = [l for l in lines if l.startswith("- [")]
    for line in toc_lines[:15]:
        print(line)
    if len(toc_lines) > 15:
        print(f"   ... and {len(toc_lines) - 15} more files")


if __name__ == "__main__":
    main()
