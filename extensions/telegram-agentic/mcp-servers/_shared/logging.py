"""AOP-compatible event logging for MCP servers."""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path


def get_log_file() -> Path:
    """Resolve the AOP log file path."""
    return Path(os.environ.get("AOP_LOG_FILE", Path.home() / ".openclaw" / "all.jsonl"))


def emit_event(
    event: str,
    data: dict | None = None,
    session_key: str | None = None,
) -> None:
    """Emit an AOP-compatible event to the log file."""
    entry = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "event": event,
        "source": "mcp-server",
    }
    if session_key:
        entry["sessionKey"] = session_key
    if data:
        entry["data"] = data

    log_file = get_log_file()
    try:
        log_file.parent.mkdir(parents=True, exist_ok=True)
        with open(log_file, "a") as f:
            f.write(json.dumps(entry) + "\n")
    except OSError as e:
        print(f"[warn] Failed to write AOP event: {e}", file=sys.stderr)
