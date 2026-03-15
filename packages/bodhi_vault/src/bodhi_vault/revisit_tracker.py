"""
bodhi_vault.revisit_tracker — Log and query node revisitation events.

Records when vault nodes are accessed (e.g. opened in the viz panel).
Persists to ~/.openclaw/viz/revisit-log.jsonl — one JSON object per line.
Used by energy_model.py to compute cluster energy scores.

Design:
- Append-only log (never rewrites history)
- Atomic per-line: write to temp then rename
- Zero dependencies beyond stdlib
"""

import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional


REVISIT_LOG = Path(os.path.expanduser("~/.openclaw/viz/revisit-log.jsonl"))


def _now_iso() -> str:
    return datetime.now(tz=timezone.utc).isoformat()


def log_revisit(
    node_id: str,
    cluster_id: Optional[str] = None,
    domain: Optional[str] = None,
    log_path: Path = REVISIT_LOG,
) -> None:
    """
    Append one revisit event to the log.

    Args:
        node_id:    ID of the vault node being accessed.
        cluster_id: Cluster the node belongs to (if known).
        domain:     Wellness domain of the node (if known).
        log_path:   Path to the JSONL log file.
    """
    log_path.parent.mkdir(parents=True, exist_ok=True)

    record: dict[str, Any] = {
        "node_id": node_id,
        "at": _now_iso(),
    }
    if cluster_id:
        record["cluster_id"] = cluster_id
    if domain:
        record["domain"] = domain

    line = json.dumps(record, ensure_ascii=False) + "\n"

    # Atomic append via temp file in same directory
    fd, tmp_path = tempfile.mkstemp(dir=log_path.parent, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(line)
        # Append temp content to log then remove temp
        with open(log_path, "a", encoding="utf-8") as log_fh:
            log_fh.write(line)
    finally:
        try:
            os.unlink(tmp_path)
        except FileNotFoundError:
            pass


def load_events(
    log_path: Path = REVISIT_LOG,
    since: Optional[datetime] = None,
) -> list[dict[str, Any]]:
    """
    Load all revisit events from the log.

    Args:
        log_path: Path to the JSONL log file.
        since:    If given, only return events at or after this datetime (UTC).

    Returns:
        List of event dicts, oldest first.
    """
    if not log_path.exists():
        return []

    events: list[dict[str, Any]] = []
    with open(log_path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue

            if since is not None:
                raw_at = event.get("at", "")
                try:
                    event_dt = datetime.fromisoformat(raw_at)
                    # Normalise to UTC for comparison
                    if event_dt.tzinfo is None:
                        event_dt = event_dt.replace(tzinfo=timezone.utc)
                    cmp_since = since if since.tzinfo else since.replace(tzinfo=timezone.utc)
                    if event_dt < cmp_since:
                        continue
                except (ValueError, TypeError):
                    continue

            events.append(event)

    return events


def get_node_revisit_counts(
    log_path: Path = REVISIT_LOG,
    since: Optional[datetime] = None,
) -> dict[str, int]:
    """
    Return {node_id: visit_count} for all logged nodes.

    Args:
        log_path: Path to the JSONL log file.
        since:    If given, count only events at or after this datetime.

    Returns:
        Dict mapping node_id → total visit count.
    """
    counts: dict[str, int] = {}
    for event in load_events(log_path=log_path, since=since):
        node_id = event.get("node_id", "")
        if node_id:
            counts[node_id] = counts.get(node_id, 0) + 1
    return counts


def get_cluster_revisit_counts(
    log_path: Path = REVISIT_LOG,
    since: Optional[datetime] = None,
) -> dict[str, int]:
    """
    Return {cluster_id: visit_count} aggregated from revisit log.

    Only counts events where cluster_id is present in the record.
    """
    counts: dict[str, int] = {}
    for event in load_events(log_path=log_path, since=since):
        cluster_id = event.get("cluster_id", "")
        if cluster_id:
            counts[cluster_id] = counts.get(cluster_id, 0) + 1
    return counts


def get_recent_events(
    n: int = 50,
    log_path: Path = REVISIT_LOG,
) -> list[dict[str, Any]]:
    """Return the n most recent revisit events, newest first."""
    events = load_events(log_path=log_path)
    return list(reversed(events[-n:]))
