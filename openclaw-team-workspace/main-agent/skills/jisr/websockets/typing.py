from __future__ import annotations

import http
import logging
from typing import TYPE_CHECKING, Any, NewType, Sequence


__all__ = [
    "Data",
    "LoggerLike",
    "StatusLike",
    "Origin",
    "Subprotocol",
    "ExtensionName",
    "ExtensionParameter",
]


# Public types used in the signature of public APIs

Data = str | bytes
"""Types supported in a WebSocket message:
:class:`str` for a Text_ frame, :class:`bytes` for a Binary_ frame.

.. _Text: https://datatracker.ietf.org/doc/html/rfc6455#section-5.6
.. _Binary : https://datatracker.ietf.org/doc/html/rfc6455#section-5.6

"""

BytesLike = bytes | bytearray | memoryview
"""Types accepted where :class:`bytes` is expected."""

DataLike = str | bytes | bytearray | memoryview
"""Types accepted where :class:`Data` is expected."""

if TYPE_CHECKING:
    LoggerLike = logging.Logger | logging.LoggerAdapter[Any]
    """Types accepted where a :class:`~logging.Logger` is expected."""
else:  # remove this branch when dropping support for Python < 3.11
    LoggerLike = logging.Logger | logging.LoggerAdapter
    """Types accepted where a :class:`~logging.Logger` is expected."""


StatusLike = http.HTTPStatus | int
"""
Types accepted where an :class:`~http.HTTPStatus` is expected."""


Origin = NewType("Origin", str)
"""Value of a ``Origin`` header."""


Subprotocol = NewType("Subprotocol", str)
"""Subprotocol in a ``Sec-WebSocket-Protocol`` header."""


ExtensionName = NewType("ExtensionName", str)
"""Name of a WebSocket extension."""

ExtensionParameter = tuple[str, str | None]
"""Parameter of a WebSocket extension."""


# Private types

ExtensionHeader = tuple[ExtensionName, Sequence[ExtensionParameter]]
"""Extension in a ``Sec-WebSocket-Extensions`` header."""


ConnectionOption = NewType("ConnectionOption", str)
"""Connection option in a ``Connection`` header."""


UpgradeProtocol = NewType("UpgradeProtocol", str)
"""Upgrade protocol in an ``Upgrade`` header."""
