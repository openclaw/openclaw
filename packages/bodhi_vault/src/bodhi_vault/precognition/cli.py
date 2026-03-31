"""
bodhi_vault.precognition.cli — CLI entry point for the pre-cognition pipeline.

Called by the bodhi-precognition OpenClaw hook on every message:preprocessed event.

Usage (from hook handler):
    BODHI_MSG_BODY="<message text>" \
    BODHI_MSG_TIMESTAMP="2026-03-30T14:30:00+00:00" \
    BODHI_MSG_CHANNEL="telegram" \
    python3 -m bodhi_vault.precognition.cli

Exit codes:
    0  — OK (any non-crisis tier)
    1  — CRISIS (RED tier, emergency_flag set)
    2  — Error (pipeline failed, hook should log and continue)

Stdout:
    "OK:green"   — green tier, no action needed
    "OK:yellow"  — yellow tier, Bo will co-regulate
    "OK:orange"  — orange tier, somatic-only response
    "CRISIS:red" — red tier, emergency_flag active

The hook reads stdout. If "CRISIS:red", the hook can push an emergency
notification to context.messages before the agent sees the message.

Design:
- Always exits, never hangs
- Never writes to vault (only somatic-state.json and history)
- Completes in <100ms for any input
- Errors are printed to stderr and exit code 2 is returned
"""

from __future__ import annotations

import os
import sys
from datetime import datetime, timezone


def main() -> int:
    try:
        text = os.environ.get("BODHI_MSG_BODY", "")
        raw_ts = os.environ.get("BODHI_MSG_TIMESTAMP", "")
        channel = os.environ.get("BODHI_MSG_CHANNEL", "telegram")

        # Parse timestamp or fall back to now
        timestamp: datetime
        if raw_ts:
            try:
                timestamp = datetime.fromisoformat(raw_ts)
                if timestamp.tzinfo is None:
                    timestamp = timestamp.replace(tzinfo=timezone.utc)
            except ValueError:
                timestamp = datetime.now(tz=timezone.utc)
        else:
            timestamp = datetime.now(tz=timezone.utc)

        # Run the pipeline
        from bodhi_vault.precognition import run_precognition
        state, strategy = run_precognition(text, timestamp=timestamp, channel=channel)

        # Output tier result
        if strategy.emergency_flag:
            print(f"CRISIS:{state.tier}")
            return 1
        else:
            print(f"OK:{state.tier}")
            return 0

    except Exception as exc:
        print(f"PRECOGNITION_ERROR:{exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
