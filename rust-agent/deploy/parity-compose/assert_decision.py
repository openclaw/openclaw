#!/usr/bin/env python3
import json
import os
import time
from pathlib import Path


PARITY_DIR = Path(os.environ.get("PARITY_DIR", "/parity"))
DECISION_PATH = PARITY_DIR / "decision.json"
EXPECTED_REQUEST_ID = os.environ.get("REQUEST_ID", "req-compose-security-1")
EXPECTED_EVENT = os.environ.get("DECISION_EVENT", "security.decision")
TIMEOUT_SECS = float(os.environ.get("ASSERT_TIMEOUT_SECS", "90"))


def wait_for_decision(path: Path, timeout_secs: float) -> dict:
    deadline = time.monotonic() + timeout_secs
    while time.monotonic() < deadline:
        if path.exists():
            text = path.read_text(encoding="utf-8")
            return json.loads(text)
        time.sleep(0.2)
    raise TimeoutError(f"timed out waiting for {path}")


def main() -> int:
    decision_frame = wait_for_decision(DECISION_PATH, TIMEOUT_SECS)
    if decision_frame.get("type") != "event":
        raise RuntimeError("decision frame type was not event")
    if decision_frame.get("event") != EXPECTED_EVENT:
        raise RuntimeError("unexpected decision event name")

    payload = decision_frame.get("payload", {})
    if payload.get("requestId") != EXPECTED_REQUEST_ID:
        raise RuntimeError("unexpected request id in decision payload")

    decision = payload.get("decision", {})
    action = str(decision.get("action", "")).strip().lower()
    if action not in {"review", "block"}:
        raise RuntimeError(f"unexpected decision action: {action!r}")

    reasons = decision.get("reasons", [])
    if not isinstance(reasons, list) or len(reasons) == 0:
        raise RuntimeError("decision reasons were missing")

    print("compose parity assertor passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
