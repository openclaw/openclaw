#!/usr/bin/env python3
import json
import os
import sqlite3
import subprocess
import sys
from datetime import datetime, timedelta

_DEFAULT_WORKSPACE = os.path.join(
    os.path.expanduser("~"), ".openclaw", "workspace", "email-ingest-integration"
)
WORKSPACE_DIR = os.environ.get("EMAIL_TRIAGE_WORKSPACE", _DEFAULT_WORKSPACE)
VENV_PYTHON = os.path.join(WORKSPACE_DIR, "venv", "bin", "python3")
DB_PATH = os.path.join(WORKSPACE_DIR, "data", "email_ingest.sqlite")
STATE_PATH = os.environ.get(
    "EMAIL_TRIAGE_STATE",
    os.path.join(
        os.path.expanduser("~"), ".openclaw", "workspace", "memory", "email_triage_state.json"
    ),
)


_DEFAULT_STATE = {"cursor": {"last_ingested_id": 0}, "pending_attention": []}


def get_state():
    if os.path.exists(STATE_PATH):
        try:
            with open(STATE_PATH, "r") as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            return dict(_DEFAULT_STATE, pending_attention=[])
    return dict(_DEFAULT_STATE, pending_attention=[])


def save_state(state):
    parent = os.path.dirname(STATE_PATH)
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(STATE_PATH, "w") as f:
        json.dump(state, f, indent=2)


def check_db_initialized():
    if not os.path.exists(DB_PATH):
        return False
    conn = None
    try:
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()
        cursor.execute("SELECT COUNT(*) FROM email_accounts")
        count = cursor.fetchone()[0]
        return count > 0
    except (sqlite3.Error, OSError):
        return False
    finally:
        if conn is not None:
            conn.close()


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
        str(state["cursor"]["last_ingested_id"]),
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
    for email in new_emails:
        if not any(item["id"] == email["id"] for item in state["pending_attention"]):
            state["pending_attention"].append(
                {
                    "id": email["id"],
                    "subject": email["subject"],
                    "priority": email["priority"],
                    "sender": email["sender"],
                    "summary": email.get("summary", ""),
                    "status": "pending",
                }
            )

    if data.get("meta", {}).get("max_id"):
        state["cursor"]["last_ingested_id"] = data["meta"]["max_id"]

    save_state(state)
    print(f"Sync complete. Found {len(new_emails)} new emails.")


def pending():
    state = get_state()
    items = [item for item in state["pending_attention"] if item.get("status") == "pending"]
    print(json.dumps(items, indent=2))


def dismiss(email_id):
    try:
        email_id = int(email_id)
    except (ValueError, TypeError):
        return False
    state = get_state()
    original_len = len(state["pending_attention"])
    state["pending_attention"] = [
        item for item in state["pending_attention"] if item["id"] != email_id
    ]
    if len(state["pending_attention"]) < original_len:
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
