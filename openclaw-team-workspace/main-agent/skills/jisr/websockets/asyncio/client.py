from __future__ import annotations

import asyncio
import logging
import os
import socket
import ssl as ssl_module
import traceback
import urllib.parse
from collections.abc import AsyncIterator, Generator, Sequence
from types import TracebackType
from typing import Any, Callable, Literal, cast

from ..client import ClientProtocol, backoff
from ..datastructures import HeadersLike
from ..exceptions import (
    InvalidMessage,
    InvalidProxyMessage,
    InvalidProxyStatus,
    InvalidStatus,
    ProxyError,
    SecurityError,
)
from ..extensions.base import ClientExtensionFactory
from ..extensions.permessage_deflate import enable_client_permessage_deflate
from ..headers import validate_subprotocols
from ..http11 import USER_AGENT, Response
from ..protocol import CONNECTING, Event
from ..proxy import Proxy, get_proxy, parse_proxy, prepare_connect_request
from ..streams import StreamReader
from ..typing import LoggerLike, Origin, Subprotocol
from ..uri import WebSocketURI, parse_uri
from .compatibility import TimeoutError, asyncio_timeout
from .connection import Connection


__all__ = ["connect", "unix_connect", "ClientConnection"]

MAX_REDIRECTS = int(os.environ.get("WEBSOCKETS_MAX_REDIRECTS", "10"))


class ClientConnection(Connection):
    """
    :mod:`asyncio` implementation of a WebSocket client connection.

    :class:`ClientConnection` provides :meth:`recv` and :meth:`send` coroutines
    for receiving and sending messages.

    It supports asynchronous iteration to receive messages::

        async for message in websocket:
            await process(message)

    The iterator exits normally when the connection is closed with code
    1000 (OK) or 1001 (going away) or without a close code. It raises a
    :exc:`~websockets.exceptions.ConnectionClosedError` when the connection is
    closed with any other code.

    The ``ping_interval``, ``ping_timeout``, ``close_timeout``, ``max_queue``,
    and ``write_limit`` arguments have the same meaning as in :func:`connect`.

    Args:
        protocol: Sans-I/O connection.

    """

    def __init__(
        self,
        protocol: ClientProtocol,
        *,
        ping_interval: float | None = 20,
        ping_timeout: float | None = 20,
        close_timeout: float | None = 10,
        max_queue: int | None | tuple[int | None, int | None] = 16,
        write_limit: int | tuple[int, int | None] = 2**15,
    ) -> None:
        self.protocol: ClientProtocol
        super().__init__(
            protocol,
            ping_interval=ping_interval,
            ping_timeout=ping_timeout,
            close_timeout=close_timeout,
            max_queue=max_queue,
            write_limit=write_limit,
        )
        self.response_rcvd: asyncio.Future[None] = self.loop.create_future()

    async def handshake(
        self,
        additional_headers: HeadersLike | None = None,
        user_agent_header: str | None = USER_AGENT,
    ) -> None:
        """
        Perform the opening handshake.

        """
        async with self.send_context(expected_state=CONNECTING):
            self.request = self.protocol.connect()
            if additional_headers is not None:
                self.request.headers.update(additional_headers)
            if user_agent_header is not None:
                self.request.headers.setdefault("User-Agent", user_agent_header)
            self.protocol.send_request(self.request)

        await asyncio.wait(
            [self.response_rcvd, self.connection_lost_waiter],
            return_when=asyncio.FIRST_COMPLETED,
        )

        # self.protocol.handshake_exc is set when the connection is lost before
        # receiving a response, when the response cannot be parsed, or when the
        # response fails the handshake.

        if self.protocol.handshake_exc is not None:
            raise self.protocol.handshake_exc

    def process_event(self, event: Event) -> None:
        """
        Process one incoming event.

        """
        # First event - handshake response.
        if self.response is None:
            assert isinstance(event, Response)
            self.response = event
            self.response_rcvd.set_result(None)
        # Later events - frames.
        else:
            super().process_event(event)


def process_exception(exc: Exception) -> Exception | None:
    """
    Determine whether a connection error is retryable or fatal.

    When reconnecting automatically with ``async for ... in connect(...)``, if a
    connection attempt fails, :func:`process_exception` is called to determine
    whether to retry connecting or to raise the exception.

    This function defines the default behavior, which is to retry on:

    * :exc:`EOFError`, :exc:`OSError`, :exc:`asyncio.TimeoutError`: network
      errors;
    * :exc:`~websockets.exceptions.InvalidStatus` when the status code is 500,
      502, 503, or 504: server or proxy errors.

    All other exceptions are considered fatal.

    You can change this behavior with the ``process_exception`` argument of
    :func:`connect`.

    Return :obj:`None` if the exception is retryable i.e. when the error could
    be transient and trying to reconnect with the same parameters could succeed.
    The exception will be logged at the ``INFO`` level.

    Return an exception, either ``exc`` or a new exception, if the exception is
    fatal i.e. when trying to reconnect will most likely produce the same error.
    That exception will be raised, breaking out of the retry loop.

    """
    # This catches python-socks' ProxyConnectionError and ProxyTimeoutError.
    # Remove asyncio.TimeoutError when dropping Python < 3.11.
    if isinstance(exc, (OSError, TimeoutError, asyncio.TimeoutError)):
        return None
    if isinstance(exc, InvalidMessage) and isinstance(exc.__cause__, EOFError):
        return None
    if isinstance(exc, InvalidStatus) and exc.response.status_code in [
        500,  # Internal Server Error
        502,  # Bad Gateway
        503,  # Service Unavailable
        504,  # Gateway Timeout
    ]:
        return None
    return exc


# This is spelled in lower case because it's exposed as a callable in the API.
class connect:
    """
    Connect to the WebSocket server at ``uri``.

    This coroutine returns a :class:`ClientConnection` instance, which you can
    use to send and receive messages.

    :func:`connect` may be used as an asynchronous context manager::

        from websockets.asyncio.client import connect

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

    If the connection fails with a transient error, it is retried with
    exponential backoff. If it fails with a fatal error, the exception is
    raised, breaking out of the loop.

    The connection is closed automatically after each iteration of the loop.

    Args:
        uri: URI of the WebSocket server.
        origin: Value of the ``Origin`` header, for servers that require it.
        extensions: List of supported extensions, in order in which they
            should be negotiated and run.
        subprotocols: List of supported subprotocols, in order of decreasing
            preference.
        compression: The "permessage-deflate" extension is enabled by default.
            Set ``compression`` to :obj:`None` to disable it. See the
            :doc:`compression guide <../../topics/compression>` for details.
        additional_headers (HeadersLike | None): Arbitrary HTTP headers to add
            to the handshake request.
        user_agent_header: Value of  the ``User-Agent`` request header.
            It defaults to ``"Python/x.y.z websockets/X.Y"``.
            Setting it to :obj:`None` removes the header.
        proxy: If a proxy is configured, it is used by default. Set ``proxy``
            to :obj:`None` to disable the proxy or to the address of a proxy
            to override the system configuration. See the :doc:`proxy docs
            <../../topics/proxies>` for details.
        process_exception: When reconnecting automatically, tell whether an
            error is transient or fatal. The default behavior is defined by
            :func:`process_exception`. Refer to its documentation for details.
        open_timeout: Timeout for opening the connection in seconds.
            :obj:`None` disables the timeout.
        ping_interval: Interval between keepalive pings in seconds.
            :obj:`None` disables keepalive.
        ping_timeout: Timeout for keepalive pings in seconds.
            :obj:`None` disables timeouts.
        close_timeout: Timeout for closing the connection in seconds.
            :obj:`None` disables the timeout.
        max_size: Maximum size of incoming messages in bytes.
            :obj:`None` disables the limit. You may pass a ``(max_message_size,
            max_fragment_size)`` tuple to set different limits for messages and
            fragments when you expect long messages sent in short fragments.
        max_queue: High-water mark of the buffer where frames are received.
            It defaults to 16 frames. The low-water mark defaults to ``max_queue
            // 4``. You may pass a ``(high, low)`` tuple to set the high-water
            and low-water marks. If you want to disable flow control entirely,
            you may set it to ``None``, although that's a bad idea.
        write_limit: High-water mark of write buffer in bytes. It is passed to
            :meth:`~asyncio.WriteTransport.set_write_buffer_limits`. It defaults
            to 32 KiB. You may pass a ``(high, low)`` tuple to set the
            high-water and low-water marks.
        logger: Logger for this client.
            It defaults to ``logging.getLogger("websockets.client")``.
            See the :doc:`logging guide <../../topics/logging>` for details.
        create_connection: Factory for the :class:`ClientConnection` managing
            the connection. Set it to a wrapper or a subclass to customize
            connection handling.

    Any other keyword arguments are passed to the event loop's
    :meth:`~asyncio.loop.create_connection` method.

    For example:

    * You can set ``ssl`` to a :class:`~ssl.SSLContext` to enforce TLS settings.
      When connecting to a ``wss://`` URI, if ``ssl`` isn't provided, a TLS
      context is created with :func:`~ssl.create_default_context`.

    * You can set ``server_hostname`` to override the host name from ``uri`` in
      the TLS handshake.

    * You can set ``host`` and ``port`` to connect to a different host and port
      from those found in ``uri``. This only changes the destination of the TCP
      connection. The host name from ``uri`` is still used in the TLS handshake
      for secure connections and in the ``Host`` header.

    * You can set ``sock`` to provide a preexisting TCP socket. You may call
      :func:`socket.create_connection` (not to be confused with the event loop's
      :meth:`~asyncio.loop.create_connection` method) to create a suitable
      client socket and customize it.

    When using a proxy:

    * Prefix keyword arguments with ``proxy_`` for configuring TLS between the
      client and an HTTPS proxy: ``proxy_ssl``, ``proxy_server_hostname``,
      ``proxy_ssl_handshake_timeout``, and ``proxy_ssl_shutdown_timeout``.
    * Use the standard keyword arguments for configuring TLS between the proxy
      and the WebSocket server: ``ssl``, ``server_hostname``,
      ``ssl_handshake_timeout``, and ``ssl_shutdown_timeout``.
    * Other keyword arguments are used only for connecting to the proxy.

    Raises:
        InvalidURI: If ``uri`` isn't a valid WebSocket URI.
        InvalidProxy: If ``proxy`` isn't a valid proxy.
        OSError: If the TCP connection fails.
        InvalidHandshake: If the opening handshake fails.
        TimeoutError: If the opening handshake times out.

    """

    def __init__(
        self,
        uri: str,
        *,
        # WebSocket
        origin: Origin | None = None,
        extensions: Sequence[ClientExtensionFactory] | None = None,
        subprotocols: Sequence[Subprotocol] | None = None,
        compression: str | None = "deflate",
        # HTTP
        additional_headers: HeadersLike | None = None,
        user_agent_header: str | None = USER_AGENT,
        proxy: str | Literal[True] | None = True,
        process_exception: Callable[[Exception], Exception | None] = process_exception,
        # Timeouts
        open_timeout: float | None = 10,
        ping_interval: float | None = 20,
        ping_timeout: float | None = 20,
        close_timeout: float | None = 10,
        # Limits
        max_size: int | None | tuple[int | None, int | None] = 2**20,
        max_queue: int | None | tuple[int | None, int | None] = 16,
        write_limit: int | tuple[int, int | None] = 2**15,
        # Logging
        logger: LoggerLike | None = None,
        # Escape hatch for advanced customization
        create_connection: type[ClientConnection] | None = None,
        # Other keyword arguments are passed to loop.create_connection
        **kwargs: Any,
    ) -> None:
        self.uri = uri

        if subprotocols is not None:
            validate_subprotocols(subprotocols)

        if compression == "deflate":
            extensions = enable_client_permessage_deflate(extensions)
        elif compression is not None:
            raise ValueError(f"unsupported compression: {compression}")

        if logger is None:
            logger = logging.getLogger("websockets.client")

        if create_connection is None:
            create_connection = ClientConnection

        def protocol_factory(uri: WebSocketURI) -> ClientConnection:
            # This is a protocol in the Sans-I/O implementation of websockets.
            protocol = ClientProtocol(
                uri,
                origin=origin,
                extensions=extensions,
                subprotocols=subprotocols,
                max_size=max_size,
                logger=logger,
            )
            # This is a connection in websockets and a protocol in asyncio.
            connection = create_connection(
                protocol,
                ping_interval=ping_interval,
                ping_timeout=ping_timeout,
                close_timeout=close_timeout,
                max_queue=max_queue,
                write_limit=write_limit,
            )
            return connection

        self.proxy = proxy
        self.protocol_factory = protocol_factory
        self.additional_headers = additional_headers
        self.user_agent_header = user_agent_header
        self.process_exception = process_exception
        self.open_timeout = open_timeout
        self.logger = logger
        self.connection_kwargs = kwargs

    async def create_connection(self) -> ClientConnection:
        """Create TCP or Unix connection."""
        loop = asyncio.get_running_loop()
        kwargs = self.connection_kwargs.copy()

        ws_uri = parse_uri(self.uri)

        proxy = self.proxy
        if kwargs.get("unix", False):
            proxy = None
        if kwargs.get("sock") is not None:
            proxy = None
        if proxy is True:
            proxy = get_proxy(ws_uri)

        def factory() -> ClientConnection:
            return self.protocol_factory(ws_uri)

        if ws_uri.secure:
            kwargs.setdefault("ssl", True)
            kwargs.setdefault("server_hostname", ws_uri.host)
            if kwargs.get("ssl") is None:
                raise ValueError("ssl=None is incompatible with a wss:// URI")
        else:
            if kwargs.get("ssl") is not None:
                raise ValueError("ssl argument is incompatible with a ws:// URI")

        if kwargs.pop("unix", False):
            _, connection = await loop.create_unix_connection(factory, **kwargs)
        elif proxy is not None:
            proxy_parsed = parse_proxy(proxy)
            if proxy_parsed.scheme[:5] == "socks":
                # Connect to the server through the proxy.
                sock = await connect_socks_proxy(
                    proxy_parsed,
                    ws_uri,
                    local_addr=kwargs.pop("local_addr", None),
                )
                # Initialize WebSocket connection via the proxy.
                _, connection = await loop.create_connection(
                    factory,
                    sock=sock,
                    **kwargs,
                )
            elif proxy_parsed.scheme[:4] == "http":
                # Split keyword arguments between the proxy and the server.
                all_kwargs, proxy_kwargs, kwargs = kwargs, {}, {}
                for key, value in all_kwargs.items():
                    if key.startswith("ssl") or key == "server_hostname":
                        kwargs[key] = value
                    elif key.startswith("proxy_"):
                        proxy_kwargs[key[6:]] = value
                    else:
                        proxy_kwargs[key] = value
                # Validate the proxy_ssl argument.
                if proxy_parsed.scheme == "https":
                    proxy_kwargs.setdefault("ssl", True)
                    if proxy_kwargs.get("ssl") is None:
                        raise ValueError(
                            "proxy_ssl=None is incompatible with an https:// proxy"
                        )
                else:
                    if proxy_kwargs.get("ssl") is not None:
                        raise ValueError(
                            "proxy_ssl argument is incompatible with an http:// proxy"
                        )
                # Connect to the server through the proxy.
                transport = await connect_http_proxy(
                    proxy_parsed,
                    ws_uri,
                    user_agent_header=self.user_agent_header,
                    **proxy_kwargs,
                )
                # Initialize WebSocket connection via the proxy.
                connection = factory()
                transport.set_protocol(connection)
                ssl = kwargs.pop("ssl", None)
                if ssl is True:
                    ssl = ssl_module.create_default_context()
                if ssl is not None:
                    new_transport = await loop.start_tls(
                        transport, connection, ssl, **kwargs
                    )
                    assert new_transport is not None  # help mypy
                    transport = new_transport
                connection.connection_made(transport)
            else:
                raise AssertionError("unsupported proxy")
        else:
            # Connect to the server directly.
            if kwargs.get("sock") is None:
                kwargs.setdefault("host", ws_uri.host)
                kwargs.setdefault("port", ws_uri.port)
            # Initialize WebSocket connection.
            _, connection = await loop.create_connection(factory, **kwargs)
        return connection

    def process_redirect(self, exc: Exception) -> Exception | str:
        """
        Determine whether a connection error is a redirect that can be followed.

        Return the new URI if it's a valid redirect. Else, return an exception.

        """
        if not (
            isinstance(exc, InvalidStatus)
            and exc.response.status_code
            in [
                300,  # Multiple Choices
                301,  # Moved Permanently
                302,  # Found
                303,  # See Other
                307,  # Temporary Redirect
                308,  # Permanent Redirect
            ]
            and "Location" in exc.response.headers
        ):
            return exc

        old_ws_uri = parse_uri(self.uri)
        new_uri = urllib.parse.urljoin(self.uri, exc.response.headers["Location"])
        new_ws_uri = parse_uri(new_uri)

        # If connect() received a socket, it is closed and cannot be reused.
        if self.connection_kwargs.get("sock") is not None:
            return ValueError(
                f"cannot follow redirect to {new_uri} with a preexisting socket"
            )

        # TLS downgrade is forbidden.
        if old_ws_uri.secure and not new_ws_uri.secure:
            return SecurityError(f"cannot follow redirect to non-secure URI {new_uri}")

        # Apply restrictions to cross-origin redirects.
        if (
            old_ws_uri.secure != new_ws_uri.secure
            or old_ws_uri.host != new_ws_uri.host
            or old_ws_uri.port != new_ws_uri.port
        ):
            # Cross-origin redirects on Unix sockets don't quite make sense.
            if self.connection_kwargs.get("unix", False):
                return ValueError(
                    f"cannot follow cross-origin redirect to {new_uri} "
                    f"with a Unix socket"
                )

            # Cross-origin redirects when host and port are overridden are ill-defined.
            if (
                self.connection_kwargs.get("host") is not None
                or self.connection_kwargs.get("port") is not None
            ):
                return ValueError(
                    f"cannot follow cross-origin redirect to {new_uri} "
                    f"with an explicit host or port"
                )

        return new_uri

    # ... = await connect(...)

    def __await__(self) -> Generator[Any, None, ClientConnection]:
        # Create a suitable iterator by calling __await__ on a coroutine.
        return self.__await_impl__().__await__()

    async def __await_impl__(self) -> ClientConnection:
        try:
            async with asyncio_timeout(self.open_timeout):
                for _ in range(MAX_REDIRECTS):
                    self.connection = await self.create_connection()
                    try:
                        await self.connection.handshake(
                            self.additional_headers,
                            self.user_agent_header,
                        )
                    except asyncio.CancelledError:
                        self.connection.transport.abort()
                        raise
                    except Exception as exc:
                        # Always close the connection even though keep-alive is
                        # the default in HTTP/1.1 because create_connection ties
                        # opening the network connection with initializing the
                        # protocol. In the current design of connect(), there is
                        # no easy way to reuse the network connection that works
                        # in every case nor to reinitialize the protocol.
                        self.connection.transport.abort()

                        uri_or_exc = self.process_redirect(exc)
                        # Response is a valid redirect; follow it.
                        if isinstance(uri_or_exc, str):
                            self.uri = uri_or_exc
                            continue
                        # Response isn't a valid redirect; raise the exception.
                        if uri_or_exc is exc:
                            raise
                        else:
                            raise uri_or_exc from exc

                    else:
                        self.connection.start_keepalive()
                        return self.connection
                else:
                    raise SecurityError(f"more than {MAX_REDIRECTS} redirects")

        except TimeoutError as exc:
            # Re-raise exception with an informative error message.
            raise TimeoutError("timed out during opening handshake") from exc

    # ... = yield from connect(...) - remove when dropping Python < 3.11

    __iter__ = __await__

    # async with connect(...) as ...: ...

    async def __aenter__(self) -> ClientConnection:
        return await self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        await self.connection.close()

    # async for ... in connect(...):

    async def __aiter__(self) -> AsyncIterator[ClientConnection]:
        delays: Generator[float] | None = None
        while True:
            try:
                async with self as protocol:
                    yield protocol
            except Exception as exc:
                # Determine whether the exception is retryable or fatal.
                # The API of process_exception is "return an exception or None";
                # "raise an exception" is also supported because it's a frequent
                # mistake. It isn't documented in order to keep the API simple.
                try:
                    new_exc = self.process_exception(exc)
                except Exception as raised_exc:
                    new_exc = raised_exc

                # The connection failed with a fatal error.
                # Raise the exception and exit the loop.
                if new_exc is exc:
                    raise
                if new_exc is not None:
                    raise new_exc from exc

                # The connection failed with a retryable error.
                # Start or continue backoff and reconnect.
                if delays is None:
                    delays = backoff()
                delay = next(delays)
                self.logger.info(
                    "connect failed; reconnecting in %.1f seconds: %s",
                    delay,
                    traceback.format_exception_only(exc)[0].strip(),
                )
                await asyncio.sleep(delay)
                continue

            else:
                # The connection succeeded. Reset backoff.
                delays = None


def unix_connect(
    path: str | None = None,
    uri: str | None = None,
    **kwargs: Any,
) -> connect:
    """
    Connect to a WebSocket server listening on a Unix socket.

    This function accepts the same keyword arguments as :func:`connect`.

    It's only available on Unix.

    It's mainly useful for debugging servers listening on Unix sockets.

    Args:
        path: File system path to the Unix socket.
        uri: URI of the WebSocket server. ``uri`` defaults to
            ``ws://localhost/`` or, when a ``ssl`` argument is provided, to
            ``wss://localhost/``.

    """
    if uri is None:
        if kwargs.get("ssl") is None:
            uri = "ws://localhost/"
        else:
            uri = "wss://localhost/"
    return connect(uri=uri, unix=True, path=path, **kwargs)


try:
    from python_socks import ProxyType
    from python_socks.async_.asyncio import Proxy as SocksProxy

except ImportError:

    async def connect_socks_proxy(
        proxy: Proxy,
        ws_uri: WebSocketURI,
        **kwargs: Any,
    ) -> socket.socket:
        raise ImportError("connecting through a SOCKS proxy requires python-socks")

else:
    SOCKS_PROXY_TYPES = {
        "socks5h": ProxyType.SOCKS5,
        "socks5": ProxyType.SOCKS5,
        "socks4a": ProxyType.SOCKS4,
        "socks4": ProxyType.SOCKS4,
    }

    SOCKS_PROXY_RDNS = {
        "socks5h": True,
        "socks5": False,
        "socks4a": True,
        "socks4": False,
    }

    async def connect_socks_proxy(
        proxy: Proxy,
        ws_uri: WebSocketURI,
        **kwargs: Any,
    ) -> socket.socket:
        """Connect via a SOCKS proxy and return the socket."""
        socks_proxy = SocksProxy(
            SOCKS_PROXY_TYPES[proxy.scheme],
            proxy.host,
            proxy.port,
            proxy.username,
            proxy.password,
            SOCKS_PROXY_RDNS[proxy.scheme],
        )
        # connect() is documented to raise OSError.
        # socks_proxy.connect() doesn't raise TimeoutError; it gets canceled.
        # Wrap other exceptions in ProxyError, a subclass of InvalidHandshake.
        try:
            return await socks_proxy.connect(ws_uri.host, ws_uri.port, **kwargs)
        except OSError:
            raise
        except Exception as exc:
            raise ProxyError("failed to connect to SOCKS proxy") from exc


class HTTPProxyConnection(asyncio.Protocol):
    def __init__(
        self,
        ws_uri: WebSocketURI,
        proxy: Proxy,
        user_agent_header: str | None = None,
    ):
        self.ws_uri = ws_uri
        self.proxy = proxy
        self.user_agent_header = user_agent_header

        self.reader = StreamReader()
        self.parser = Response.parse(
            self.reader.read_line,
            self.reader.read_exact,
            self.reader.read_to_eof,
            proxy=True,
        )

        loop = asyncio.get_running_loop()
        self.response: asyncio.Future[Response] = loop.create_future()

    def run_parser(self) -> None:
        try:
            next(self.parser)
        except StopIteration as exc:
            response = exc.value
            if 200 <= response.status_code < 300:
                self.response.set_result(response)
            else:
                self.response.set_exception(InvalidProxyStatus(response))
        except Exception as exc:
            proxy_exc = InvalidProxyMessage(
                "did not receive a valid HTTP response from proxy"
            )
            proxy_exc.__cause__ = exc
            self.response.set_exception(proxy_exc)

    def connection_made(self, transport: asyncio.BaseTransport) -> None:
        transport = cast(asyncio.Transport, transport)
        self.transport = transport
        self.transport.write(
            prepare_connect_request(self.proxy, self.ws_uri, self.user_agent_header)
        )

    def data_received(self, data: bytes) -> None:
        self.reader.feed_data(data)
        self.run_parser()

    def eof_received(self) -> None:
        self.reader.feed_eof()
        self.run_parser()

    def connection_lost(self, exc: Exception | None) -> None:
        self.reader.feed_eof()
        if exc is not None:
            self.response.set_exception(exc)


async def connect_http_proxy(
    proxy: Proxy,
    ws_uri: WebSocketURI,
    user_agent_header: str | None = None,
    **kwargs: Any,
) -> asyncio.Transport:
    transport, protocol = await asyncio.get_running_loop().create_connection(
        lambda: HTTPProxyConnection(ws_uri, proxy, user_agent_header),
        proxy.host,
        proxy.port,
        **kwargs,
    )

    try:
        # This raises exceptions if the connection to the proxy fails.
        await protocol.response
    except Exception:
        transport.close()
        raise

    return transport
