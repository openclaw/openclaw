#!/usr/bin/env python3
"""
checkpoint_manager.py - SPARSE/FULL checkpoint trigger manager with Circuit Breaker.

Usage:
    python3 checkpoint_manager.py increment
    python3 checkpoint_manager.py check-sparse
    python3 checkpoint_manager.py check-full [--heartbeat]
    python3 checkpoint_manager.py status
    python3 checkpoint_manager.py reset
"""

import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

STATE_FILE = Path(__file__).parent.parent / "state.json"
CHECKPOINT_FILE = Path.home() / ".openclaw/workspace/memory/session-checkpoint.md"

SPARSE_MIN_ROUNDS = 5
SPARSE_MIN_SECONDS = 300  # 5 minutes
MAX_CONSECUTIVE_FAILURES = 3


def load_state() -> dict:
    if STATE_FILE.exists():
        with open(STATE_FILE) as f:
            return json.load(f)
    return {
        "rounds": 0,
        "lastSparseTime": None,
        "lastFullTime": None,
        "consecutiveFailures": 0,
        "degraded": False,
    }


def save_state(state: dict) -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def cmd_increment() -> None:
    state = load_state()
    if state.get("degraded"):
        print("DEGRADED: checkpoint writes suspended. Run 'reset' to recover.")
        return
    state["rounds"] = state.get("rounds", 0) + 1
    save_state(state)
    print(f"rounds={state['rounds']}")


def cmd_check_sparse() -> None:
    state = load_state()
    if state.get("degraded"):
        print("SKIP: degraded mode")
        return
    rounds = state.get("rounds", 0)
    last = state.get("lastSparseTime")
    elapsed = time.time() - (
        datetime.fromisoformat(last).timestamp() if last else 0
    )
    if rounds >= SPARSE_MIN_ROUNDS and elapsed >= SPARSE_MIN_SECONDS:
        _write_checkpoint(state, "SPARSE")
        state["rounds"] = 0
        state["lastSparseTime"] = now_iso()
        save_state(state)
        print("SPARSE checkpoint written")
    else:
        print(
            f"SKIP: rounds={rounds}/{SPARSE_MIN_ROUNDS}, "
            f"elapsed={int(elapsed)}s/{SPARSE_MIN_SECONDS}s"
        )


def cmd_check_full(heartbeat: bool = False) -> None:
    state = load_state()
    if state.get("degraded"):
        print("SKIP: degraded mode")
        return
    _write_checkpoint(state, "FULL" if not heartbeat else "FULL/heartbeat")
    state["lastFullTime"] = now_iso()
    state["rounds"] = 0
    save_state(state)
    print("FULL checkpoint written")


def _write_checkpoint(state: dict, kind: str) -> None:
    try:
        CHECKPOINT_FILE.parent.mkdir(parents=True, exist_ok=True)
        ts = now_iso()
        header = f"\n<!-- checkpoint:{kind} at {ts} -->\n"
        with open(CHECKPOINT_FILE, "a") as f:
            f.write(header)
        state["consecutiveFailures"] = 0
    except Exception as exc:
        failures = state.get("consecutiveFailures", 0) + 1
        state["consecutiveFailures"] = failures
        if failures >= MAX_CONSECUTIVE_FAILURES:
            state["degraded"] = True
            print(f"ERROR: {exc}. Entering degraded mode after {failures} failures.")
        else:
            print(f"ERROR: {exc}. Failure {failures}/{MAX_CONSECUTIVE_FAILURES}.")
        save_state(state)
        raise


def cmd_status() -> None:
    state = load_state()
    print(json.dumps(state, indent=2))


def cmd_reset() -> None:
    state = load_state()
    state["degraded"] = False
    state["consecutiveFailures"] = 0
    save_state(state)
    print("Circuit breaker reset. Checkpoint writes re-enabled.")


def main() -> None:
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        sys.exit(1)
    cmd = args[0]
    if cmd == "increment":
        cmd_increment()
    elif cmd == "check-sparse":
        cmd_check_sparse()
    elif cmd == "check-full":
        cmd_check_full(heartbeat="--heartbeat" in args)
    elif cmd == "status":
        cmd_status()
    elif cmd == "reset":
        cmd_reset()
    else:
        print(f"Unknown command: {cmd}")
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()
