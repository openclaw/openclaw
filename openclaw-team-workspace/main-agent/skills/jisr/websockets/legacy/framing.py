from __future__ import annotations

import struct
from collections.abc import Awaitable, Sequence
from typing import Any, Callable, NamedTuple

from .. import extensions, frames
from ..exceptions import PayloadTooBig, ProtocolError
from ..typing import BytesLike, DataLike


try:
    from ..speedups import apply_mask
except ImportError:
    from ..utils import apply_mask


class Frame(NamedTuple):
    fin: bool
    opcode: frames.Opcode
    data: BytesLike
    rsv1: bool = False
    rsv2: bool = False
    rsv3: bool = False

    @property
    def new_frame(self) -> frames.Frame:
        return frames.Frame(
            self.opcode,
            self.data,
            self.fin,
            self.rsv1,
            self.rsv2,
            self.rsv3,
        )

    def __str__(self) -> str:
        return str(self.new_frame)

    def check(self) -> None:
        return self.new_frame.check()

    @classmethod
    async def read(
        cls,
        reader: Callable[[int], Awaitable[bytes]],
        *,
        mask: bool,
        max_size: int | None = None,
        extensions: Sequence[extensions.Extension] | None = None,
    ) -> Frame:
        """
        Read a WebSocket frame.

        Args:
            reader: Coroutine that reads exactly the requested number of
                bytes, unless the end of file is reached.
            mask: Whether the frame should be masked i.e. whether the read
                happens on the server side.
            max_size: Maximum payload size in bytes.
            extensions: List of extensions, applied in reverse order.

        Raises:
            PayloadTooBig: If the frame exceeds ``max_size``.
            ProtocolError: If the frame contains incorrect values.

        """

        # Read the header.
        data = await reader(2)
        head1, head2 = struct.unpack("!BB", data)

        # While not Pythonic, this is marginally faster than calling bool().
        fin = True if head1 & 0b10000000 else False
        rsv1 = True if head1 & 0b01000000 else False
        rsv2 = True if head1 & 0b00100000 else False
        rsv3 = True if head1 & 0b00010000 else False

        try:
            opcode = frames.Opcode(head1 & 0b00001111)
        except ValueError as exc:
            raise ProtocolError("invalid opcode") from exc

        if (True if head2 & 0b10000000 else False) != mask:
            raise ProtocolError("incorrect masking")

        length = head2 & 0b01111111
        if length == 126:
            data = await reader(2)
            (length,) = struct.unpack("!H", data)
        elif length == 127:
            data = await reader(8)
            (length,) = struct.unpack("!Q", data)
        if max_size is not None and length > max_size:
            raise PayloadTooBig(length, max_size)
        if mask:
            mask_bits = await reader(4)

        # Read the data.
        data = await reader(length)
        if mask:
            data = apply_mask(data, mask_bits)

        new_frame = frames.Frame(opcode, data, fin, rsv1, rsv2, rsv3)

        if extensions is None:
            extensions = []
        for extension in reversed(extensions):
            new_frame = extension.decode(new_frame, max_size=max_size)

        new_frame.check()

        return cls(
            new_frame.fin,
            new_frame.opcode,
            new_frame.data,
            new_frame.rsv1,
            new_frame.rsv2,
            new_frame.rsv3,
        )

    def write(
        self,
        write: Callable[[bytes], Any],
        *,
        mask: bool,
        extensions: Sequence[extensions.Extension] | None = None,
    ) -> None:
        """
        Write a WebSocket frame.

        Args:
            frame: Frame to write.
            write: Function that writes bytes.
            mask: Whether the frame should be masked i.e. whether the write
                happens on the client side.
            extensions: List of extensions, applied in order.

        Raises:
            ProtocolError: If the frame contains incorrect values.

        """
        # The frame is written in a single call to write in order to prevent
        # TCP fragmentation. See #68 for details. This also makes it safe to
        # send frames concurrently from multiple coroutines.
        write(self.new_frame.serialize(mask=mask, extensions=extensions))


def prepare_data(data: DataLike) -> tuple[int, BytesLike]:
    """
    Convert a string or byte-like object to an opcode and a bytes-like object.

    This function is designed for data frames.

    If ``data`` is a :class:`str`, return ``OP_TEXT`` and a :class:`bytes`
    object encoding ``data`` in UTF-8.

    If ``data`` is a bytes-like object, return ``OP_BINARY`` and a bytes-like
    object.

    Raises:
        TypeError: If ``data`` doesn't have a supported type.

    """
    if isinstance(data, str):
        return frames.Opcode.TEXT, data.encode()
    elif isinstance(data, BytesLike):
        return frames.Opcode.BINARY, data
    else:
        raise TypeError("data must be str or bytes-like")


def prepare_ctrl(data: DataLike) -> bytes:
    """
    Convert a string or byte-like object to bytes.

    This function is designed for ping and pong frames.

    If ``data`` is a :class:`str`, return a :class:`bytes` object encoding
    ``data`` in UTF-8.

    If ``data`` is a bytes-like object, return a :class:`bytes` object.

    Raises:
        TypeError: If ``data`` doesn't have a supported type.

    """
    if isinstance(data, str):
        return data.encode()
    elif isinstance(data, BytesLike):
        return bytes(data)
    else:
        raise TypeError("data must be str or bytes-like")


# Backwards compatibility with previously documented public APIs
encode_data = prepare_ctrl

# Backwards compatibility with previously documented public APIs
from ..frames import Close  # noqa: E402 F401, I001


def parse_close(data: bytes) -> tuple[int, str]:
    """
    Parse the payload from a close frame.

    Returns:
        Close code and reason.

    Raises:
        ProtocolError: If data is ill-formed.
        UnicodeDecodeError: If the reason isn't valid UTF-8.

    """
    close = Close.parse(data)
    return close.code, close.reason


def serialize_close(code: int, reason: str) -> bytes:
    """
    Serialize the payload for a close frame.

    """
    return Close(code, reason).serialize()
