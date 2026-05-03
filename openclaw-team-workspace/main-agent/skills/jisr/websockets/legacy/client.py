from __future__ import annotations

import asyncio
import functools
import logging
import os
import random
import traceback
import urllib.parse
import warnings
from collections.abc import AsyncIterator, Generator, Sequence
from types import TracebackType
from typing import Any, Callable, cast

from ..asyncio.compatibility import asyncio_timeout
from ..datastructures import Headers, HeadersLike
from ..exceptions import (
    InvalidHeader,
    InvalidHeaderValue,
    InvalidMessage,
    NegotiationError,
    SecurityError,
)
from ..extensions import ClientExtensionFactory, Extension
from ..extensions.permessage_deflate import enable_client_permessage_deflate
from ..headers import (
    build_authorization_basic,
    build_extension,
    build_host,
    build_subprotocol,
    parse_extension,
    parse_subprotocol,
    validate_subprotocols,
)
from ..http11 import USER_AGENT
from ..typing import ExtensionHeader, LoggerLike, Origin, Subprotocol
from ..uri import WebSocketURI, parse_uri
from .exceptions import InvalidStatusCode, RedirectHandshake
from .handshake import build_request, check_response
from .http import read_response
from .protocol import WebSocketCommonProtocol


__all__ = ["connect", "unix_connect", "WebSocketClientProtocol"]


class WebSocketClientProtocol(WebSocketCommonProtocol):
    """
    WebSocket client connection.

    :class:`WebSocketClientProtocol` provides :meth:`recv` and :meth:`send`
    coroutines for receiving and sending messages.

    It supports asynchronous iteration to receive messages::

        async for message in websocket:
            await process(message)

    The iterator exits normally when the connection is closed with close code
    1000 (OK) or 1001 (going away) or without a close code. It raises
    a :exc:`~websockets.exceptions.ConnectionClosedError` when the connection
    is closed with any other code.

    See :func:`connect` for the documentation of ``logger``, ``origin``,
    ``extensions``, ``subprotocols``, ``extra_headers``, and
    ``user_agent_header``.

    See :class:`~websockets.legacy.protocol.WebSocketCommonProtocol` for the
    documentation of ``ping_interval``, ``ping_timeout``, ``close_timeout``,
    ``max_size``, ``max_queue``, ``read_limit``, and ``write_limit``.

    """

    is_client = True
    side = "client"

    def __init__(
        self,
        *,
        logger: LoggerLike | None = None,
        origin: Origin | None = None,
        extensions: Sequence[ClientExtensionFactory] | None = None,
        subprotocols: Sequence[Subprotocol] | None = None,
        extra_headers: HeadersLike | None = None,
        user_agent_header: str | None = USER_AGENT,
        **kwargs: Any,
    ) -> None:
        if logger is None:
            logger = logging.getLogger("websockets.client")
        super().__init__(logger=logger, **kwargs)
        self.origin = origin
        self.available_extensions = extensions
        self.available_subprotocols = subprotocols
        self.extra_headers = extra_headers
        self.user_agent_header = user_agent_header

    def write_http_request(self, path: str, headers: Headers) -> None:
        """
        Write request line and headers to the HTTP request.

        """
        self.path = path
        self.request_headers = headers

        if self.debug:
            self.logger.debug("> GET %s HTTP/1.1", path)
            for key, value in headers.raw_items():
                self.logger.debug("> %s: %s", key, value)

        # Since the path and headers only contain ASCII characters,
        # we can keep this simple.
        request = f"GET {path} HTTP/1.1\r\n"
        request += str(headers)

        self.transport.write(request.encode())

    async def read_http_response(self) -> tuple[int, Headers]:
        """
        Read status line and headers from the HTTP response.

        If the response contains a body, it may be read from ``self.reader``
        after this coroutine returns.

        Raises:
            InvalidMessage: If the HTTP message is malformed or isn't an
                HTTP/1.1 GET response.

        """
        try:
            status_code, reason, headers = await read_response(self.reader)
        except Exception as exc:
            raise InvalidMessage("did not receive a valid HTTP response") from exc

        if self.debug:
            self.logger.debug("< HTTP/1.1 %d %s", status_code, reason)
            for key, value in headers.raw_items():
                self.logger.debug("< %s: %s", key, value)

        self.response_headers = headers

        return status_code, self.response_headers

    @staticmethod
    def process_extensions(
        headers: Headers,
        available_extensions: Sequence[ClientExtensionFactory] | None,
    ) -> list[Extension]:
        """
        Handle the Sec-WebSocket-Extensions HTTP response header.

        Check that each extension is supported, as well as its parameters.

        Return the list of accepted extensions.

        Raise :exc:`~websockets.exceptions.InvalidHandshake` to abort the
        connection.

        :rfc:`6455` leaves the rules up to the specification of each
        :extension.

        To provide this level of flexibility, for each extension accepted by
        the server, we check for a match with each extension available in the
        client configuration. If no match is found, an exception is raised.

        If several variants of the same extension are accepted by the server,
        it may be configured several times, which won't make sense in general.
        Extensions must implement their own requirements. For this purpose,
        the list of previously accepted extensions is provided.

        Other requirements, for example related to mandatory extensions or the
        order of extensions, may be implemented by overriding this method.

        """
        accepted_extensions: list[Extension] = []

        header_values = headers.get_all("Sec-WebSocket-Extensions")

        if header_values:
            if available_extensions is None:
                raise NegotiationError("no extensions supported")

            parsed_header_values: list[ExtensionHeader] = sum(
                [parse_extension(header_value) for header_value in header_values], []
            )

            for name, response_params in parsed_header_values:
                for extension_factory in available_extensions:
                    # Skip non-matching extensions based on their name.
                    if extension_factory.name != name:
                        continue

                    # Skip non-matching extensions based on their params.
                    try:
                        extension = extension_factory.process_response_params(
                            response_params, accepted_extensions
                        )
                    except NegotiationError:
                        continue

                    # Add matching extension to the final list.
                    accepted_extensions.append(extension)

                    # Break out of the loop once we have a match.
                    break

                # If we didn't break from the loop, no extension in our list
                # matched what the server sent. Fail the connection.
                else:
                    raise NegotiationError(
                        f"Unsupported extension: "
                        f"name = {name}, params = {response_params}"
                    )

        return accepted_extensions

    @staticmethod
    def process_subprotocol(
        headers: Headers, available_subprotocols: Sequence[Subprotocol] | None
    ) -> Subprotocol | None:
        """
        Handle the Sec-WebSocket-Protocol HTTP response header.

        Check that it contains exactly one supported subprotocol.

        Return the selected subprotocol.

        """
        subprotocol: Subprotocol | None = None

        header_values = headers.get_all("Sec-WebSocket-Protocol")

        if header_values:
            if available_subprotocols is None:
                raise NegotiationError("no subprotocols supported")

            parsed_header_values: Sequence[Subprotocol] = sum(
                [parse_subprotocol(header_value) for header_value in header_values], []
            )

            if len(parsed_header_values) > 1:
                raise InvalidHeaderValue(
                    "Sec-WebSocket-Protocol",
                    f"multiple values: {', '.join(parsed_header_values)}",
                )

            subprotocol = parsed_header_values[0]

            if subprotocol not in available_subprotocols:
                raise NegotiationError(f"unsupported subprotocol: {subprotocol}")

        return subprotocol

    async def handshake(
        self,
        wsuri: WebSocketURI,
        origin: Origin | None = None,
        available_extensions: Sequence[ClientExtensionFactory] | None = None,
        available_subprotocols: Sequence[Subprotocol] | None = None,
        extra_headers: HeadersLike | None = None,
    ) -> None:
        """
        Perform the client side of the opening handshake.

        Args:
            wsuri: URI of the WebSocket server.
            origin: Value of the ``Origin`` header.
            extensions: List of supported extensions, in order in which they
                should be negotiated and run.
            subprotocols: List of supported subprotocols, in order of decreasing
                preference.
            extra_headers: Arbitrary HTTP headers to add to the handshake request.

        Raises:
            InvalidHandshake: If the handshake fails.

        """
        request_headers = Headers()

        request_headers["Host"] = build_host(wsuri.host, wsuri.port, wsuri.secure)

        if wsuri.user_info:
            request_headers["Authorization"] = build_authorization_basic(
                *wsuri.user_info
            )

        if origin is not None:
            request_headers["Origin"] = origin

        key = build_request(request_headers)

        if available_extensions is not None:
            extensions_header = build_extension(
                [
                    (extension_factory.name, extension_factory.get_request_params())
                    for extension_factory in available_extensions
                ]
            )
            request_headers["Sec-WebSocket-Extensions"] = extensions_header

        if available_subprotocols is not None:
            protocol_header = build_subprotocol(available_subprotocols)
            request_headers["Sec-WebSocket-Protocol"] = protocol_header

        if self.extra_headers is not None:
            request_headers.update(self.extra_headers)

        if self.user_agent_header:
            request_headers.setdefault("User-Agent", self.user_agent_header)

        self.write_http_request(wsuri.resource_name, request_headers)

        status_code, response_headers = await self.read_http_response()
        if status_code in (301, 302, 303, 307, 308):
            if "Location" not in response_headers:
                raise InvalidHeader("Location")
            raise RedirectHandshake(response_headers["Location"])
        elif status_code != 101:
            raise InvalidStatusCode(status_code, response_headers)

        check_response(response_headers, key)

        self.extensions = self.process_extensions(
            response_headers, available_extensions
        )

        self.subprotocol = self.process_subprotocol(
            response_headers, available_subprotocols
        )

        self.connection_open()


class Connect:
    """
    Connect to the WebSocket server at ``uri``.

    Awaiting :func:`connect` yields a :class:`WebSocketClientProtocol` which
    can then be used to send and receive messages.

    :func:`connect` can be used as a asynchronous context manager::

        async with connect(...) as websocket:
            ...

    The connection is closed automatically when exiting the context.

    :func:`connect` can be used as an infinite asynchronous iterator to
    reconnect automatically on errors::

        async for websocket in connect(...):
            try:
                ...
            except websockets.exceptions.ConnectionClosed:
                continue

    The connection is closed automatically after each iteration of the loop.

    If an error occurs while establishing the connection, :func:`connect`
    retries with exponential backoff. The backoff delay starts at three
    seconds and increases up to one minute.

    If an error occurs in the body of the loop, you can handle the exception
    and :func:`connect` will reconnect with the next iteration; or you can
    let the exception bubble up and break out of the loop. This lets you
    decide which errors trigger a reconnection and which errors are fatal.

    Args:
        uri: URI of the WebSocket server.
        create_protocol: Factory for the :class:`asyncio.Protocol` managing
            the connection. It defaults to :class:`WebSocketClientProtocol`.
            Set it to a wrapper or a subclass to customize connection handling.
        logger: Logger for this client.
            It defaults to ``logging.getLogger("websockets.client")``.
            See the :doc:`logging guide <../../topics/logging>` for details.
        compression: The "permessage-deflate" extension is enabled by default.
            Set ``compression`` to :obj:`None` to disable it. See the
            :doc:`compression guide <../../topics/compression>` for details.
        origin: Value of the ``Origin`` header, for servers that require it.
        extensions: List of supported extensions, in order in which they
            should be negotiated and run.
        subprotocols: List of supported subprotocols, in order of decreasing
            preference.
        extra_headers: Arbitrary HTTP headers to add to the handshake request.
        user_agent_header: Value of  the ``User-Agent`` request header.
            It defaults to ``"Python/x.y.z websockets/X.Y"``.
            Setting it to :obj:`None` removes the header.
        open_timeout: Timeout for opening the connection in seconds.
            :obj:`None` disables the timeout.

    See :class:`~websockets.legacy.protocol.WebSocketCommonProtocol` for the
    documentation of ``ping_interval``, ``ping_timeout``, ``close_timeout``,
    ``max_size``, ``max_queue``, ``read_limit``, and ``write_limit``.

    Any other keyword arguments are passed the event loop's
    :meth:`~asyncio.loop.create_connection` method.

    For example:

    * You can set ``ssl`` to a :class:`~ssl.SSLContext` to enforce TLS
      settings. When connecting to a ``wss://`` URI, if ``ssl`` isn't
      provided, a TLS context is created
      with :func:`~ssl.create_default_context`.

    * You can set ``host`` and ``port`` to connect to a different host and
      port from those found in ``uri``. This only changes the destination of
      the TCP connection. The host name from ``uri`` is still used in the TLS
      handshake for secure connections and in the ``Host`` header.

    Raises:
        InvalidURI: If ``uri`` isn't a valid WebSocket URI.
        OSError: If the TCP connection fails.
        InvalidHandshake: If the opening handshake fails.
        ~asyncio.TimeoutError: If the opening handshake times out.

    """

    MAX_REDIRECTS_ALLOWED = int(os.environ.get("WEBSOCKETS_MAX_REDIRECTS", "10"))

    def __init__(
        self,
        uri: str,
        *,
        create_protocol: Callable[..., WebSocketClientProtocol] | None = None,
        logger: LoggerLike | None = None,
        compression: str | None = "deflate",
        origin: Origin | None = None,
        extensions: Sequence[ClientExtensionFactory] | None = None,
        subprotocols: Sequence[Subprotocol] | None = None,
        extra_headers: HeadersLike | None = None,
        user_agent_header: str | None = USER_AGENT,
        open_timeout: float | None = 10,
        ping_interval: float | None = 20,
        ping_timeout: float | None = 20,
        close_timeout: float | None = None,
        max_size: int | None = 2**20,
        max_queue: int | None = 2**5,
        read_limit: int = 2**16,
        write_limit: int = 2**16,
        **kwargs: Any,
    ) -> None:
        # Backwards compatibility: close_timeout used to be called timeout.
        timeout: float | None = kwargs.pop("timeout", None)
        if timeout is None:
            timeout = 10
        else:
            warnings.warn("rename timeout to close_timeout", DeprecationWarning)
        # If both are specified, timeout is ignored.
        if close_timeout is None:
            close_timeout = timeout

        # Backwards compatibility: create_protocol used to be called klass.
        klass: type[WebSocketClientProtocol] | None = kwargs.pop("klass", None)
        if klass is None:
            klass = WebSocketClientProtocol
        else:
            warnings.warn("rename klass to create_protocol", DeprecationWarning)
        # If both are specified, klass is ignored.
        if create_protocol is None:
            create_protocol = klass

        # Backwards compatibility: recv() used to return None on closed connections
        legacy_recv: bool = kwargs.pop("legacy_recv", False)

        # Backwards compatibility: the loop parameter used to be supported.
        _loop: asyncio.AbstractEventLoop | None = kwargs.pop("loop", None)
        if _loop is None:
            loop = asyncio.get_event_loop()
        else:
            loop = _loop
            warnings.warn("remove loop argument", DeprecationWarning)

        wsuri = parse_uri(uri)
        if wsuri.secure:
            kwargs.setdefault("ssl", True)
        elif kwargs.get("ssl") is not None:
            raise ValueError(
                "connect() received a ssl argument for a ws:// URI, "
                "use a wss:// URI to enable TLS"
            )

        if compression == "deflate":
            extensions = enable_client_permessage_deflate(extensions)
        elif compression is not None:
            raise ValueError(f"unsupported compression: {compression}")

        if subprotocols is not None:
            validate_subprotocols(subprotocols)

        # Help mypy and avoid this error: "type[WebSocketClientProtocol] |
        # Callable[..., WebSocketClientProtocol]" not callable  [misc]
        create_protocol = cast(Callable[..., WebSocketClientProtocol], create_protocol)
        factory = functools.partial(
            create_protocol,
            logger=logger,
            origin=origin,
            extensions=extensions,
            subprotocols=subprotocols,
            extra_headers=extra_headers,
            user_agent_header=user_agent_header,
            ping_interval=ping_interval,
            ping_timeout=ping_timeout,
            close_timeout=close_timeout,
            max_size=max_size,
            max_queue=max_queue,
            read_limit=read_limit,
            write_limit=write_limit,
            host=wsuri.host,
            port=wsuri.port,
            secure=wsuri.secure,
            legacy_recv=legacy_recv,
            loop=_loop,
        )

        if kwargs.pop("unix", False):
            path: str | None = kwargs.pop("path", None)
            create_connection = functools.partial(
                loop.create_unix_connection, factory, path, **kwargs
            )
        else:
            host: str | None
            port: int | None
            if kwargs.get("sock") is None:
                host, port = wsuri.host, wsuri.port
            else:
                # If sock is given, host and port shouldn't be specified.
                host, port = None, None
                if kwargs.get("ssl"):
                    kwargs.setdefault("server_hostname", wsuri.host)
            # If host and port are given, override values from the URI.
            host = kwargs.pop("host", host)
            port = kwargs.pop("port", port)
            create_connection = functools.partial(
                loop.create_connection, factory, host, port, **kwargs
            )

        self.open_timeout = open_timeout
        if logger is None:
            logger = logging.getLogger("websockets.client")
        self.logger = logger

        # This is a coroutine function.
        self._create_connection = create_connection
        self._uri = uri
        self._wsuri = wsuri

    def handle_redirect(self, uri: str) -> None:
        # Update the state of this instance to connect to a new URI.
        old_uri = self._uri
        old_wsuri = self._wsuri
        new_uri = urllib.parse.urljoin(old_uri, uri)
        new_wsuri = parse_uri(new_uri)

        # Forbid TLS downgrade.
        if old_wsuri.secure and not new_wsuri.secure:
            raise SecurityError("redirect from WSS to WS")

        same_origin = (
            old_wsuri.secure == new_wsuri.secure
            and old_wsuri.host == new_wsuri.host
            and old_wsuri.port == new_wsuri.port
        )

        # Rewrite secure, host, and port for cross-origin redirects.
        # This preserves connection overrides with the host and port
        # arguments if the redirect points to the same host and port.
        if not same_origin:
            factory = self._create_connection.args[0]
            # Support TLS upgrade.
            if not old_wsuri.secure and new_wsuri.secure:
                factory.keywords["secure"] = True
                self._create_connection.keywords.setdefault("ssl", True)
            # Replace secure, host, and port arguments of the protocol factory.
            factory = functools.partial(
                factory.func,
                *factory.args,
                **dict(factory.keywords, host=new_wsuri.host, port=new_wsuri.port),
            )
            # Replace secure, host, and port arguments of create_connection.
            self._create_connection = functools.partial(
                self._create_connection.func,
                *(factory, new_wsuri.host, new_wsuri.port),
                **self._create_connection.keywords,
            )

        # Set the new WebSocket URI. This suffices for same-origin redirects.
        self._uri = new_uri
        self._wsuri = new_wsuri

    # async for ... in connect(...):

    BACKOFF_INITIAL = float(os.environ.get("WEBSOCKETS_BACKOFF_INITIAL_DELAY", "5"))
    BACKOFF_MIN = float(os.environ.get("WEBSOCKETS_BACKOFF_MIN_DELAY", "3.1"))
    BACKOFF_MAX = float(os.environ.get("WEBSOCKETS_BACKOFF_MAX_DELAY", "90.0"))
    BACKOFF_FACTOR = float(os.environ.get("WEBSOCKETS_BACKOFF_FACTOR", "1.618"))

    async def __aiter__(self) -> AsyncIterator[WebSocketClientProtocol]:
        backoff_delay = self.BACKOFF_MIN / self.BACKOFF_FACTOR
        while True:
            try:
                async with self as protocol:
                    yield protocol
            except Exception as exc:
                # Add a random initial delay between 0 and 5 seconds.
                # See 7.2.3. Recovering from Abnormal Closure in RFC 6455.
                if backoff_delay == self.BACKOFF_MIN:
                    initial_delay = random.random() * self.BACKOFF_INITIAL
                    self.logger.info(
                        "connect failed; reconnecting in %.1f seconds: %s",
                        initial_delay,
                        traceback.format_exception_only(exc)[0].strip(),
                    )
                    await asyncio.sleep(initial_delay)
                else:
                    self.logger.info(
                        "connect failed again; retrying in %d seconds: %s",
                        int(backoff_delay),
                        traceback.format_exception_only(exc)[0].strip(),
                    )
                    await asyncio.sleep(int(backoff_delay))
                # Increase delay with truncated exponential backoff.
                backoff_delay = backoff_delay * self.BACKOFF_FACTOR
                backoff_delay = min(backoff_delay, self.BACKOFF_MAX)
                continue
            else:
                # Connection succeeded - reset backoff delay
                backoff_delay = self.BACKOFF_MIN

    # async with connect(...) as ...:

    async def __aenter__(self) -> WebSocketClientProtocol:
        return await self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        await self.protocol.close()

    # ... = await connect(...)

    def __await__(self) -> Generator[Any, None, WebSocketClientProtocol]:
        # Create a suitable iterator by calling __await__ on a coroutine.
        return self.__await_impl__().__await__()

    async def __await_impl__(self) -> WebSocketClientProtocol:
        async with asyncio_timeout(self.open_timeout):
            for _redirects in range(self.MAX_REDIRECTS_ALLOWED):
                _transport, protocol = await self._create_connection()
                try:
                    await protocol.handshake(
                        self._wsuri,
                        origin=protocol.origin,
                        available_extensions=protocol.available_extensions,
                        available_subprotocols=protocol.available_subprotocols,
                        extra_headers=protocol.extra_headers,
                    )
                except RedirectHandshake as exc:
                    protocol.fail_connection()
                    await protocol.wait_closed()
                    self.handle_redirect(exc.uri)
                # Avoid leaking a connected socket when the handshake fails.
                except (Exception, asyncio.CancelledError):
                    protocol.fail_connection()
                    await protocol.wait_closed()
                    raise
                else:
                    self.protocol = protocol
                    return protocol
            else:
                raise SecurityError("too many redirects")

    # ... = yield from connect(...) - remove when dropping Python < 3.11

    __iter__ = __await__


connect = Connect


def unix_connect(
    path: str | None = None,
    uri: str = "ws://localhost/",
    **kwargs: Any,
) -> Connect:
    """
    Similar to :func:`connect`, but for connecting to a Unix socket.

    This function builds upon the event loop's
    :meth:`~asyncio.loop.create_unix_connection` method.

    It is only available on Unix.

    It's mainly useful for debugging servers listening on Unix sockets.

    Args:
        path: File system path to the Unix socket.
        uri: URI of the WebSocket server; the host is used in the TLS
            handshake for secure connections and in the ``Host`` header.

    """
    return connect(uri=uri, path=path, unix=True, **kwargs)
