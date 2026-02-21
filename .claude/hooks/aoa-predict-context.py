#!/usr/bin/env python3
"""
aOa Predictive Context - UserPromptSubmit Hook

Predicts relevant files based on prompt keywords and injects context for Claude.
Returns JSON with hookSpecificOutput.additionalContext for discrete context injection.

Output format:
{
    "hookSpecificOutput": {
        "hookEventName": "UserPromptSubmit",
        "additionalContext": "## aOa Predicted Files\n- `file.py` (85%)\n..."
    }
}
"""

import sys
import json
import os
import re
import time
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import URLError

AOA_URL = os.environ.get("AOA_URL", "http://localhost:8080")
MIN_INTENTS = 5  # Don't predict until we have enough data (lower for active projects)
MAX_SNIPPET_LINES = 15  # Lines per file snippet
MAX_FILES = 3  # Maximum files to include

# Load project_id from .aoa/home.json (created by aoa init)
HOOK_DIR = Path(__file__).parent
PROJECT_ROOT = HOOK_DIR.parent.parent  # plugin/hooks/ -> plugin/ -> project/
AOA_HOME_FILE = PROJECT_ROOT / ".aoa" / "home.json"

if AOA_HOME_FILE.exists():
    _config = json.loads(AOA_HOME_FILE.read_text())
    PROJECT_ID = _config.get("project_id", "")
else:
    PROJECT_ID = ""

# Stopwords for keyword extraction
STOPWORDS = {
    'the', 'and', 'for', 'that', 'this', 'with', 'from', 'have', 'what', 'how',
    'can', 'you', 'are', 'please', 'help', 'want', 'need', 'make', 'use', 'get',
    'add', 'fix', 'update', 'change', 'create', 'delete', 'remove', 'show', 'find',
    'look', 'see', 'let', 'know', 'would', 'could', 'should', 'will', 'just',
    'like', 'also', 'more', 'some', 'any', 'all', 'new', 'now', 'about', 'into'
}


def get_intent_count() -> int:
    """Check how many intents we have (avoid cold-start predictions)."""
    try:
        req = Request(f"{AOA_URL}/intent/stats")
        with urlopen(req, timeout=1) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            return data.get('total_records', 0)
    except (URLError, Exception):
        return 0


def extract_keywords(prompt: str) -> list:
    """
    Extract likely file/symbol keywords from the user's prompt.
    Returns keywords that might match tag names in aOa's intent index.
    """
    # Find potential identifiers (camelCase, snake_case, etc.)
    words = re.findall(r'\b[a-zA-Z_][a-zA-Z0-9_]*\b', prompt.lower())

    # Filter stopwords and very short words
    keywords = [w for w in words if w not in STOPWORDS and len(w) > 2]

    # Also extract file-like patterns
    file_patterns = re.findall(r'[\w\-]+\.(py|js|ts|tsx|md|json|yaml|yml)', prompt.lower())
    for fp in file_patterns:
        name = fp.rsplit('.', 1)[0]
        if name and name not in keywords:
            keywords.append(name)

    # Dedupe while preserving order
    seen = set()
    unique = []
    for k in keywords:
        if k not in seen:
            seen.add(k)
            unique.append(k)

    return unique[:10]


def get_predictions(keywords: list) -> dict:
    """
    Call aOa /predict endpoint with extracted keywords.
    Returns prediction response with files and snippets.
    """
    if not keywords:
        return {'files': []}

    try:
        keyword_str = ','.join(keywords)
        url = f"{AOA_URL}/predict?keywords={keyword_str}&limit={MAX_FILES}&snippet_lines={MAX_SNIPPET_LINES}"
        req = Request(url)
        with urlopen(req, timeout=2) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except (URLError, Exception):
        return {'files': []}


def format_context(files: list, keywords: list) -> str:
    """
    Format predicted files as additionalContext for Claude.
    Includes file paths with confidence and code snippets.
    """
    if not files:
        return ""

    # Get project root for relative paths
    project_root = os.environ.get('CLAUDE_PROJECT_DIR', '/home/corey/aOa')

    def rel_path(path):
        if path.startswith(project_root):
            return path[len(project_root):].lstrip('/')
        return path

    parts = ["## aOa Predicted Files", ""]
    parts.append(f"Based on keywords: {', '.join(keywords[:5])}")
    parts.append("")

    for f in files:
        path = rel_path(f.get('path', ''))
        confidence = f.get('confidence', 0)
        snippet = f.get('snippet', '')

        parts.append(f"### `{path}` ({confidence:.0%} confidence)")
        parts.append("")

        if snippet:
            # Detect language for syntax highlighting
            ext = os.path.splitext(path)[1].lstrip('.')
            lang = ext if ext in ['py', 'js', 'ts', 'tsx', 'json', 'yaml', 'md', 'sh'] else ''
            parts.append(f"```{lang}")
            parts.append(snippet.rstrip())
            parts.append("```")
            parts.append("")

    parts.append("*Consider these files if relevant to your task.*")
    return "\n".join(parts)


def log_prediction(session_id: str, project_id: str, files: list, keywords: list):
    """Log prediction for hit/miss tracking and intent display."""
    if not files:
        return

    file_paths = [f.get('path', '') for f in files]
    avg_confidence = sum(f.get('confidence', 0) for f in files) / len(files) if files else 0

    # Log to /predict/log for hit/miss tracking
    try:
        payload = json.dumps({
            'session_id': session_id,
            'predicted_files': file_paths,
            'tags': keywords[:5],
            'trigger_file': 'UserPromptSubmit',
            'confidence': avg_confidence
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

    # Record as Predict intent for aoa intent display
    try:
        intent_payload = json.dumps({
            'session_id': session_id,
            'project_id': project_id,
            'tool': 'Predict',
            'files': file_paths[:5],  # Limit to 5 files
            'tags': [f"#{k}" for k in keywords[:3]] + [f"@{avg_confidence:.0%}"]
        }).encode('utf-8')

        req = Request(
            f"{AOA_URL}/intent",
            data=intent_payload,
            headers={"Content-Type": "application/json"},
            method="POST"
        )
        urlopen(req, timeout=1)
    except (URLError, Exception):
        pass  # Fire and forget


def main():
    try:
        data = json.load(sys.stdin)
    except (json.JSONDecodeError, Exception):
        sys.exit(0)

    # Check if we have enough data for meaningful predictions
    if get_intent_count() < MIN_INTENTS:
        sys.exit(0)

    # Extract info from hook input
    prompt = data.get('prompt', '')
    session_id = data.get('session_id', 'unknown')

    if not prompt:
        sys.exit(0)

    # Extract keywords from prompt
    keywords = extract_keywords(prompt)
    if not keywords:
        sys.exit(0)

    # Get predictions from aOa
    predictions = get_predictions(keywords)
    files = predictions.get('files', [])

    if not files:
        sys.exit(0)

    # Format context for Claude
    context = format_context(files, keywords)

    if context:
        # Log prediction for hit/miss tracking and intent display
        log_prediction(session_id, PROJECT_ID, files, keywords)

        # Output structured JSON for Claude Code
        output = {
            "hookSpecificOutput": {
                "hookEventName": "UserPromptSubmit",
                "additionalContext": context
            }
        }
        print(json.dumps(output))

    sys.exit(0)


if __name__ == "__main__":
    main()
