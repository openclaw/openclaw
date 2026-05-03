from __future__ import annotations

# Importing the typing module would conflict with websockets.typing.
from typing import TYPE_CHECKING

from .imports import lazy_import
from .version import version as __version__  # noqa: F401


__all__ = [
    # .asyncio.client
    "connect",
    "unix_connect",
    "ClientConnection",
    # .asyncio.router
    "route",
    "unix_route",
    "Router",
    # .asyncio.server
    "basic_auth",
    "broadcast",
    "serve",
    "unix_serve",
    "ServerConnection",
    "Server",
    # .client
    "ClientProtocol",
    # .datastructures
    "Headers",
    "HeadersLike",
    "MultipleValuesError",
    # .exceptions
    "ConcurrencyError",
    "ConnectionClosed",
    "ConnectionClosedError",
    "ConnectionClosedOK",
    "DuplicateParameter",
    "InvalidHandshake",
    "InvalidHeader",
    "InvalidHeaderFormat",
    "InvalidHeaderValue",
    "InvalidMessage",
    "InvalidOrigin",
    "InvalidParameterName",
    "InvalidParameterValue",
    "InvalidProxy",
    "InvalidProxyMessage",
    "InvalidProxyStatus",
    "InvalidState",
    "InvalidStatus",
    "InvalidUpgrade",
    "InvalidURI",
    "NegotiationError",
    "PayloadTooBig",
    "ProtocolError",
    "ProxyError",
    "SecurityError",
    "WebSocketException",
    # .frames
    "Close",
    "CloseCode",
    "Frame",
    "Opcode",
    # .http11
    "Request",
    "Response",
    # .protocol
    "Protocol",
    "Side",
    "State",
    # .server
    "ServerProtocol",
    # .typing
    "Data",
    "ExtensionName",
    "ExtensionParameter",
    "LoggerLike",
    "StatusLike",
    "Origin",
    "Subprotocol",
]

# When type checking, import non-deprecated aliases eagerly. Else, import on demand.
if TYPE_CHECKING:
    from .asyncio.client import ClientConnection, connect, unix_connect
    from .asyncio.router import Router, route, unix_route
    from .asyncio.server import (
        Server,
        ServerConnection,
        basic_auth,
        broadcast,
        serve,
        unix_serve,
    )
    from .client import ClientProtocol
    from .datastructures import Headers, HeadersLike, MultipleValuesError
    from .exceptions import (
        ConcurrencyError,
        ConnectionClosed,
        ConnectionClosedError,
        ConnectionClosedOK,
        DuplicateParameter,
        InvalidHandshake,
        InvalidHeader,
        InvalidHeaderFormat,
        InvalidHeaderValue,
        InvalidMessage,
        InvalidOrigin,
        InvalidParameterName,
        InvalidParameterValue,
        InvalidProxy,
        InvalidProxyMessage,
        InvalidProxyStatus,
        InvalidState,
        InvalidStatus,
        InvalidUpgrade,
        InvalidURI,
        NegotiationError,
        PayloadTooBig,
        ProtocolError,
        ProxyError,
        SecurityError,
        WebSocketException,
    )
    from .frames import Close, CloseCode, Frame, Opcode
    from .http11 import Request, Response
    from .protocol import Protocol, Side, State
    from .server import ServerProtocol
    from .typing import (
        Data,
        ExtensionName,
        ExtensionParameter,
        LoggerLike,
        Origin,
        StatusLike,
        Subprotocol,
    )
else:
    lazy_import(
        globals(),
        aliases={
            # .asyncio.client
            "connect": ".asyncio.client",
            "unix_connect": ".asyncio.client",
            "ClientConnection": ".asyncio.client",
            # .asyncio.router
            "route": ".asyncio.router",
            "unix_route": ".asyncio.router",
            "Router": ".asyncio.router",
            # .asyncio.server
            "basic_auth": ".asyncio.server",
            "broadcast": ".asyncio.server",
            "serve": ".asyncio.server",
            "unix_serve": ".asyncio.server",
            "ServerConnection": ".asyncio.server",
            "Server": ".asyncio.server",
            # .client
            "ClientProtocol": ".client",
            # .datastructures
            "Headers": ".datastructures",
            "HeadersLike": ".datastructures",
            "MultipleValuesError": ".datastructures",
            # .exceptions
            "ConcurrencyError": ".exceptions",
            "ConnectionClosed": ".exceptions",
            "ConnectionClosedError": ".exceptions",
            "ConnectionClosedOK": ".exceptions",
            "DuplicateParameter": ".exceptions",
            "InvalidHandshake": ".exceptions",
            "InvalidHeader": ".exceptions",
            "InvalidHeaderFormat": ".exceptions",
            "InvalidHeaderValue": ".exceptions",
            "InvalidMessage": ".exceptions",
            "InvalidOrigin": ".exceptions",
            "InvalidParameterName": ".exceptions",
            "InvalidParameterValue": ".exceptions",
            "InvalidProxy": ".exceptions",
            "InvalidProxyMessage": ".exceptions",
            "InvalidProxyStatus": ".exceptions",
            "InvalidState": ".exceptions",
            "InvalidStatus": ".exceptions",
            "InvalidUpgrade": ".exceptions",
            "InvalidURI": ".exceptions",
            "NegotiationError": ".exceptions",
            "PayloadTooBig": ".exceptions",
            "ProtocolError": ".exceptions",
            "ProxyError": ".exceptions",
            "SecurityError": ".exceptions",
            "WebSocketException": ".exceptions",
            # .frames
            "Close": ".frames",
            "CloseCode": ".frames",
            "Frame": ".frames",
            "Opcode": ".frames",
            # .http11
            "Request": ".http11",
            "Response": ".http11",
            # .protocol
            "Protocol": ".protocol",
            "Side": ".protocol",
            "State": ".protocol",
            # .server
            "ServerProtocol": ".server",
            # .typing
            "Data": ".typing",
            "ExtensionName": ".typing",
            "ExtensionParameter": ".typing",
            "LoggerLike": ".typing",
            "Origin": ".typing",
            "StatusLike": ".typing",
            "Subprotocol": ".typing",
        },
        deprecated_aliases={
            # deprecated in 9.0 - 2021-09-01
            "framing": ".legacy",
            "handshake": ".legacy",
            "parse_uri": ".uri",
            "WebSocketURI": ".uri",
            # deprecated in 14.0 - 2024-11-09
            # .legacy.auth
            "BasicAuthWebSocketServerProtocol": ".legacy.auth",
            "basic_auth_protocol_factory": ".legacy.auth",
            # .legacy.client
            "WebSocketClientProtocol": ".legacy.client",
            # .legacy.exceptions
            "AbortHandshake": ".legacy.exceptions",
            "InvalidStatusCode": ".legacy.exceptions",
            "RedirectHandshake": ".legacy.exceptions",
            "WebSocketProtocolError": ".legacy.exceptions",
            # .legacy.protocol
            "WebSocketCommonProtocol": ".legacy.protocol",
            # .legacy.server
            "WebSocketServer": ".legacy.server",
            "WebSocketServerProtocol": ".legacy.server",
        },
    )
