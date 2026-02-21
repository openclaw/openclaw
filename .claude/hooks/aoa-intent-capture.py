#!/usr/bin/env python3
"""
aOa Intent Capture - PostToolUse Hook

Captures tool usage and records intent to aOa.
Fire-and-forget, non-blocking, <10ms.
"""

import sys
import json
import re
import os
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import URLError
from datetime import datetime

AOA_URL = os.environ.get("AOA_URL", "http://localhost:8080")
# Find AOA data directory
# Option 1: Check for .aoa/home.json in project root (created by aoa init)
# Option 2: Use env var
# Option 3: Default to /tmp for isolated projects
HOOK_DIR = Path(__file__).parent
PROJECT_ROOT = HOOK_DIR.parent.parent  # .claude/hooks/ -> .claude/ -> project/
AOA_HOME_FILE = PROJECT_ROOT / ".aoa" / "home.json"

if AOA_HOME_FILE.exists():
    # Read config from home.json
    _config = json.loads(AOA_HOME_FILE.read_text())
    PROJECT_ID = _config.get("project_id", "")  # UUID from aoa init
else:
    PROJECT_ID = ""

# Session ID fallback (overridden by Claude's session_id from stdin)
DEFAULT_SESSION_ID = os.environ.get("AOA_SESSION_ID", datetime.now().strftime("%Y%m%d"))

# Intent patterns: (regex, [tags])
INTENT_PATTERNS = [
    (r'auth|login|session|oauth|jwt|password', ['#authentication', '#security']),
    (r'test[s]?[/_]|_test\.|\bspec[s]?\b|pytest|unittest', ['#testing']),
    (r'config|settings|\.env|\.yaml|\.yml|\.json', ['#configuration']),
    (r'api|endpoint|route|handler|controller', ['#api']),
    (r'index|search|query|grep|find', ['#search']),
    (r'model|schema|entity|db|database|migration|sql', ['#data']),
    (r'component|view|template|page|ui|style|css|html', ['#frontend']),
    (r'deploy|docker|k8s|ci|cd|pipeline|github', ['#devops']),
    (r'error|exception|catch|throw|raise|fail', ['#errors']),
    (r'log|debug|trace|print|console', ['#logging']),
    (r'cache|redis|memory|store', ['#caching']),
    (r'async|await|promise|thread|concurrent', ['#async']),
    (r'hook|plugin|extension|middleware', ['#hooks']),
    (r'doc|readme|comment|docstring', ['#documentation']),
    (r'util|helper|common|shared|lib', ['#utilities']),
]

# Tool action tags
TOOL_TAGS = {
    'Read': '#reading',
    'Edit': '#editing',
    'Write': '#creating',
    'Bash': '#executing',
    'Grep': '#searching',
    'Glob': '#searching',
    'Task': '#delegating',
}


def extract_files(data: dict) -> tuple:
    """Extract file paths and search tags from tool input/output.

    Returns:
        tuple: (list of files, list of search-derived tags)
    """
    files = set()
    search_tags = set()  # Tags derived from search results
    tool_input = data.get('tool_input', {})

    # Common field names for file paths
    for key in ['file_path', 'path', 'file', 'notebook_path']:
        if key in tool_input:
            val = tool_input[key]
            if val and isinstance(val, str):
                # Check for offset/limit (partial read) and append line range
                offset = tool_input.get('offset')
                limit = tool_input.get('limit')
                if offset is not None and limit is not None:
                    # Show line range: file.py:100-150
                    files.add(f"{val}:{offset}-{offset + limit}")
                elif offset is not None:
                    # Show starting line: file.py:100+
                    files.add(f"{val}:{offset}+")
                else:
                    files.add(val)

    # Array of paths
    if 'paths' in data.get('tool_input', {}):
        for p in data['tool_input']['paths']:
            if p and isinstance(p, str):
                files.add(p)

    # Extract paths from bash commands
    if 'command' in data.get('tool_input', {}):
        cmd = data['tool_input']['command']

        # Detect aOa commands (grep, egrep, find, tree, locate, etc.)
        # Match 'aoa cmd' anywhere - handles bare command or full path
        # Primary: grep, egrep, find, tree, locate, head, tail, lines, hot, touched, focus, predict, outline
        # Deprecated: search, multi, pattern (aliased to grep/egrep)
        # Use findall to get ALL matches, then take the LAST one (skip echo text)
        aoa_matches = re.findall(r'\baoa\s+(grep|egrep|find|tree|locate|head|tail|lines|hot|touched|focus|predict|outline|search|multi|pattern)(?:\s+(-[a-z]))?(?:\s+(.+?))?(?:\s*$|\s*\||\s*&&|\s*;|\s*2>)', cmd)
        if aoa_matches:
            # Take the last match (real command, not echo text)
            match = aoa_matches[-1]
            aoa_cmd = match[0]  # grep, egrep, find, etc.
            aoa_flag = match[1] if match[1] else ""  # -a, -i, etc.
            aoa_term = (match[2] or "").strip().strip('"\'')[:40]  # Limit term length
            # Build full command display: "aoa grep -a term"
            full_cmd = f"aoa {aoa_cmd}"
            if aoa_flag:
                full_cmd += f" {aoa_flag}"
            if aoa_term:
                full_cmd += f" {aoa_term}"
            # Escape colons in full command to preserve our delimiter format
            full_cmd_safe = full_cmd.replace(':', '\\:')

            # Try to extract hit count from tool_response
            response = data.get('tool_response', '')
            # Handle both string and dict responses
            if isinstance(response, dict):
                response = response.get('stdout', response.get('output', str(response)))

            hits = "0"
            time_ms = "0"
            if isinstance(response, str):
                # Strip ANSI color codes before matching
                response_clean = re.sub(r'\x1b\[[0-9;]*m', '', response)
                # Match "N hits │ Xms" format (search/multi)
                hit_match = re.search(r'(\d+)\s*hits?\s*[│|]\s*([\d.]+)(?:ms)?', response_clean)
                if hit_match:
                    hits = hit_match.group(1)
                    time_ms = hit_match.group(2)
                else:
                    # Match pattern search format: "N files, M matched, Xms"
                    pattern_match = re.search(r'(\d+)\s*matched,\s*([\d.]+)(?:ms)?', response_clean)
                    if pattern_match:
                        hits = pattern_match.group(1)
                        time_ms = pattern_match.group(2)

            files.add(f"cmd:aoa:{aoa_cmd}:{full_cmd_safe}:{hits}:{time_ms}")

            # Extract result files from aOa output and associate with search intent
            # This creates meaningful file clusters for prediction
            if isinstance(response, str) and int(hits) > 0:
                # Parse file:line format from aOa output (e.g., "  services/index/indexer.py:123")
                result_files = re.findall(r'^\s+([\w\-_./]+\.(?:py|js|ts|tsx|jsx|go|rs|java|cpp|c|h|md|json|yaml|yml|sh|sql)):\d+', response_clean, re.MULTILINE)
                # Deduplicate and limit to avoid flooding
                unique_results = list(dict.fromkeys(result_files))[:20]
                for result_file in unique_results:
                    files.add(result_file)
                # Add search term as a tag for these files (creates intent cluster)
                if aoa_term and unique_results:
                    # Clean term for use as tag
                    clean_tag = re.sub(r'[^a-zA-Z0-9_-]', '', aoa_term.split()[0] if ' ' in aoa_term else aoa_term)[:20]
                    if clean_tag:
                        search_tags.add(f"#{clean_tag}")

        # Match file paths in command - require at least one directory component
        # and extension must be at word boundary (not .claude matching .c)
        matches = re.findall(r'/[\w\-_]+(?:/[\w.\-_]+)+\.(?:py|js|ts|tsx|jsx|go|rs|java|cpp|c|h|md|json|yaml|yml|sh|sql)\b', cmd)
        # Filter out paths that are too short or look like partial matches
        for m in matches:
            if len(m) > 5 and '/' in m[1:]:  # Must have real path structure
                files.add(m)

    # Extract from grep/glob patterns
    if 'pattern' in data.get('tool_input', {}):
        pattern = data['tool_input']['pattern']
        # If it looks like a path pattern, note it
        if '/' in pattern or '*' in pattern:
            files.add(f"pattern:{pattern}")

    return list(files)[:20], list(search_tags)  # Limit to 20 files, return search tags


def infer_tags(files: list, tool: str) -> list:
    """Infer intent tags from file paths and tool."""
    tags = set()

    # Add tool action tag
    if tool in TOOL_TAGS:
        tags.add(TOOL_TAGS[tool])

    # Match files against patterns
    combined = ' '.join(files).lower()
    for pattern, pattern_tags in INTENT_PATTERNS:
        if re.search(pattern, combined, re.IGNORECASE):
            tags.update(pattern_tags)

    # Language tags based on extension
    for f in files:
        if f.endswith('.py'):
            tags.add('#python')
        elif f.endswith(('.js', '.ts', '.tsx', '.jsx')):
            tags.add('#javascript')
        elif f.endswith('.go'):
            tags.add('#go')
        elif f.endswith('.rs'):
            tags.add('#rust')
        elif f.endswith(('.c', '.cpp', '.h')):
            tags.add('#cpp')
        elif f.endswith('.java'):
            tags.add('#java')
        elif f.endswith('.sh'):
            tags.add('#shell')
        elif f.endswith('.sql'):
            tags.add('#sql')
        elif f.endswith('.md'):
            tags.add('#markdown')

        # Path-based tags for common directories
        f_lower = f.lower()
        if '/cli/' in f_lower or f_lower.endswith('/cli') or '/bin/' in f_lower:
            tags.add('#cli')
        if '/hooks/' in f_lower:
            tags.add('#hooks')
        if '/services/' in f_lower or '/service/' in f_lower:
            tags.add('#services')
        if '/api/' in f_lower or '/endpoint' in f_lower:
            tags.add('#api')
        if '/index' in f_lower or 'indexer' in f_lower:
            tags.add('#indexing')
        if '.context/' in f_lower or '/context/' in f_lower:
            tags.add('#context')
        if '/agents/' in f_lower or '/agent/' in f_lower:
            tags.add('#agents')
        if '/skills/' in f_lower or '/skill/' in f_lower:
            tags.add('#skills')
        if '/plugin/' in f_lower or '/plugins/' in f_lower:
            tags.add('#plugins')

    return list(tags)


def check_prediction_hit(session_id: str, file_path: str):
    """Check if this file access was predicted (QW-3: Phase 2)."""
    if not file_path or file_path.startswith('pattern:'):
        return

    try:
        payload = json.dumps({
            'session_id': session_id,
            'project_id': PROJECT_ID,
            'file': file_path
        }).encode('utf-8')

        req = Request(
            f"{AOA_URL}/predict/check",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST"
        )
        urlopen(req, timeout=1)
    except (URLError, Exception):
        pass  # Fire and forget


def get_file_sizes(files: list) -> dict:
    """Get file sizes for baseline token calculation.

    Uses filesystem stat (fast, always works for readable files).
    """
    file_sizes = {}

    for file_path in files:
        # Skip patterns and non-file paths
        if file_path.startswith('pattern:') or file_path.startswith('cmd:'):
            continue
        if not file_path.startswith('/'):
            continue

        # Strip line range suffix if present (e.g., /path/file.py:100-120)
        actual_path = file_path.split(':')[0] if ':' in file_path else file_path

        try:
            stat_result = os.stat(actual_path)
            file_sizes[file_path] = stat_result.st_size  # Keep original key with line range
        except OSError:
            pass  # File might not exist or be inaccessible

    return file_sizes


def get_output_size(data: dict) -> int:
    """Extract actual output size from tool_response.

    This is the REAL token savings measurement - what Claude actually received.
    Returns size in bytes, or 0 if not available.
    """
    tool_response = data.get('tool_response', {})
    if not tool_response:
        return 0

    # tool_response can be a dict or a string
    if isinstance(tool_response, str):
        return len(tool_response)

    # For Read tool, the response typically has 'content' field
    if 'content' in tool_response:
        content = tool_response['content']
        if isinstance(content, str):
            return len(content)
        return len(str(content))

    # For other tools, serialize the whole response
    try:
        return len(json.dumps(tool_response))
    except (TypeError, ValueError):
        return 0


def send_intent(tool: str, files: list, tags: list, session_id: str,
                tool_use_id: str = None, output_size: int = 0):
    """Send intent to aOa (fire-and-forget)."""
    if not files and not tags:
        return  # Only skip if BOTH are empty

    # Check if this file was predicted (QW-3: Phase 2 hit/miss tracking)
    # Only check for Read operations - those are what we're trying to predict
    if tool == 'Read':
        for file_path in files:
            check_prediction_hit(session_id, file_path)

    # Get file sizes for baseline token calculation
    file_sizes = get_file_sizes(files)

    payload = json.dumps({
        "session_id": session_id,
        "project_id": PROJECT_ID,  # UUID for per-project isolation
        "tool": tool,
        "files": files,
        "tags": tags,
        "tool_use_id": tool_use_id,  # Claude's correlation key
        "file_sizes": file_sizes,  # For baseline token estimation
        "output_size": output_size,  # REAL actual output size in bytes
    }).encode('utf-8')

    try:
        req = Request(
            f"{AOA_URL}/intent",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST"
        )
        urlopen(req, timeout=2)
    except (URLError, Exception):
        pass  # Graceful failure - never block Claude

    # Record file accesses for ranking (Phase 1)
    # Strip # from tags for scoring
    score_tags = [t.lstrip('#') for t in tags]
    for file_path in files:
        # Skip pattern entries and non-file paths
        if file_path.startswith('pattern:') or not file_path.startswith('/'):
            continue
        try:
            score_payload = json.dumps({
                "project_id": PROJECT_ID,
                "file": file_path,
                "tags": score_tags,
            }).encode('utf-8')
            req = Request(
                f"{AOA_URL}/rank/record",
                data=score_payload,
                headers={"Content-Type": "application/json"},
                method="POST"
            )
            urlopen(req, timeout=1)
        except (URLError, Exception):
            pass  # Never block


def main():
    # Debug mode: AOA_DEBUG=1 python3 intent-capture.py
    debug = os.environ.get("AOA_DEBUG", "0") == "1"

    try:
        raw = sys.stdin.read()
        data = json.loads(raw)
    except (json.JSONDecodeError, Exception) as e:
        if debug:
            print(f"[aOa] JSON parse error: {e}", file=sys.stderr)
        return

    if debug:
        print(f"[aOa] Input: {json.dumps(data, indent=2)}", file=sys.stderr)

    # Extract Claude's correlation keys (QW-1: Phase 2 session linkage)
    session_id = data.get('session_id', DEFAULT_SESSION_ID)
    tool_use_id = data.get('tool_use_id')  # Claude's toolu_xxx ID

    tool = data.get('tool_name', data.get('tool', 'unknown'))
    files, search_tags = extract_files(data)
    tags = infer_tags(files, tool)
    tags.extend(search_tags)  # Merge search-derived tags

    # Extract REAL output size from tool_response (Phase 2: honest metrics)
    output_size = get_output_size(data)

    if debug:
        print(f"[aOa] Session: {session_id}, Tool: {tool}, Files: {files}, Tags: {tags}, Output: {output_size}B", file=sys.stderr)

    send_intent(tool, files, tags, session_id, tool_use_id, output_size)


if __name__ == "__main__":
    main()
