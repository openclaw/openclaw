from __future__ import annotations

import dataclasses
import enum
import io
import os
import secrets
import struct
from collections.abc import Generator, Sequence
from typing import Callable

from .exceptions import PayloadTooBig, ProtocolError
from .typing import BytesLike


try:
    from .speedups import apply_mask
except ImportError:
    from .utils import apply_mask


__all__ = [
    "Opcode",
    "OP_CONT",
    "OP_TEXT",
    "OP_BINARY",
    "OP_CLOSE",
    "OP_PING",
    "OP_PONG",
    "DATA_OPCODES",
    "CTRL_OPCODES",
    "CloseCode",
    "Frame",
    "Close",
]


class Opcode(enum.IntEnum):
    """Opcode values for WebSocket frames."""

    CONT, TEXT, BINARY = 0x00, 0x01, 0x02
    CLOSE, PING, PONG = 0x08, 0x09, 0x0A


OP_CONT = Opcode.CONT
OP_TEXT = Opcode.TEXT
OP_BINARY = Opcode.BINARY
OP_CLOSE = Opcode.CLOSE
OP_PING = Opcode.PING
OP_PONG = Opcode.PONG

DATA_OPCODES = OP_CONT, OP_TEXT, OP_BINARY
CTRL_OPCODES = OP_CLOSE, OP_PING, OP_PONG


class CloseCode(enum.IntEnum):
    """Close code values for WebSocket close frames."""

    NORMAL_CLOSURE = 1000
    GOING_AWAY = 1001
    PROTOCOL_ERROR = 1002
    UNSUPPORTED_DATA = 1003
    # 1004 is reserved
    NO_STATUS_RCVD = 1005
    ABNORMAL_CLOSURE = 1006
    INVALID_DATA = 1007
    POLICY_VIOLATION = 1008
    MESSAGE_TOO_BIG = 1009
    MANDATORY_EXTENSION = 1010
    INTERNAL_ERROR = 1011
    SERVICE_RESTART = 1012
    TRY_AGAIN_LATER = 1013
    BAD_GATEWAY = 1014
    TLS_HANDSHAKE = 1015


# See https://www.iana.org/assignments/websocket/websocket.xhtml
CLOSE_CODE_EXPLANATIONS: dict[int, str] = {
    CloseCode.NORMAL_CLOSURE: "OK",
    CloseCode.GOING_AWAY: "going away",
    CloseCode.PROTOCOL_ERROR: "protocol error",
    CloseCode.UNSUPPORTED_DATA: "unsupported data",
    CloseCode.NO_STATUS_RCVD: "no status received [internal]",
    CloseCode.ABNORMAL_CLOSURE: "abnormal closure [internal]",
    CloseCode.INVALID_DATA: "invalid frame payload data",
    CloseCode.POLICY_VIOLATION: "policy violation",
    CloseCode.MESSAGE_TOO_BIG: "message too big",
    CloseCode.MANDATORY_EXTENSION: "mandatory extension",
    CloseCode.INTERNAL_ERROR: "internal error",
    CloseCode.SERVICE_RESTART: "service restart",
    CloseCode.TRY_AGAIN_LATER: "try again later",
    CloseCode.BAD_GATEWAY: "bad gateway",
    CloseCode.TLS_HANDSHAKE: "TLS handshake failure [internal]",
}


# Close code that are allowed in a close frame.
# Using a set optimizes `code in EXTERNAL_CLOSE_CODES`.
EXTERNAL_CLOSE_CODES = {
    CloseCode.NORMAL_CLOSURE,
    CloseCode.GOING_AWAY,
    CloseCode.PROTOCOL_ERROR,
    CloseCode.UNSUPPORTED_DATA,
    CloseCode.INVALID_DATA,
    CloseCode.POLICY_VIOLATION,
    CloseCode.MESSAGE_TOO_BIG,
    CloseCode.MANDATORY_EXTENSION,
    CloseCode.INTERNAL_ERROR,
    CloseCode.SERVICE_RESTART,
    CloseCode.TRY_AGAIN_LATER,
    CloseCode.BAD_GATEWAY,
}


OK_CLOSE_CODES = {
    CloseCode.NORMAL_CLOSURE,
    CloseCode.GOING_AWAY,
    CloseCode.NO_STATUS_RCVD,
}


@dataclasses.dataclass
class Frame:
    """
    WebSocket frame.

    Attributes:
        opcode: Opcode.
        data: Payload data.
        fin: FIN bit.
        rsv1: RSV1 bit.
        rsv2: RSV2 bit.
        rsv3: RSV3 bit.

    Only these fields are needed. The MASK bit, payload length and masking-key
    are handled on the fly when parsing and serializing frames.

    """

    opcode: Opcode
    data: BytesLike
    fin: bool = True
    rsv1: bool = False
    rsv2: bool = False
    rsv3: bool = False

    # Configure if you want to see more in logs. Should be a multiple of 3.
    MAX_LOG_SIZE = int(os.environ.get("WEBSOCKETS_MAX_LOG_SIZE", "75"))

    def __str__(self) -> str:
        """
        Return a human-readable representation of a frame.

        """
        coding = None
        length = f"{len(self.data)} byte{'' if len(self.data) == 1 else 's'}"
        non_final = "" if self.fin else "continued"

        if self.opcode is OP_TEXT:
            # Decoding only the beginning and the end is needlessly hard.
            # Decode the entire payload then elide later if necessary.
            data = repr(bytes(self.data).decode())
        elif self.opcode is OP_BINARY:
            # We'll show at most the first 16 bytes and the last 8 bytes.
            # Encode just what we need, plus two dummy bytes to elide later.
            binary = self.data
            if len(binary) > self.MAX_LOG_SIZE // 3:
                cut = (self.MAX_LOG_SIZE // 3 - 1) // 3  # by default cut = 8
                binary = b"".join([binary[: 2 * cut], b"\x00\x00", binary[-cut:]])
            data = " ".join(f"{byte:02x}" for byte in binary)
        elif self.opcode is OP_CLOSE:
            data = str(Close.parse(self.data))
        elif self.data:
            # We don't know if a Continuation frame contains text or binary.
            # Ping and Pong frames could contain UTF-8.
            # Attempt to decode as UTF-8 and display it as text; fallback to
            # binary. If self.data is a memoryview, it has no decode() method,
            # which raises AttributeError.
            try:
                data = repr(bytes(self.data).decode())
                coding = "text"
            except (UnicodeDecodeError, AttributeError):
                binary = self.data
                if len(binary) > self.MAX_LOG_SIZE // 3:
                    cut = (self.MAX_LOG_SIZE // 3 - 1) // 3  # by default cut = 8
                    binary = b"".join([binary[: 2 * cut], b"\x00\x00", binary[-cut:]])
                data = " ".join(f"{byte:02x}" for byte in binary)
                coding = "binary"
        else:
            data = "''"

        if len(data) > self.MAX_LOG_SIZE:
            cut = self.MAX_LOG_SIZE // 3 - 1  # by default cut = 24
            data = data[: 2 * cut] + "..." + data[-cut:]

        metadata = ", ".join(filter(None, [coding, length, non_final]))

        return f"{self.opcode.name} {data} [{metadata}]"

    @classmethod
    def parse(
        cls,
        read_exact: Callable[[int], Generator[None, None, bytes | bytearray]],
        *,
        mask: bool,
        max_size: int | None = None,
        extensions: Sequence[extensions.Extension] | None = None,
    ) -> Generator[None, None, Frame]:
        """
        Parse a WebSocket frame.

        This is a generator-based coroutine.

        Args:
            read_exact: Generator-based coroutine that reads the requested
                bytes or raises an exception if there isn't enough data.
            mask: Whether the frame should be masked i.e. whether the read
                happens on the server side.
            max_size: Maximum payload size in bytes.
            extensions: List of extensions, applied in reverse order.

        Raises:
            EOFError: If the connection is closed without a full WebSocket frame.
            PayloadTooBig: If the frame's payload size exceeds ``max_size``.
            ProtocolError: If the frame contains incorrect values.

        """
        # Read the header.
        data = yield from read_exact(2)
        head1, head2 = struct.unpack("!BB", data)

        # While not Pythonic, this is marginally faster than calling bool().
        fin = True if head1 & 0b10000000 else False
        rsv1 = True if head1 & 0b01000000 else False
        rsv2 = True if head1 & 0b00100000 else False
        rsv3 = True if head1 & 0b00010000 else False

        try:
            opcode = Opcode(head1 & 0b00001111)
        except ValueError as exc:
            raise ProtocolError("invalid opcode") from exc

        if (True if head2 & 0b10000000 else False) != mask:
            raise ProtocolError("incorrect masking")

        length = head2 & 0b01111111
        if length == 126:
            data = yield from read_exact(2)
            (length,) = struct.unpack("!H", data)
        elif length == 127:
            data = yield from read_exact(8)
            (length,) = struct.unpack("!Q", data)
        if max_size is not None and length > max_size:
            raise PayloadTooBig(length, max_size)
        if mask:
            mask_bytes = yield from read_exact(4)

        # Read the data.
        data = yield from read_exact(length)
        if mask:
            data = apply_mask(data, mask_bytes)

        frame = cls(opcode, data, fin, rsv1, rsv2, rsv3)

        if extensions is None:
            extensions = []
        for extension in reversed(extensions):
            frame = extension.decode(frame, max_size=max_size)

        frame.check()

        return frame

    def serialize(
        self,
        *,
        mask: bool,
        extensions: Sequence[extensions.Extension] | None = None,
    ) -> bytes:
        """
        Serialize a WebSocket frame.

        Args:
            mask: Whether the frame should be masked i.e. whether the write
                happens on the client side.
            extensions: List of extensions, applied in order.

        Raises:
            ProtocolError: If the frame contains incorrect values.

        """
        self.check()

        if extensions is None:
            extensions = []
        for extension in extensions:
            self = extension.encode(self)

        output = io.BytesIO()

        # Prepare the header.
        head1 = (
            (0b10000000 if self.fin else 0)
            | (0b01000000 if self.rsv1 else 0)
            | (0b00100000 if self.rsv2 else 0)
            | (0b00010000 if self.rsv3 else 0)
            | self.opcode
        )

        head2 = 0b10000000 if mask else 0

        length = len(self.data)
        if length < 126:
            output.write(struct.pack("!BB", head1, head2 | length))
        elif length < 65536:
            output.write(struct.pack("!BBH", head1, head2 | 126, length))
        else:
            output.write(struct.pack("!BBQ", head1, head2 | 127, length))

        if mask:
            mask_bytes = secrets.token_bytes(4)
            output.write(mask_bytes)

        # Prepare the data.
        data: BytesLike
        if mask:
            data = apply_mask(self.data, mask_bytes)
        else:
            data = self.data
        output.write(data)

        return output.getvalue()

    def check(self) -> None:
        """
        Check that reserved bits and opcode have acceptable values.

        Raises:
            ProtocolError: If a reserved bit or the opcode is invalid.

        """
        if self.rsv1 or self.rsv2 or self.rsv3:
            raise ProtocolError("reserved bits must be 0")

        if self.opcode in CTRL_OPCODES:
            if len(self.data) > 125:
                raise ProtocolError("control frame too long")
            if not self.fin:
                raise ProtocolError("fragmented control frame")


@dataclasses.dataclass
class Close:
    """
    Code and reason for WebSocket close frames.

    Attributes:
        code: Close code.
        reason: Close reason.

    """

    code: CloseCode | int
    reason: str

    def __str__(self) -> str:
        """
        Return a human-readable representation of a close code and reason.

        """
        if 3000 <= self.code < 4000:
            explanation = "registered"
        elif 4000 <= self.code < 5000:
            explanation = "private use"
        else:
            explanation = CLOSE_CODE_EXPLANATIONS.get(self.code, "unknown")
        result = f"{self.code} ({explanation})"

        if self.reason:
            result = f"{result} {self.reason}"

        return result

    @classmethod
    def parse(cls, data: BytesLike) -> Close:
        """
        Parse the payload of a close frame.

        Args:
            data: Payload of the close frame.

        Raises:
            ProtocolError: If data is ill-formed.
            UnicodeDecodeError: If the reason isn't valid UTF-8.

        """
        if isinstance(data, memoryview):
            raise AssertionError("only compressed outgoing frames use memoryview")
        if len(data) >= 2:
            (code,) = struct.unpack("!H", data[:2])
            reason = data[2:].decode()
            close = cls(code, reason)
            close.check()
            return close
        elif len(data) == 0:
            return cls(CloseCode.NO_STATUS_RCVD, "")
        else:
            raise ProtocolError("close frame too short")

    def serialize(self) -> bytes:
        """
        Serialize the payload of a close frame.

        """
        self.check()
        return struct.pack("!H", self.code) + self.reason.encode()

    def check(self) -> None:
        """
        Check that the close code has a valid value for a close frame.

        Raises:
            ProtocolError: If the close code is invalid.

        """
        if not (self.code in EXTERNAL_CLOSE_CODES or 3000 <= self.code < 5000):
            raise ProtocolError("invalid status code")


# At the bottom to break import cycles created by type annotations.
from . import extensions  # noqa: E402
