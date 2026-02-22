from __future__ import annotations

from typing import List

try:
    from plugins.serial_adapter.plugin import SerialAdapter
except ImportError:
    import sys
    import os

    sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))
    from plugins.serial_adapter.plugin import SerialAdapter


class _FakeSerial:
    def __init__(self, lines: List[bytes]) -> None:
        self._lines = list(lines)
        self.writes: List[bytes] = []
        self.closed = False

    def readline(self) -> bytes:
        if self._lines:
            return self._lines.pop(0)
        return b""

    def write(self, data: bytes) -> int:
        self.writes.append(data)
        return len(data)

    def close(self) -> None:
        self.closed = True


def run_self_test() -> None:
    adapter = SerialAdapter("mock", 9600)
    fake = _FakeSerial([b"{\"va", b"lue\":1}\n", b"", b"{}\n"])
    adapter._serial = fake  # type: ignore[attr-defined]

    if adapter.read() is not None:
        raise RuntimeError("read() should return None for partial frames")

    payload = adapter.read()
    if payload is None:
        raise RuntimeError("read() should return payload for complete frame")
    if payload.get("value") != 1:
        raise RuntimeError("read() did not return expected payload")

    if adapter.read() is not None:
        raise RuntimeError("read() should return None on timeout/empty reads")

    empty_payload = adapter.read()
    if empty_payload != {}:
        raise RuntimeError("read() should return empty JSON object when received")

    adapter.write({"value": 1})
    if not fake.writes or b'"value":1' not in fake.writes[0]:
        raise RuntimeError("write() did not send expected JSON")

    adapter.disconnect()
    if not fake.closed:
        raise RuntimeError("disconnect() did not close serial")

    print("SERIAL ADAPTER TEST PASSED")


def main() -> None:
    run_self_test()


if __name__ == "__main__":
    main()
