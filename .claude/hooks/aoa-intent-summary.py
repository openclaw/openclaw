#!/usr/bin/env python3
"""
aOa Intent Summary - UserPromptSubmit Hook

Shows branded intent summary when user submits a prompt.
Output: ⚡ aOa 87% │ 877 intents │ 0.1ms │ editing python searching
        ^^^^^^^^
        Accuracy is FIRST - bright and visible
"""

import sys
import json
import os
import time
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import URLError

AOA_URL = os.environ.get("AOA_URL", "http://localhost:8080")

# Get project ID from .aoa/home.json
HOOK_DIR = Path(__file__).parent
PROJECT_ROOT = HOOK_DIR.parent.parent
AOA_HOME_FILE = PROJECT_ROOT / ".aoa" / "home.json"

if AOA_HOME_FILE.exists():
    _config = json.loads(AOA_HOME_FILE.read_text())
    PROJECT_ID = _config.get("project_id", "")
else:
    PROJECT_ID = ""

# ANSI colors - brighter for key metrics
CYAN = "\033[96m"       # Bright cyan for aOa brand
GREEN = "\033[92m"      # Bright green for good accuracy
YELLOW = "\033[93m"     # Bright yellow for tags
RED = "\033[91m"        # Bright red for low accuracy
BOLD = "\033[1m"
DIM = "\033[2m"
RESET = "\033[0m"


def get_intent_stats():
    """Fetch intent stats from aOa."""
    start = time.time()

    try:
        req = Request(f"{AOA_URL}/intent/recent?since=3600&limit=50")
        with urlopen(req, timeout=2) as resp:
            data = json.loads(resp.read().decode('utf-8'))
    except (URLError, Exception):
        return None, 0

    elapsed_ms = (time.time() - start) * 1000
    return data, elapsed_ms


def get_accuracy():
    """Fetch prediction accuracy from aOa metrics."""
    try:
        req = Request(f"{AOA_URL}/metrics")
        with urlopen(req, timeout=1) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            rolling = data.get('rolling', {})
            hit_pct = rolling.get('hit_at_5_pct', 0)
            evaluated = rolling.get('evaluated', 0)
            return hit_pct, evaluated
    except (URLError, Exception):
        return None, 0


def format_accuracy(hit_pct, evaluated):
    """Format accuracy with traffic lights."""
    if evaluated < 2:
        # Learning - grey (neutral, not broken)
        return f"{DIM}⚪{RESET}"
    elif evaluated < 3:
        # Calibrating - yellow light
        return f"{YELLOW}🟡{RESET}"
    else:
        # Ready - traffic light + percentage
        pct = int(hit_pct)
        if pct >= 80:
            return f"{GREEN}🟢 {BOLD}{pct}%{RESET}"
        else:
            # Yellow for anything below 80%
            return f"{YELLOW}🟡 {BOLD}{pct}%{RESET}"


def format_output(data: dict, elapsed_ms: float) -> str:
    """Format the branded output line."""
    stats = data.get('stats', {})
    records = data.get('records', [])

    total = stats.get('total_records', 0)

    # Get recent tags (last few records)
    recent_tags = set()
    for record in records[:10]:
        for tag in record.get('tags', []):
            recent_tags.add(tag.replace('#', ''))

    # Limit to 5 most relevant tags
    tags_str = ' '.join(list(recent_tags)[:5]) if recent_tags else 'calibrating...'

    # Get accuracy - THE KEY METRIC
    hit_pct, evaluated = get_accuracy()
    accuracy_str = format_accuracy(hit_pct, evaluated)

    # Build branded output - ACCURACY FIRST
    parts = [
        f"{CYAN}{BOLD}⚡ aOa{RESET} {accuracy_str}",  # Brand + accuracy together
        f"{total} intents",
        f"{GREEN}{elapsed_ms:.1f}ms{RESET}",
    ]

    header = f" {DIM}│{RESET} ".join(parts)
    tags_display = f"{YELLOW}{tags_str}{RESET}"

    return f"{header} {DIM}│{RESET} {tags_display}"


def get_recent_files(records: list) -> list:
    """Extract unique files from recent records that may need AI tagging."""
    files = set()
    for record in records[:10]:
        for f in record.get('files', []):
            # Must be absolute path, not a pattern, and have a file extension
            if (f.startswith('/') and
                not f.startswith('pattern:') and
                '.' in os.path.basename(f)):  # Has extension = is a file
                files.add(f)
    return list(files)[:5]


def get_pending_outline_files(recent_files: list, project_id: str) -> list:
    """Check which recent files need symbol-level tagging."""
    if not recent_files:
        return []

    try:
        url = f"{AOA_URL}/outline/pending"
        if project_id:
            url += f"?project={project_id}"
        req = Request(url)
        with urlopen(req, timeout=1) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            pending = {p['file'] for p in data.get('pending', [])}
            # Return recent files that are pending outline enrichment
            return [f for f in recent_files if any(f.endswith(p) for p in pending)]
    except Exception:
        return []


def request_haiku_tagging(files: list, prompt: str, session_id: str, project_id: str) -> dict:
    """Build Haiku tagging request as additionalContext."""
    if not files:
        return None

    file_list = ', '.join([os.path.basename(f) for f in files])
    prompt_snippet = prompt[:200] if prompt else "coding session"

    context = f"""## aOa Auto-Tag Request

Generate 3-5 semantic hashtags for these files (YOU are the model - no Task tool):

Files: {file_list}
Context: {prompt_snippet}

Just output tags like: ["#tag1", "#tag2", "#tag3"]

Then store via:
curl -s -X POST localhost:8080/intent -H "Content-Type: application/json" -d '{{"session_id": "{session_id}", "project_id": "{project_id}", "tool": "Intent", "files": {json.dumps(files)}, "tags": YOUR_TAGS}}'
"""

    return {
        "hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": context
        }
    }


def request_outline_enrichment(files: list, project_id: str) -> str:
    """Build outline enrichment request for files needing symbol tags."""
    if not files:
        return ""

    file_list = ', '.join([os.path.basename(f) for f in files])

    return f"""
## aOa Outline Enrichment Request

These files need symbol-level semantic tags (first touch or modified):

Files: {file_list}

For each file, run:
1. `aoa outline <file> --json` to get symbols
2. Spawn Haiku to tag each symbol with 2-3 semantic hashtags
3. Store via: `echo '<enriched json>' | aoa outline --store`

This creates searchable symbol-level tags like:
  function validate_token → #authentication #validation
  class UserSession → #session-management #state
"""


def main():
    # Read stdin for user prompt context
    prompt = ""
    session_id = ""
    try:
        hook_input = json.load(sys.stdin)
        prompt = hook_input.get('prompt', '')
        session_id = hook_input.get('session_id', '')
    except Exception:
        pass

    data, elapsed_ms = get_intent_stats()

    if data is None:
        # aOa not running - silent
        return

    if data.get('stats', {}).get('total_records', 0) == 0:
        # No intents yet - show minimal output
        print(f"{CYAN}{BOLD}⚡ aOa{RESET} {DIM}│{RESET} calibrating... {DIM}(use Claude to build intent){RESET}")
        return

    # Print status line to stderr (visible to user)
    output = format_output(data, elapsed_ms)
    print(output)

    # Request Haiku tagging for recent files (stdout JSON for Claude)
    records = data.get('records', [])
    recent_files = get_recent_files(records)
    if recent_files and prompt:
        # File-level tagging (always)
        haiku_request = request_haiku_tagging(recent_files, prompt, session_id, PROJECT_ID)

        # Symbol-level tagging (only if pending)
        pending_outline = get_pending_outline_files(recent_files, PROJECT_ID)
        outline_request = request_outline_enrichment(pending_outline, PROJECT_ID)

        if haiku_request:
            # Append outline request to additionalContext if needed
            if outline_request:
                haiku_request["hookSpecificOutput"]["additionalContext"] += outline_request
            print(json.dumps(haiku_request))


if __name__ == "__main__":
    main()
