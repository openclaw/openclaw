#!/usr/bin/env python3
import asyncio
import json
import os
import time
from pathlib import Path

import websockets


PARITY_DIR = Path(os.environ.get("PARITY_DIR", "/parity"))
EVENT_PATH = PARITY_DIR / "event.json"
DECISION_PATH = PARITY_DIR / "decision.json"
READY_PATH = PARITY_DIR / "gateway-ready"
DECISION_EVENT = os.environ.get("DECISION_EVENT", "security.decision")
CONNECT_TIMEOUT_SECS = float(os.environ.get("CONNECT_TIMEOUT_SECS", "20"))
EVENT_TIMEOUT_SECS = float(os.environ.get("EVENT_TIMEOUT_SECS", "45"))
DECISION_TIMEOUT_SECS = float(os.environ.get("DECISION_TIMEOUT_SECS", "60"))
HOST = os.environ.get("GATEWAY_HOST", "0.0.0.0")
PORT = int(os.environ.get("GATEWAY_PORT", "18789"))


def wait_for_file(path: Path, timeout_secs: float) -> str:
    deadline = time.monotonic() + timeout_secs
    while time.monotonic() < deadline:
        if path.exists():
            return path.read_text(encoding="utf-8")
        time.sleep(0.1)
    raise TimeoutError(f"timed out waiting for {path}")


async def handle_client(websocket, done: asyncio.Future) -> None:
    connect_raw = await asyncio.wait_for(websocket.recv(), timeout=CONNECT_TIMEOUT_SECS)
    connect_frame = json.loads(connect_raw)
    if connect_frame.get("type") != "req" or connect_frame.get("method") != "connect":
        raise RuntimeError("first frame was not connect request")

    event_raw = await asyncio.to_thread(wait_for_file, EVENT_PATH, EVENT_TIMEOUT_SECS)
    event_frame = json.loads(event_raw)
    await websocket.send(json.dumps(event_frame))

    while True:
        inbound_raw = await asyncio.wait_for(websocket.recv(), timeout=DECISION_TIMEOUT_SECS)
        inbound = json.loads(inbound_raw)
        if inbound.get("type") == "event" and inbound.get("event") == DECISION_EVENT:
            DECISION_PATH.write_text(json.dumps(inbound, indent=2), encoding="utf-8")
            done.set_result(True)
            return


async def main() -> int:
    PARITY_DIR.mkdir(parents=True, exist_ok=True)
    READY_PATH.write_text("ready\n", encoding="utf-8")
    done: asyncio.Future = asyncio.get_running_loop().create_future()

    async with websockets.serve(handle_client, HOST, PORT):
        await done
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
