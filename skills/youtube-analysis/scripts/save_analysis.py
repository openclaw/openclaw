#!/usr/bin/env python3
"""Save analysis markdown to disk.

Usage:
  save_analysis.py --title <title> --video-id <id> [--batch-name <name>]

Input:  analysis markdown via stdin
Output: saved file path to stdout
"""
import argparse
import os
import re
import sys


def slugify(text):
    """Convert text to filesystem-safe slug."""
    text = text.lower().strip()
    text = re.sub(r"[^\w\s-]", "", text)
    text = re.sub(r"[\s_]+", "-", text)
    return text[:80]


def main():
    parser = argparse.ArgumentParser(description="Save analysis markdown to disk")
    parser.add_argument("--title", required=True, help="Video title")
    parser.add_argument("--video-id", required=True, help="Video ID")
    parser.add_argument("--batch-name", help="Batch name for grouped analysis")
    args = parser.parse_args()

    base = os.path.expanduser("~/.openclaw/youtube-analysis")

    if args.batch_name:
        batch_slug = slugify(args.batch_name)
        batch_dir = os.path.join(base, f"batch-{batch_slug}")
        if args.video_id == "synthesis":
            # Synthesis file goes at batch root, not in a subdirectory
            os.makedirs(batch_dir, exist_ok=True)
            out_path = os.path.join(batch_dir, "synthesis.md")
        else:
            out_dir = os.path.join(batch_dir, args.video_id)
            os.makedirs(out_dir, exist_ok=True)
            out_path = os.path.join(out_dir, "analysis.md")
    else:
        out_dir = os.path.join(base, args.video_id)
        os.makedirs(out_dir, exist_ok=True)
        out_path = os.path.join(out_dir, "analysis.md")

    content = sys.stdin.read()
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(content)

    print(out_path)


if __name__ == "__main__":
    main()
