import http

from .. import datastructures
from ..exceptions import (
    InvalidHandshake,
    # InvalidMessage was incorrectly moved here in versions 14.0 and 14.1.
    InvalidMessage,  # noqa: F401
    ProtocolError as WebSocketProtocolError,  # noqa: F401
)
from ..typing import StatusLike


class InvalidStatusCode(InvalidHandshake):
    """
    Raised when a handshake response status code is invalid.

    """

    def __init__(self, status_code: int, headers: datastructures.Headers) -> None:
        self.status_code = status_code
        self.headers = headers

    def __str__(self) -> str:
        return f"server rejected WebSocket connection: HTTP {self.status_code}"


class AbortHandshake(InvalidHandshake):
    """
    Raised to abort the handshake on purpose and return an HTTP response.

    This exception is an implementation detail.

    The public API is
    :meth:`~websockets.legacy.server.WebSocketServerProtocol.process_request`.

    Attributes:
        status (~http.HTTPStatus): HTTP status code.
        headers (Headers): HTTP response headers.
        body (bytes): HTTP response body.
    """

    def __init__(
        self,
        status: StatusLike,
        headers: datastructures.HeadersLike,
        body: bytes = b"",
    ) -> None:
        # If a user passes an int instead of an HTTPStatus, fix it automatically.
        self.status = http.HTTPStatus(status)
        self.headers = datastructures.Headers(headers)
        self.body = body

    def __str__(self) -> str:
        return (
            f"HTTP {self.status:d}, {len(self.headers)} headers, {len(self.body)} bytes"
        )


class RedirectHandshake(InvalidHandshake):
    """
    Raised when a handshake gets redirected.

    This exception is an implementation detail.

    """

    def __init__(self, uri: str) -> None:
        self.uri = uri

    def __str__(self) -> str:
        return f"redirect to {self.uri}"
