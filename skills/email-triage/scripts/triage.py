#!/usr/bin/env python3
import json
import os
import subprocess
import sys
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta
from typing import Any, Optional

_DEFAULT_WORKSPACE = os.path.join(
    os.path.expanduser("~"), ".openclaw", "workspace", "email-ingest-integration"
)
WORKSPACE_DIR = os.environ.get("EMAIL_TRIAGE_WORKSPACE", _DEFAULT_WORKSPACE)
VENV_PYTHON = os.environ.get(
    "EMAIL_TRIAGE_VENV_PYTHON",
    os.path.join(WORKSPACE_DIR, "venv", "bin", "python3"),
)
STATE_PATH = os.environ.get(
    "EMAIL_TRIAGE_STATE",
    os.path.join(
        os.path.expanduser("~"), ".openclaw", "workspace", "memory", "email_triage_state.json"
    ),
)

# Priority levels: higher number = more urgent. Emails with level >= HIGH are enqueued.
_PRIORITY_LEVELS = {
    "low": 1,
    "normal": 2,
    "medium": 2,
    "high": 3,
    "urgent": 4,
    "critical": 5,
}
_HIGH_THRESHOLD = _PRIORITY_LEVELS["high"]


def _is_high_priority(priority):
    """Return True if *priority* (string or numeric) is >= High."""
    if isinstance(priority, (int, float)):
        return priority >= _HIGH_THRESHOLD
    return _PRIORITY_LEVELS.get(str(priority).lower(), 0) >= _HIGH_THRESHOLD


@dataclass
class Cursor:
    last_ingested_id: int = 0

    @classmethod
    def from_dict(cls, data: Any) -> "Cursor":
        if not isinstance(data, dict):
            return cls()
        raw = data.get("last_ingested_id", 0)
        try:
            return cls(last_ingested_id=int(raw))
        except (TypeError, ValueError):
            return cls()


@dataclass
class PendingItem:
    id: str
    subject: str = ""
    sender: str = ""
    priority: str = ""
    summary: str = ""
    status: str = "pending"

    @classmethod
    def from_dict(cls, data: Any) -> Optional["PendingItem"]:
        """Parse a dict into a PendingItem. Returns None if shape is invalid.

        id is coerced to str so that dismiss() matches regardless of whether
        the upstream source stores int or str IDs.
        """
        if not isinstance(data, dict):
            return None
        if "id" not in data or data["id"] is None:
            return None
        return cls(
            id=str(data["id"]),
            subject=str(data.get("subject", "")),
            sender=str(data.get("sender", "")),
            priority=str(data.get("priority", "")),
            summary=str(data.get("summary", "")),
            status=str(data.get("status", "pending")),
        )


@dataclass
class State:
    cursor: Cursor = field(default_factory=Cursor)
    pending_attention: list = field(default_factory=list)

    @classmethod
    def from_dict(cls, data: Any) -> "State":
        if not isinstance(data, dict):
            return cls()
        cursor = Cursor.from_dict(data.get("cursor", {}))
        raw_pending = data.get("pending_attention", [])
        if not isinstance(raw_pending, list):
            return cls(cursor=cursor)
        items = [
            item
            for item in (PendingItem.from_dict(p) for p in raw_pending)
            if item is not None
        ]
        return cls(cursor=cursor, pending_attention=items)

    def to_dict(self) -> dict:
        return asdict(self)


def get_state() -> State:
    if not os.path.exists(STATE_PATH):
        return State()
    try:
        with open(STATE_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (json.JSONDecodeError, OSError):
        return State()
    return State.from_dict(data)


def save_state(state: State) -> None:
    parent = os.path.dirname(STATE_PATH)
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(STATE_PATH, "w", encoding="utf-8") as f:
        json.dump(state.to_dict(), f, indent=2, ensure_ascii=False)


def check_db_initialized():
    """Return True if the upstream ingest has at least one recorded account
    cursor, i.e. we are NOT on a first run and should NOT pass
    ``--init-start-date``.

    Shells out to ``main.py status --format json`` (added in
    Anthrop-OS/email-ingest#18) so this skill never touches the upstream
    SQLite file directly. Any failure — missing workspace, unreachable
    DB, invalid JSON, non-zero exit — is treated as "not initialized"
    so that ``sync()`` falls back to passing ``--init-start-date`` and
    the upstream's own avalanche-protection error path takes over.
    """
    cmd = [VENV_PYTHON, "main.py", "status", "--format", "json"]
    try:
        result = subprocess.run(
            cmd, cwd=WORKSPACE_DIR, capture_output=True, text=True, timeout=30
        )
    except (subprocess.TimeoutExpired, OSError):
        return False
    if result.returncode != 0:
        return False
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError:
        return False
    return bool(payload.get("initialized"))


def sync():
    cmd = [VENV_PYTHON, "main.py", "ingest", "--format", "json"]

    if not check_db_initialized():
        yesterday = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")
        cmd.extend(["--init-start-date", yesterday])

    try:
        result = subprocess.run(
            cmd, cwd=WORKSPACE_DIR, capture_output=True, text=True, timeout=300
        )
    except subprocess.TimeoutExpired:
        print("Sync timed out after 300 seconds.")
        return
    except OSError as exc:
        print(f"Sync failed to start: {exc}")
        return
    if result.returncode != 0:
        print(f"Sync failed: {result.stderr}")
        return

    state = get_state()
    query_cmd = [
        VENV_PYTHON,
        "main.py",
        "query",
        "--after-id",
        str(state.cursor.last_ingested_id),
        "--format",
        "json",
    ]
    try:
        query_result = subprocess.run(
            query_cmd, cwd=WORKSPACE_DIR, capture_output=True, text=True, timeout=300
        )
    except subprocess.TimeoutExpired:
        print("Query timed out after 300 seconds.")
        return
    except OSError as exc:
        print(f"Query failed to start: {exc}")
        return

    if query_result.returncode != 0:
        print(f"Query failed: {query_result.stderr}")
        return

    try:
        data = json.loads(query_result.stdout)
    except json.JSONDecodeError as exc:
        print(f"Failed to parse query output: {exc}")
        return

    new_emails = data.get("results", [])
    if not isinstance(new_emails, list):
        new_emails = []

    enqueued = 0
    existing_ids = {item.id for item in state.pending_attention}
    for raw_email in new_emails:
        if not isinstance(raw_email, dict):
            continue
        if not _is_high_priority(raw_email.get("priority", "")):
            continue
        item = PendingItem.from_dict(raw_email)
        if item is None:
            continue
        if item.id in existing_ids:
            continue
        state.pending_attention.append(item)
        existing_ids.add(item.id)
        enqueued += 1

    meta = data.get("meta")
    if isinstance(meta, dict):
        max_id = meta.get("max_id")
        if max_id is not None:
            try:
                state.cursor.last_ingested_id = int(max_id)
            except (TypeError, ValueError):
                pass

    save_state(state)
    print(
        f"Sync complete. Found {len(new_emails)} new email(s), "
        f"enqueued {enqueued} high-priority."
    )


def pending():
    state = get_state()
    items = [asdict(item) for item in state.pending_attention if item.status == "pending"]
    print(json.dumps(items, indent=2))


def dismiss(email_id):
    target = str(email_id) if email_id is not None else ""
    if not target:
        return False
    state = get_state()
    original_len = len(state.pending_attention)
    state.pending_attention = [
        item for item in state.pending_attention if item.id != target
    ]
    if len(state.pending_attention) < original_len:
        save_state(state)
        return True
    return False


if __name__ == "__main__":
    if len(sys.argv) > 1:
        if sys.argv[1] == "sync":
            sync()
        elif sys.argv[1] == "pending":
            pending()
        elif sys.argv[1] == "dismiss" and len(sys.argv) > 2:
            if dismiss(sys.argv[2]):
                print(f"Email {sys.argv[2]} dismissed.")
            else:
                print(f"Email {sys.argv[2]} not found.")
