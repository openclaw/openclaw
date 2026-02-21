#!/usr/bin/env python3
"""
aOa Auto-Outline - PostToolUse Hook

When a file is read, automatically trigger structural outline generation.
This caches the file's structure (functions, classes, methods) for prediction.

Fire-and-forget, non-blocking, <10ms.
"""

import sys
import json
import re
import os
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import URLError
from concurrent.futures import ThreadPoolExecutor

# Supported extensions for structural outline
# These are languages with meaningful structure (functions, classes, etc.)
OUTLINE_EXTENSIONS = {
    '.py', '.js', '.jsx', '.ts', '.tsx', '.mjs',  # Python, JavaScript, TypeScript
    '.go', '.rs', '.java', '.c', '.h', '.cpp', '.hpp', '.cc',  # Systems languages
    '.rb', '.php', '.swift', '.kt', '.scala', '.cs',  # Modern languages
    '.lua', '.ex', '.exs', '.hs',  # Scripting/functional
    '.sh', '.bash',  # Shell (limited but useful)
}

# Skip these - no meaningful structural outline
SKIP_EXTENSIONS = {
    '.md', '.json', '.yaml', '.yml', '.toml', '.txt', '.csv',
    '.html', '.css', '.sql', '.xml', '.ini', '.env', '.lock',
    '.png', '.jpg', '.gif', '.svg', '.ico', '.pdf',
}

AOA_URL = os.environ.get('AOA_URL', 'http://localhost:8080')

# Thread pool for non-blocking requests
executor = ThreadPoolExecutor(max_workers=2)


def trigger_outline(file_path: str) -> None:
    """Fire-and-forget outline request."""
    try:
        url = f"{AOA_URL}/outline?file={file_path}"
        req = Request(url, method='GET')
        req.add_header('User-Agent', 'aoa-auto-outline/1.0')
        with urlopen(req, timeout=5) as resp:
            pass  # Just trigger, don't need response
    except Exception:
        pass  # Fire and forget


def main():
    # Read hook input from stdin
    try:
        data = json.load(sys.stdin)
    except json.JSONDecodeError:
        return

    tool = data.get('tool_name', '')
    tool_input = data.get('tool_input', {})

    # Only trigger on Read operations
    if tool != 'Read':
        return

    file_path = tool_input.get('file_path', '')
    if not file_path:
        return

    # Check extension
    ext = Path(file_path).suffix.lower()

    # Skip non-code files
    if ext in SKIP_EXTENSIONS:
        return

    # Only outline code files with structure
    if ext not in OUTLINE_EXTENSIONS:
        return

    # Fire-and-forget: submit outline request in background
    executor.submit(trigger_outline, file_path)


if __name__ == '__main__':
    main()
