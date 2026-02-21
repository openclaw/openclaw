#!/usr/bin/env python3
"""
aOa Intent Prefetch - PreToolUse Hook

Predicts related files before tool execution.
Only activates after 10+ recorded intents (avoids cold-start noise).

Output format matches aOa branding:
  ⚡ aOa Prefetch │ 2.3ms │ 4 related files
"""

import sys
import json
import os
import time
from urllib.request import Request, urlopen
from urllib.error import URLError
from urllib.parse import quote

AOA_URL = os.environ.get("AOA_URL", "http://localhost:8080")
MIN_INTENTS = 10  # Don't prefetch until we have enough data

# ANSI colors for branding (matching status line)
CYAN = "\033[36m"
BOLD = "\033[1m"
DIM = "\033[2m"
YELLOW = "\033[33m"
GREEN = "\033[32m"
RESET = "\033[0m"


def get_intent_count() -> int:
    """Check how many intents we have."""
    try:
        req = Request(f"{AOA_URL}/intent/stats")
        with urlopen(req, timeout=1) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            return data.get('total_records', 0)
    except (URLError, Exception):
        return 0


def get_related_files(file_path: str) -> tuple[list, list]:
    """
    Get files related to the given path via shared intent tags.
    Returns (related_files, tags_used)
    """
    try:
        # Get tags for this file (URL-encode the path)
        encoded_path = quote(file_path, safe='')
        req = Request(f"{AOA_URL}/intent/file?path={encoded_path}")
        with urlopen(req, timeout=1) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            tags = data.get('tags', [])

        if not tags:
            return [], []

        # Get files for the most common tags
        related = set()
        for tag in tags[:3]:  # Top 3 tags
            clean_tag = tag.lstrip('#')
            req = Request(f"{AOA_URL}/intent/files?tag={quote(clean_tag, safe='')}")
            with urlopen(req, timeout=1) as resp:
                data = json.loads(resp.read().decode('utf-8'))
                for f in data.get('files', []):
                    # Filter: must be a real file path
                    if (f != file_path and
                        not f.startswith('pattern:') and
                        '/' in f and
                        '.' in os.path.basename(f)):
                        related.add(f)

        return list(related)[:5], [t.lstrip('#') for t in tags[:3]]

    except (URLError, Exception):
        return [], []


def get_predicted_next(file_path: str) -> list:
    """Get predicted next files based on co-occurrence patterns."""
    try:
        encoded_path = quote(file_path, safe='')
        req = Request(f"{AOA_URL}/predict?file={encoded_path}&limit=3")
        with urlopen(req, timeout=1) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            return data.get('predictions', [])
    except (URLError, Exception):
        return []


def log_prediction(session_id: str, predicted_files: list, tags: list, trigger_file: str):
    """Log a prediction to Redis for later hit/miss comparison."""
    if not predicted_files:
        return

    try:
        payload = json.dumps({
            'session_id': session_id,
            'predicted_files': predicted_files,
            'tags': tags,
            'trigger_file': trigger_file,
            'confidence': 0.8  # TODO: Calculate real confidence
        }).encode('utf-8')

        req = Request(
            f"{AOA_URL}/predict/log",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST"
        )
        urlopen(req, timeout=1)
    except (URLError, Exception):
        pass  # Fire and forget


def format_output(file_path: str, related: list, predicted: list, tags: list, elapsed_ms: float) -> str:
    """Format prefetch output with aOa branding."""
    project_root = os.environ.get('CLAUDE_PROJECT_DIR', '/home/corey/aOa')

    def rel_path(p):
        if p.startswith(project_root):
            return p[len(project_root):].lstrip('/')
        return os.path.basename(p)

    # Build the header line (matches status line style)
    # ⚡ aOa Prefetch │ 2.3ms │ 4 related │ hooks python
    parts = [
        f"{CYAN}{BOLD}⚡ aOa Prefetch{RESET}",
        f"{DIM}│{RESET}",
        f"{GREEN}{elapsed_ms:.1f}ms{RESET}",
    ]

    count = len(related) + len(predicted)
    if count > 0:
        parts.extend([f"{DIM}│{RESET}", f"{count} files"])

    if tags:
        parts.extend([f"{DIM}│{RESET}", f"{YELLOW}{' '.join(tags)}{RESET}"])

    header = " ".join(parts)

    # Build file list
    lines = [header]

    if predicted:
        pred_paths = [rel_path(p) for p in predicted[:3]]
        lines.append(f"  {BOLD}Next →{RESET} {', '.join(pred_paths)}")

    if related:
        # Dedupe and format
        seen = set()
        unique = []
        for r in related:
            rp = rel_path(r)
            if rp not in seen and len(rp) > 2:  # Filter junk
                seen.add(rp)
                unique.append(rp)
        if unique:
            lines.append(f"  {DIM}Related:{RESET} {', '.join(unique[:5])}")

    return '\n'.join(lines)


def main():
    start_time = time.perf_counter()

    try:
        data = json.load(sys.stdin)
    except (json.JSONDecodeError, Exception):
        return

    # Check if we have enough data
    if get_intent_count() < MIN_INTENTS:
        return

    # Extract session_id for prediction tracking (QW-2: Phase 2)
    session_id = data.get('session_id', 'unknown')

    # Extract file path from tool input
    tool_input = data.get('tool_input', {})
    file_path = tool_input.get('file_path') or tool_input.get('path')

    if not file_path:
        return

    # Get related files via tags
    related, tags = get_related_files(file_path)

    # Get predicted next files via co-occurrence (if endpoint exists)
    predicted = get_predicted_next(file_path)

    # Calculate elapsed time
    elapsed_ms = (time.perf_counter() - start_time) * 1000

    # Output prefetch suggestions if we have any
    if related or predicted:
        output = format_output(file_path, related, predicted, tags, elapsed_ms)
        print(output, file=sys.stderr)

        # Log prediction to Redis for hit/miss tracking (QW-2)
        all_predicted = list(set(related + predicted))
        log_prediction(session_id, all_predicted, tags, file_path)


if __name__ == "__main__":
    main()
