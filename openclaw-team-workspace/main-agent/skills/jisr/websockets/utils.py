from __future__ import annotations

import base64
import hashlib
import secrets
import sys

from .typing import BytesLike


__all__ = ["accept_key", "apply_mask"]


GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


def generate_key() -> str:
    """
    Generate a random key for the Sec-WebSocket-Key header.

    """
    key = secrets.token_bytes(16)
    return base64.b64encode(key).decode()


def accept_key(key: str) -> str:
    """
    Compute the value of the Sec-WebSocket-Accept header.

    Args:
        key: Value of the Sec-WebSocket-Key header.

    """
    sha1 = hashlib.sha1((key + GUID).encode()).digest()
    return base64.b64encode(sha1).decode()


def apply_mask(data: BytesLike, mask: bytes | bytearray) -> bytes:
    """
    Apply masking to the data of a WebSocket message.

    Args:
        data: Data to mask.
        mask: 4-bytes mask.

    """
    if len(mask) != 4:
        raise ValueError("mask must contain 4 bytes")

    data_int = int.from_bytes(data, sys.byteorder)
    mask_repeated = mask * (len(data) // 4) + mask[: len(data) % 4]
    mask_int = int.from_bytes(mask_repeated, sys.byteorder)
    return (data_int ^ mask_int).to_bytes(len(data), sys.byteorder)
