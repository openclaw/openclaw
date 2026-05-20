#!/usr/bin/env python3
"""
Modbus TCP connector (NDJSON stdio). Simulation by default; optional pymodbus for live reads.

Env: CLAWORKS_MODBUS_HOST, CLAWORKS_MODBUS_PORT, CLAWORKS_MODBUS_SIMULATE=1
Invoke: connect, read_holding { address, count }, simulate_alarm { payload? }
"""
from __future__ import annotations

import json
import os
import sys
from typing import Any

CONNECTOR_ID = os.environ.get("CLAWORKS_CONNECTOR_ID", "modbus")
HOST = os.environ.get("CLAWORKS_MODBUS_HOST", "127.0.0.1")
PORT = int(os.environ.get("CLAWORKS_MODBUS_PORT", "502"))
SIMULATE = os.environ.get("CLAWORKS_MODBUS_SIMULATE", "1") == "1"


def send(msg: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def emit_event(event_type: str, payload: dict[str, Any]) -> None:
    send(
        {
            "type": "event",
            "event_type": event_type,
            "source": f"modbus://{HOST}:{PORT}",
            "payload": payload,
        }
    )


def read_holding_simulate(address: int, count: int) -> list[int]:
    return [address + i for i in range(count)]


def read_holding_live(address: int, count: int) -> list[int]:
    from pymodbus.client import ModbusTcpClient  # type: ignore

    client = ModbusTcpClient(HOST, port=PORT)
    client.connect()
    try:
        result = client.read_holding_registers(address, count, slave=1)
        if result.isError():
            raise RuntimeError(str(result))
        return list(result.registers)
    finally:
        client.close()


def handle_invoke(msg: dict[str, Any]) -> None:
    req_id = msg.get("id", "")
    method = msg.get("method", "")
    params = msg.get("params") or {}

    try:
        if method == "connect":
            send(
                {
                    "type": "result",
                    "id": req_id,
                    "ok": True,
                    "result": {
                        "mode": "simulate" if SIMULATE else "live",
                        "host": HOST,
                        "port": PORT,
                    },
                }
            )
            return

        if method == "read_holding":
            address = int(params.get("address", 0))
            count = int(params.get("count", 1))
            if SIMULATE:
                values = read_holding_simulate(address, count)
            else:
                values = read_holding_live(address, count)
            emit_event(
                "sensor.reading",
                {
                    "register": address,
                    "count": count,
                    "values": values,
                    "host": HOST,
                    "port": PORT,
                },
            )
            send({"type": "result", "id": req_id, "ok": True, "result": {"values": values}})
            return

        if method == "simulate_alarm":
            payload = params.get("payload") or {
                "alarm_id": f"modbus-{CONNECTOR_ID}",
                "mro_alarm_to_wo": True,
                "equipment_id": "EQ-MODBUS-001",
                "register": params.get("address", 40001),
            }
            emit_event(str(params.get("event_type", "alarm.created")), payload)
            send({"type": "result", "id": req_id, "ok": True, "result": {"emitted": True}})
            return

        send({"type": "result", "id": req_id, "ok": False, "error": f"unknown method: {method}"})
    except Exception as exc:  # noqa: BLE001
        send({"type": "result", "id": req_id, "ok": False, "error": str(exc)})


def main() -> None:
    send({"type": "ready", "connectorId": CONNECTOR_ID, "connector": "modbus", "simulate": SIMULATE})
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
