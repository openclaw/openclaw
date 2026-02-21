#!/usr/bin/env python3
import json
import os
from pathlib import Path


PARITY_DIR = Path(os.environ.get("PARITY_DIR", "/parity"))
EVENT_PATH = PARITY_DIR / "event.json"
REQUEST_ID = os.environ.get("REQUEST_ID", "req-compose-security-1")
SESSION_KEY = os.environ.get("SESSION_KEY", "agent:main:discord:group:g-compose")


def main() -> int:
    PARITY_DIR.mkdir(parents=True, exist_ok=True)
    frame = {
        "type": "event",
        "event": "agent",
        "payload": {
            "id": REQUEST_ID,
            "sessionKey": SESSION_KEY,
            "chatType": "group",
            "wasMentioned": True,
            "channel": "discord",
            "tool": "exec",
            "command": "rm -rf /",
        },
    }
    EVENT_PATH.write_text(json.dumps(frame, indent=2), encoding="utf-8")
    print(f"wrote {EVENT_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
