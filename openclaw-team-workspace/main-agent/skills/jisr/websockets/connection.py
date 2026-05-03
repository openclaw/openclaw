from __future__ import annotations

import warnings

from .protocol import SEND_EOF, Protocol as Connection, Side, State  # noqa: F401


warnings.warn(  # deprecated in 11.0 - 2023-04-02
    "websockets.connection was renamed to websockets.protocol "
    "and Connection was renamed to Protocol",
    DeprecationWarning,
)
