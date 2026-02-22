from __future__ import annotations

import json
from typing import Any, Dict, Optional

try:
    import serial  # type: ignore
except Exception:  # pragma: no cover - optional dependency
    serial = None


class SerialAdapter:
    """Minimal JSON-line serial adapter."""

    def __init__(self, port: str, baudrate: int) -> None:
        self._port = port
        self._baudrate = int(baudrate)
        self._serial: Optional[Any] = None

    def connect(self) -> bool:
        """Open the serial port."""
        if self._serial is not None:
            return True
        if serial is None:
            raise RuntimeError("pyserial is not available")
        try:
            self._serial = serial.Serial(self._port, self._baudrate, timeout=1)
        except Exception as exc:
            raise RuntimeError(f"Failed to open serial port: {self._port}") from exc
        return True

    def disconnect(self) -> None:
        """Close the serial port if open."""
        if self._serial is None:
            return
        try:
            self._serial.close()
        finally:
            self._serial = None

    def read(self) -> Dict[str, Any]:
        """Read one JSON line and return as a dict."""
        if self._serial is None:
            raise RuntimeError("Serial not connected")
        line = self._serial.readline()
        if not line:
            return {}
        if isinstance(line, bytes):
            text = line.decode("utf-8").strip()
        else:
            text = str(line).strip()
        payload = json.loads(text)
        if not isinstance(payload, dict):
            raise ValueError("Expected JSON object")
        return payload

    def write(self, data: Dict[str, Any]) -> bool:
        """Write a dict as a JSON line."""
        if self._serial is None:
            raise RuntimeError("Serial not connected")
        if not isinstance(data, dict):
            raise TypeError("data must be a dict")
        payload = json.dumps(
            data,
            separators=(",", ":"),
            ensure_ascii=True,
            allow_nan=False,
        )
        self._serial.write((payload + "\n").encode("utf-8"))
        return True
