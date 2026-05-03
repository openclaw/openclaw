"""
:mod:`websockets.exceptions` defines the following hierarchy of exceptions.

* :exc:`WebSocketException`
    * :exc:`ConnectionClosed`
        * :exc:`ConnectionClosedOK`
        * :exc:`ConnectionClosedError`
    * :exc:`InvalidURI`
    * :exc:`InvalidProxy`
    * :exc:`InvalidHandshake`
        * :exc:`SecurityError`
        * :exc:`ProxyError`
            * :exc:`InvalidProxyMessage`
            * :exc:`InvalidProxyStatus`
        * :exc:`InvalidMessage`
        * :exc:`InvalidStatus`
        * :exc:`InvalidStatusCode` (legacy)
        * :exc:`InvalidHeader`
            * :exc:`InvalidHeaderFormat`
            * :exc:`InvalidHeaderValue`
            * :exc:`InvalidOrigin`
            * :exc:`InvalidUpgrade`
        * :exc:`NegotiationError`
            * :exc:`DuplicateParameter`
            * :exc:`InvalidParameterName`
            * :exc:`InvalidParameterValue`
        * :exc:`AbortHandshake` (legacy)
        * :exc:`RedirectHandshake` (legacy)
    * :exc:`ProtocolError` (Sans-I/O)
    * :exc:`PayloadTooBig` (Sans-I/O)
    * :exc:`InvalidState` (Sans-I/O)
    * :exc:`ConcurrencyError`

"""

from __future__ import annotations

import warnings

from .imports import lazy_import


__all__ = [
    "WebSocketException",
    "ConnectionClosed",
    "ConnectionClosedOK",
    "ConnectionClosedError",
    "InvalidURI",
    "InvalidProxy",
    "InvalidHandshake",
    "SecurityError",
    "ProxyError",
    "InvalidProxyMessage",
    "InvalidProxyStatus",
    "InvalidMessage",
    "InvalidStatus",
    "InvalidHeader",
    "InvalidHeaderFormat",
    "InvalidHeaderValue",
    "InvalidOrigin",
    "InvalidUpgrade",
    "NegotiationError",
    "DuplicateParameter",
    "InvalidParameterName",
    "InvalidParameterValue",
    "ProtocolError",
    "PayloadTooBig",
    "InvalidState",
    "ConcurrencyError",
]


class WebSocketException(Exception):
    """
    Base class for all exceptions defined by websockets.

    """


class ConnectionClosed(WebSocketException):
    """
    Raised when trying to interact with a closed connection.

    Attributes:
        rcvd: If a close frame was received, its code and reason are available
            in ``rcvd.code`` and ``rcvd.reason``.
        sent: If a close frame was sent, its code and reason are available
            in ``sent.code`` and ``sent.reason``.
        rcvd_then_sent: If close frames were received and sent, this attribute
            tells in which order this happened, from the perspective of this
            side of the connection.

    """

    def __init__(
        self,
        rcvd: frames.Close | None,
        sent: frames.Close | None,
        rcvd_then_sent: bool | None = None,
    ) -> None:
        self.rcvd = rcvd
        self.sent = sent
        self.rcvd_then_sent = rcvd_then_sent
        assert (self.rcvd_then_sent is None) == (self.rcvd is None or self.sent is None)

    def __str__(self) -> str:
        if self.rcvd is None:
            if self.sent is None:
                return "no close frame received or sent"
            else:
                return f"sent {self.sent}; no close frame received"
        else:
            if self.sent is None:
                return f"received {self.rcvd}; no close frame sent"
            else:
                if self.rcvd_then_sent:
                    return f"received {self.rcvd}; then sent {self.sent}"
                else:
                    return f"sent {self.sent}; then received {self.rcvd}"

    # code and reason attributes are provided for backwards-compatibility

    @property
    def code(self) -> int:
        warnings.warn(  # deprecated in 13.1 - 2024-09-21
            "ConnectionClosed.code is deprecated; "
            "use Protocol.close_code or ConnectionClosed.rcvd.code",
            DeprecationWarning,
        )
        if self.rcvd is None:
            return frames.CloseCode.ABNORMAL_CLOSURE
        return self.rcvd.code

    @property
    def reason(self) -> str:
        warnings.warn(  # deprecated in 13.1 - 2024-09-21
            "ConnectionClosed.reason is deprecated; "
            "use Protocol.close_reason or ConnectionClosed.rcvd.reason",
            DeprecationWarning,
        )
        if self.rcvd is None:
            return ""
        return self.rcvd.reason


class ConnectionClosedOK(ConnectionClosed):
    """
    Like :exc:`ConnectionClosed`, when the connection terminated properly.

    A close code with code 1000 (OK) or 1001 (going away) or without a code was
    received and sent.

    """


class ConnectionClosedError(ConnectionClosed):
    """
    Like :exc:`ConnectionClosed`, when the connection terminated with an error.

    A close frame with a code other than 1000 (OK) or 1001 (going away) was
    received or sent, or the closing handshake didn't complete properly.

    """


class InvalidURI(WebSocketException):
    """
    Raised when connecting to a URI that isn't a valid WebSocket URI.

    """

    def __init__(self, uri: str, msg: str) -> None:
        self.uri = uri
        self.msg = msg

    def __str__(self) -> str:
        return f"{self.uri} isn't a valid URI: {self.msg}"


class InvalidProxy(WebSocketException):
    """
    Raised when connecting via a proxy that isn't valid.

    """

    def __init__(self, proxy: str, msg: str) -> None:
        self.proxy = proxy
        self.msg = msg

    def __str__(self) -> str:
        return f"{self.proxy} isn't a valid proxy: {self.msg}"


class InvalidHandshake(WebSocketException):
    """
    Base class for exceptions raised when the opening handshake fails.

    """


class SecurityError(InvalidHandshake):
    """
    Raised when a handshake request or response breaks a security rule.

    Security limits can be configured with :doc:`environment variables
    <../reference/variables>`.

    """


class ProxyError(InvalidHandshake):
    """
    Raised when failing to connect to a proxy.

    """


class InvalidProxyMessage(ProxyError):
    """
    Raised when an HTTP proxy response is malformed.

    """


class InvalidProxyStatus(ProxyError):
    """
    Raised when an HTTP proxy rejects the connection.

    """

    def __init__(self, response: http11.Response) -> None:
        self.response = response

    def __str__(self) -> str:
        return f"proxy rejected connection: HTTP {self.response.status_code:d}"


class InvalidMessage(InvalidHandshake):
    """
    Raised when a handshake request or response is malformed.

    """


class InvalidStatus(InvalidHandshake):
    """
    Raised when a handshake response rejects the WebSocket upgrade.

    """

    def __init__(self, response: http11.Response) -> None:
        self.response = response

    def __str__(self) -> str:
        return (
            f"server rejected WebSocket connection: HTTP {self.response.status_code:d}"
        )


class InvalidHeader(InvalidHandshake):
    """
    Raised when an HTTP header doesn't have a valid format or value.

    """

    def __init__(self, name: str, value: str | None = None) -> None:
        self.name = name
        self.value = value

    def __str__(self) -> str:
        if self.value is None:
            return f"missing {self.name} header"
        elif self.value == "":
            return f"empty {self.name} header"
        else:
            return f"invalid {self.name} header: {self.value}"


class InvalidHeaderFormat(InvalidHeader):
    """
    Raised when an HTTP header cannot be parsed.

    The format of the header doesn't match the grammar for that header.

    """

    def __init__(self, name: str, error: str, header: str, pos: int) -> None:
        super().__init__(name, f"{error} at {pos} in {header}")


class InvalidHeaderValue(InvalidHeader):
    """
    Raised when an HTTP header has a wrong value.

    The format of the header is correct but the value isn't acceptable.

    """


class InvalidOrigin(InvalidHeader):
    """
    Raised when the Origin header in a request isn't allowed.

    """

    def __init__(self, origin: str | None) -> None:
        super().__init__("Origin", origin)


class InvalidUpgrade(InvalidHeader):
    """
    Raised when the Upgrade or Connection header isn't correct.

    """


class NegotiationError(InvalidHandshake):
    """
    Raised when negotiating an extension or a subprotocol fails.

    """


class DuplicateParameter(NegotiationError):
    """
    Raised when a parameter name is repeated in an extension header.

    """

    def __init__(self, name: str) -> None:
        self.name = name

    def __str__(self) -> str:
        return f"duplicate parameter: {self.name}"


class InvalidParameterName(NegotiationError):
    """
    Raised when a parameter name in an extension header is invalid.

    """

    def __init__(self, name: str) -> None:
        self.name = name

    def __str__(self) -> str:
        return f"invalid parameter name: {self.name}"


class InvalidParameterValue(NegotiationError):
    """
    Raised when a parameter value in an extension header is invalid.

    """

    def __init__(self, name: str, value: str | None) -> None:
        self.name = name
        self.value = value

    def __str__(self) -> str:
        if self.value is None:
            return f"missing value for parameter {self.name}"
        elif self.value == "":
            return f"empty value for parameter {self.name}"
        else:
            return f"invalid value for parameter {self.name}: {self.value}"


class ProtocolError(WebSocketException):
    """
    Raised when receiving or sending a frame that breaks the protocol.

    The Sans-I/O implementation raises this exception when:

    * receiving or sending a frame that contains invalid data;
    * receiving or sending an invalid sequence of frames.

    """


class PayloadTooBig(WebSocketException):
    """
    Raised when parsing a frame with a payload that exceeds the maximum size.

    The Sans-I/O layer uses this exception internally. It doesn't bubble up to
    the I/O layer.

    The :meth:`~websockets.extensions.Extension.decode` method of extensions
    must raise :exc:`PayloadTooBig` if decoding a frame would exceed the limit.

    """

    def __init__(
        self,
        size_or_message: int | None | str,
        max_size: int | None = None,
        current_size: int | None = None,
    ) -> None:
        if isinstance(size_or_message, str):
            assert max_size is None
            assert current_size is None
            warnings.warn(  # deprecated in 14.0 - 2024-11-09
                "PayloadTooBig(message) is deprecated; "
                "change to PayloadTooBig(size, max_size)",
                DeprecationWarning,
            )
            self.message: str | None = size_or_message
        else:
            self.message = None
            self.size: int | None = size_or_message
            assert max_size is not None
            self.max_size: int = max_size
            self.current_size: int | None = None
            self.set_current_size(current_size)

    def __str__(self) -> str:
        if self.message is not None:
            return self.message
        else:
            message = "frame "
            if self.size is not None:
                message += f"with {self.size} bytes "
            if self.current_size is not None:
                message += f"after reading {self.current_size} bytes "
            message += f"exceeds limit of {self.max_size} bytes"
            return message

    def set_current_size(self, current_size: int | None) -> None:
        assert self.current_size is None
        if current_size is not None:
            self.max_size += current_size
            self.current_size = current_size


class InvalidState(WebSocketException, AssertionError):
    """
    Raised when sending a frame is forbidden in the current state.

    Specifically, the Sans-I/O layer raises this exception when:

    * sending a data frame to a connection in a state other
      :attr:`~websockets.protocol.State.OPEN`;
    * sending a control frame to a connection in a state other than
      :attr:`~websockets.protocol.State.OPEN` or
      :attr:`~websockets.protocol.State.CLOSING`.

    """


class ConcurrencyError(WebSocketException, RuntimeError):
    """
    Raised when receiving or sending messages concurrently.

    WebSocket is a connection-oriented protocol. Reads must be serialized; so
    must be writes. However, reading and writing concurrently is possible.

    """


# At the bottom to break import cycles created by type annotations.
from . import frames, http11  # noqa: E402


lazy_import(
    globals(),
    deprecated_aliases={
        # deprecated in 14.0 - 2024-11-09
        "AbortHandshake": ".legacy.exceptions",
        "InvalidStatusCode": ".legacy.exceptions",
        "RedirectHandshake": ".legacy.exceptions",
        "WebSocketProtocolError": ".legacy.exceptions",
    },
)
