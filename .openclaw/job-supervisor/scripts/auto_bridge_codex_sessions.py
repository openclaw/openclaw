#!/usr/bin/env python3
import argparse
import json
import subprocess
import sys
from pathlib import Path

from supervisor_utils import print_json


DEFAULT_SUPERVISOR_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SESSION_REGISTRY = Path("/home/mertb/.openclaw/agents/codex/sessions/sessions.json")
DEFAULT_STATE_FILE = DEFAULT_SUPERVISOR_ROOT / "state" / "auto-bridge-codex-state.json"


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def load_state(path: Path) -> dict:
    if not path.exists():
        return {"processedSessions": {}}
    return load_json(path)


def save_state(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def run_python(script: Path, args: list[str]) -> tuple[int, str, str]:
    completed = subprocess.run(
        [sys.executable, str(script), *args],
        check=False,
        capture_output=True,
        text=True,
    )
    return completed.returncode, completed.stdout.strip(), completed.stderr.strip()


def should_bridge(session_key: str, session_entry: dict, state: dict, *, include_backlog: bool) -> bool:
    if session_entry.get("status") != "done":
        return False
    session_file = session_entry.get("sessionFile")
    if not session_file:
        return False
    processed = state.get("processedSessions", {}).get(session_key)
    marker = {
        "endedAt": session_entry.get("endedAt"),
        "sessionFile": session_file,
        "status": session_entry.get("status"),
    }
    if processed == marker:
        return False
    if include_backlog:
        return True
    initialized_at = state.get("initializedAt")
    ended_at = session_entry.get("endedAt")
    if initialized_at is None or ended_at is None:
        return False
    return ended_at >= initialized_at


def auto_bridge(session_registry: Path, supervisor_root: Path, state_file: Path, *, dry_run: bool = False, include_backlog: bool = False) -> tuple[int, dict]:
    registry = load_json(session_registry)
    state = load_state(state_file)
    processed_sessions = state.setdefault("processedSessions", {})
    if "initializedAt" not in state:
        newest_ended_at = max(
            (entry.get("endedAt") or 0) for entry in registry.values() if isinstance(entry, dict)
        )
        state["initializedAt"] = newest_ended_at

    bridge_script = supervisor_root / "scripts" / "bridge_codex_session_to_result.py"
    dispatch_script = supervisor_root / "scripts" / "dispatch_raw_result.py"
    consume_script = supervisor_root / "scripts" / "consume_notifications.py"

    notifications_dir = supervisor_root / "state" / "notifications"
    notifications_archive_dir = supervisor_root / "state" / "notifications-archive"
    raw_archive_dir = supervisor_root / "state" / "raw-results-archive"
    raw_error_dir = supervisor_root / "state" / "raw-results-error"
    supervisor_state_file = supervisor_root / "state" / "supervisor-state.json"

    bridged = []
    for session_key, session_entry in sorted(registry.items()):
        if not should_bridge(session_key, session_entry, state, include_backlog=include_backlog):
            continue

        session_result = {
            "sessionKey": session_key,
            "endedAt": session_entry.get("endedAt"),
            "sessionFile": session_entry.get("sessionFile"),
        }

        if dry_run:
            session_result["dryRun"] = True
            bridged.append(session_result)
            continue

        bridge_code, bridge_out, bridge_err = run_python(bridge_script, ["--session-key", session_key])
        session_result["bridge"] = {
            "code": bridge_code,
            "stdout": bridge_out,
            "stderr": bridge_err,
        }
        if bridge_code != 0:
            bridged.append(session_result)
            continue

        raw_result_path = bridge_out.splitlines()[-1].strip()
        dispatch_code, dispatch_out, dispatch_err = run_python(
            dispatch_script,
            [
                "--raw-result-file",
                raw_result_path,
                "--state-file",
                str(supervisor_state_file),
                "--notifications-dir",
                str(notifications_dir),
                "--archive-dir",
                str(raw_archive_dir),
                "--error-dir",
                str(raw_error_dir),
            ],
        )
        session_result["dispatch"] = {
            "code": dispatch_code,
            "stdout": dispatch_out,
            "stderr": dispatch_err,
        }
        if dispatch_code not in (0, 3):
            bridged.append(session_result)
            continue

        consume_code, consume_out, consume_err = run_python(
            consume_script,
            [
                "--notifications-dir",
                str(notifications_dir),
                "--archive-dir",
                str(notifications_archive_dir),
            ],
        )
        session_result["consume"] = {
            "code": consume_code,
            "stdout": consume_out,
            "stderr": consume_err,
        }
        if consume_code != 0:
            bridged.append(session_result)
            continue

        processed_sessions[session_key] = {
            "endedAt": session_entry.get("endedAt"),
            "sessionFile": session_entry.get("sessionFile"),
            "status": session_entry.get("status"),
        }
        bridged.append(session_result)

    if not dry_run:
        save_state(state_file, state)

    return 0, {"processedCount": len(bridged), "results": bridged, "stateFile": str(state_file)}


def main() -> int:
    parser = argparse.ArgumentParser(description="Minimal automation: bridge finished Codex ACP sessions into job-supervisor raw results and notifications.")
    parser.add_argument("--session-registry", default=str(DEFAULT_SESSION_REGISTRY))
    parser.add_argument("--supervisor-root", default=str(DEFAULT_SUPERVISOR_ROOT))
    parser.add_argument("--state-file", default=str(DEFAULT_STATE_FILE))
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--include-backlog", action="store_true", help="Also process older finished sessions that ended before this automation was initialized.")
    args = parser.parse_args()

    code, payload = auto_bridge(
        Path(args.session_registry),
        Path(args.supervisor_root),
        Path(args.state_file),
        dry_run=args.dry_run,
        include_backlog=args.include_backlog,
    )
    print_json(payload)
    return code


if __name__ == "__main__":
    sys.exit(main())
