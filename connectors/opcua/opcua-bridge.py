#!/usr/bin/env python3
"""
OPC-UA connector (NDJSON stdio). Simulation by default; optional asyncua for live nodes.

Env: CLAWORKS_OPCUA_ENDPOINT, CLAWORKS_OPCUA_SIMULATE=1
Invoke: connect, read_node { node_id }, simulate_alarm { payload? }
"""
from __future__ import annotations

import json
import os
import sys
from typing import Any

CONNECTOR_ID = os.environ.get("CLAWORKS_CONNECTOR_ID", "opcua")
ENDPOINT = os.environ.get("CLAWORKS_OPCUA_ENDPOINT", "opc.tcp://127.0.0.1:4840")
SIMULATE = os.environ.get("CLAWORKS_OPCUA_SIMULATE", "1") == "1"


def send(msg: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def emit_event(event_type: str, payload: dict[str, Any], source: str | None = None) -> None:
    send(
        {
            "type": "event",
            "event_type": event_type,
            "source": source or f"opcua://{CONNECTOR_ID}",
            "payload": payload,
        }
    )


def handle_invoke(msg: dict[str, Any]) -> None:
    req_id = msg.get("id", "")
    method = msg.get("method", "")
    params = msg.get("params") or {}

    try:
        if method == "connect":
            if SIMULATE:
                send({"type": "result", "id": req_id, "ok": True, "result": {"mode": "simulate", "endpoint": ENDPOINT}})
                return
            try:
                import asyncio
                from asyncua import Client  # type: ignore

                async def _ping() -> bool:
                    client = Client(url=str(params.get("endpoint", ENDPOINT)))
                    await client.connect()
                    await client.disconnect()
                    return True

                asyncio.run(_ping())
                send({"type": "result", "id": req_id, "ok": True, "result": {"mode": "live", "endpoint": ENDPOINT}})
            except ImportError:
                send({"type": "result", "id": req_id, "ok": False, "error": "asyncua not installed — set CLAWORKS_OPCUA_SIMULATE=1"})
            return

        if method == "read_node":
            node_id = str(params.get("node_id", "ns=2;s=Temperature"))
            if SIMULATE:
                send(
                    {
                        "type": "result",
                        "id": req_id,
                        "ok": True,
                        "result": {"node_id": node_id, "value": 42.5, "simulated": True},
                    }
                )
                return
            send({"type": "result", "id": req_id, "ok": False, "error": "live read_node requires asyncua wiring"})
            return

        if method == "simulate_alarm":
            payload = params.get("payload") or {
                "alarm_id": f"opcua-{CONNECTOR_ID}",
                "mro_alarm_to_wo": True,
                "equipment_id": "EQ-OPCUA-001",
                "priority": "high",
                "node_id": params.get("node_id", "ns=2;s=Alarm"),
            }
            emit_event(str(params.get("event_type", "alarm.created")), payload)
            send({"type": "result", "id": req_id, "ok": True, "result": {"emitted": True}})
            return

        send({"type": "result", "id": req_id, "ok": False, "error": f"unknown method: {method}"})
    except Exception as exc:  # noqa: BLE001
        send({"type": "result", "id": req_id, "ok": False, "error": str(exc)})


def main() -> None:
    send({"type": "ready", "connectorId": CONNECTOR_ID, "connector": "opcua", "simulate": SIMULATE})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        if msg.get("type") == "shutdown":
            break
        if msg.get("type") == "invoke":
            handle_invoke(msg)


if __name__ == "__main__":
    main()
