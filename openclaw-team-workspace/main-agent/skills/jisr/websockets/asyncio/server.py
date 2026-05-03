from __future__ import annotations

import asyncio
import hmac
import http
import logging
import re
import socket
import sys
from collections.abc import Awaitable, Generator, Iterable, Sequence
from types import TracebackType
from typing import Any, Callable, Mapping, cast

from ..exceptions import InvalidHeader
from ..extensions.base import ServerExtensionFactory
from ..extensions.permessage_deflate import enable_server_permessage_deflate
from ..frames import CloseCode
from ..headers import (
    build_www_authenticate_basic,
    parse_authorization_basic,
    validate_subprotocols,
)
from ..http11 import SERVER, Request, Response
from ..protocol import CONNECTING, OPEN, Event
from ..server import ServerProtocol
from ..typing import LoggerLike, Origin, StatusLike, Subprotocol
from .compatibility import asyncio_timeout
from .connection import Connection, broadcast


__all__ = [
    "broadcast",
    "serve",
    "unix_serve",
    "ServerConnection",
    "Server",
    "basic_auth",
]


class ServerConnection(Connection):
    """
    :mod:`asyncio` implementation of a WebSocket server connection.

    :class:`ServerConnection` provides :meth:`recv` and :meth:`send` methods for
    receiving and sending messages.

    It supports asynchronous iteration to receive messages::

        async for message in websocket:
            await process(message)

    The iterator exits normally when the connection is closed with code
    1000 (OK) or 1001 (going away) or without a close code. It raises a
    :exc:`~websockets.exceptions.ConnectionClosedError` when the connection is
    closed with any other code.

    The ``ping_interval``, ``ping_timeout``, ``close_timeout``, ``max_queue``,
    and ``write_limit`` arguments have the same meaning as in :func:`serve`.

    Args:
        protocol: Sans-I/O connection.
        server: Server that manages this connection.

    """

    def __init__(
        self,
        protocol: ServerProtocol,
        server: Server,
        *,
        ping_interval: float | None = 20,
        ping_timeout: float | None = 20,
        close_timeout: float | None = 10,
        max_queue: int | None | tuple[int | None, int | None] = 16,
        write_limit: int | tuple[int, int | None] = 2**15,
    ) -> None:
        self.protocol: ServerProtocol
        super().__init__(
            protocol,
            ping_interval=ping_interval,
            ping_timeout=ping_timeout,
            close_timeout=close_timeout,
            max_queue=max_queue,
            write_limit=write_limit,
        )
        self.server = server
        self.request_rcvd: asyncio.Future[None] = self.loop.create_future()
        self.username: str  # see basic_auth()
        self.handler: Callable[[ServerConnection], Awaitable[None]]  # see route()
        self.handler_kwargs: Mapping[str, Any]  # see route()

    def respond(self, status: StatusLike, text: str) -> Response:
        """
        Create a plain text HTTP response.

        ``process_request`` and ``process_response`` may call this method to
        return an HTTP response instead of performing the WebSocket opening
        handshake.

        You can modify the response before returning it, for example by changing
        HTTP headers.

        Args:
            status: HTTP status code.
            text: HTTP response body; it will be encoded to UTF-8.

        Returns:
            HTTP response to send to the client.

        """
        return self.protocol.reject(status, text)

    async def handshake(
        self,
        process_request: (
            Callable[
                [ServerConnection, Request],
                Awaitable[Response | None] | Response | None,
            ]
            | None
        ) = None,
        process_response: (
            Callable[
                [ServerConnection, Request, Response],
                Awaitable[Response | None] | Response | None,
            ]
            | None
        ) = None,
        server_header: str | None = SERVER,
    ) -> None:
        """
        Perform the opening handshake.

        """
        await asyncio.wait(
            [self.request_rcvd, self.connection_lost_waiter],
            return_when=asyncio.FIRST_COMPLETED,
        )

        if self.request is not None:
            async with self.send_context(expected_state=CONNECTING):
                response = None

                if process_request is not None:
                    try:
                        response = process_request(self, self.request)
                        if isinstance(response, Awaitable):
                            response = await response
                    except Exception as exc:
                        self.protocol.handshake_exc = exc
                        response = self.protocol.reject(
                            http.HTTPStatus.INTERNAL_SERVER_ERROR,
                            (
                                "Failed to open a WebSocket connection.\n"
                                "See server log for more information.\n"
                            ),
                        )

                if response is None:
                    if self.server.is_serving():
                        self.response = self.protocol.accept(self.request)
                    else:
                        self.response = self.protocol.reject(
                            http.HTTPStatus.SERVICE_UNAVAILABLE,
                            "Server is shutting down.\n",
                        )
                else:
                    assert isinstance(response, Response)  # help mypy
                    self.response = response

                if server_header:
                    self.response.headers["Server"] = server_header

                response = None

                if process_response is not None:
                    try:
                        response = process_response(self, self.request, self.response)
                        if isinstance(response, Awaitable):
                            response = await response
                    except Exception as exc:
                        self.protocol.handshake_exc = exc
                        response = self.protocol.reject(
                            http.HTTPStatus.INTERNAL_SERVER_ERROR,
                            (
                                "Failed to open a WebSocket connection.\n"
                                "See server log for more information.\n"
                            ),
                        )

                if response is not None:
                    assert isinstance(response, Response)  # help mypy
                    self.response = response

                self.protocol.send_response(self.response)

        # self.protocol.handshake_exc is set when the connection is lost before
        # receiving a request, when the request cannot be parsed, or when the
        # handshake fails, including when process_request or process_response
        # raises an exception.

        # It isn't set when process_request or process_response sends an HTTP
        # response that rejects the handshake.

        if self.protocol.handshake_exc is not None:
            raise self.protocol.handshake_exc

    def process_event(self, event: Event) -> None:
        """
        Process one incoming event.

        """
        # First event - handshake request.
        if self.request is None:
            assert isinstance(event, Request)
            self.request = event
            self.request_rcvd.set_result(None)
        # Later events - frames.
        else:
            super().process_event(event)

    def connection_made(self, transport: asyncio.BaseTransport) -> None:
        super().connection_made(transport)
        self.server.start_connection_handler(self)


class Server:
    """
    WebSocket server returned by :func:`serve`.

    This class mirrors the API of :class:`asyncio.Server`.

    It keeps track of WebSocket connections in order to close them properly
    when shutting down.

    Args:
        handler: Connection handler. It receives the WebSocket connection,
            which is a :class:`ServerConnection`, in argument.
        process_request: Intercept the request during the opening handshake.
            Return an HTTP response to force the response. Return :obj:`None` to
            continue normally. When you force an HTTP 101 Continue response, the
            handshake is successful. Else, the connection is aborted.
            ``process_request`` may be a function or a coroutine.
        process_response: Intercept the response during the opening handshake.
            Modify the response or return a new HTTP response to force the
            response. Return :obj:`None` to continue normally. When you force an
            HTTP 101 Continue response, the handshake is successful. Else, the
            connection is aborted. ``process_response`` may be a function or a
            coroutine.
        server_header: Value of  the ``Server`` response header.
            It defaults to ``"Python/x.y.z websockets/X.Y"``. Setting it to
            :obj:`None` removes the header.
        open_timeout: Timeout for opening connections in seconds.
            :obj:`None` disables the timeout.
        logger: Logger for this server.
            It defaults to ``logging.getLogger("websockets.server")``.
            See the :doc:`logging guide <../../topics/logging>` for details.

    """

    def __init__(
        self,
        handler: Callable[[ServerConnection], Awaitable[None]],
        *,
        process_request: (
            Callable[
                [ServerConnection, Request],
                Awaitable[Response | None] | Response | None,
            ]
            | None
        ) = None,
        process_response: (
            Callable[
                [ServerConnection, Request, Response],
                Awaitable[Response | None] | Response | None,
            ]
            | None
        ) = None,
        server_header: str | None = SERVER,
        open_timeout: float | None = 10,
        logger: LoggerLike | None = None,
    ) -> None:
        self.loop = asyncio.get_running_loop()
        self.handler = handler
        self.process_request = process_request
        self.process_response = process_response
        self.server_header = server_header
        self.open_timeout = open_timeout
        if logger is None:
            logger = logging.getLogger("websockets.server")
        self.logger = logger

        # Keep track of active connections.
        self.handlers: dict[ServerConnection, asyncio.Task[None]] = {}

        # Task responsible for closing the server and terminating connections.
        self.close_task: asyncio.Task[None] | None = None

        # Completed when the server is closed and connections are terminated.
        self.closed_waiter: asyncio.Future[None] = self.loop.create_future()

    @property
    def connections(self) -> set[ServerConnection]:
        """
        Set of active connections.

        This property contains all connections that completed the opening
        handshake successfully and didn't start the closing handshake yet.
        It can be useful in combination with :func:`~broadcast`.

        """
        return {connection for connection in self.handlers if connection.state is OPEN}

    def wrap(self, server: asyncio.Server) -> None:
        """
        Attach to a given :class:`asyncio.Server`.

        Since :meth:`~asyncio.loop.create_server` doesn't support injecting a
        custom ``Server`` class, the easiest solution that doesn't rely on
        private :mod:`asyncio` APIs is to:

        - instantiate a :class:`Server`
        - give the protocol factory a reference to that instance
        - call :meth:`~asyncio.loop.create_server` with the factory
        - attach the resulting :class:`asyncio.Server` with this method

        """
        self.server = server
        for sock in server.sockets:
            if sock.family == socket.AF_INET:
                name = "%s:%d" % sock.getsockname()
            elif sock.family == socket.AF_INET6:
                name = "[%s]:%d" % sock.getsockname()[:2]
            elif sock.family == socket.AF_UNIX:
                name = sock.getsockname()
            # In the unlikely event that someone runs websockets over a
            # protocol other than IP or Unix sockets, avoid crashing.
            else:  # pragma: no cover
                name = str(sock.getsockname())
            self.logger.info("server listening on %s", name)

    async def conn_handler(self, connection: ServerConnection) -> None:
        """
        Handle the lifecycle of a WebSocket connection.

        Since this method doesn't have a caller that can handle exceptions,
        it attempts to log relevant ones.

        It guarantees that the TCP connection is closed before exiting.

        """
        try:
            async with asyncio_timeout(self.open_timeout):
                try:
                    await connection.handshake(
                        self.process_request,
                        self.process_response,
                        self.server_header,
                    )
                except asyncio.CancelledError:
                    connection.transport.abort()
                    raise
                except Exception:
                    connection.logger.error("opening handshake failed", exc_info=True)
                    connection.transport.abort()
                    return

            if connection.protocol.state is not OPEN:
                # process_request or process_response rejected the handshake.
                connection.transport.abort()
                return

            try:
                connection.start_keepalive()
                await self.handler(connection)
            except Exception:
                connection.logger.error("connection handler failed", exc_info=True)
                await connection.close(CloseCode.INTERNAL_ERROR)
            else:
                await connection.close()

        except TimeoutError:
            # When the opening handshake times out, there's nothing to log.
            pass

        except Exception:  # pragma: no cover
            # Don't leak connections on unexpected errors.
            connection.transport.abort()

        finally:
            # Registration is tied to the lifecycle of conn_handler() because
            # the server waits for connection handlers to terminate, even if
            # all connections are already closed.
            del self.handlers[connection]

    def start_connection_handler(self, connection: ServerConnection) -> None:
        """
        Register a connection with this server.

        """
        # The connection must be registered in self.handlers immediately.
        # If it was registered in conn_handler(), a race condition could
        # happen when closing the server after scheduling conn_handler()
        # but before it starts executing.
        self.handlers[connection] = self.loop.create_task(self.conn_handler(connection))

    def close(
        self,
        close_connections: bool = True,
        code: CloseCode | int = CloseCode.GOING_AWAY,
        reason: str = "",
    ) -> None:
        """
        Close the server.

        * Close the underlying :class:`asyncio.Server`.
        * When ``close_connections`` is :obj:`True`, which is the default, close
          existing connections. Specifically:

          * Reject opening WebSocket connections with an HTTP 503 (service
            unavailable) error. This happens when the server accepted the TCP
            connection but didn't complete the opening handshake before closing.
          * Close open WebSocket connections with code 1001 (going away).
            ``code`` and ``reason`` can be customized, for example to use code
            1012 (service restart).

        * Wait until all connection handlers terminate.

        :meth:`close` is idempotent.

        """
        if self.close_task is None:
            self.close_task = self.get_loop().create_task(
                self._close(close_connections, code, reason)
            )

    async def _close(
        self,
        close_connections: bool = True,
        code: CloseCode | int = CloseCode.GOING_AWAY,
        reason: str = "",
    ) -> None:
        """
        Implementation of :meth:`close`.

        This calls :meth:`~asyncio.Server.close` on the underlying
        :class:`asyncio.Server` object to stop accepting new connections and
        then closes open connections.

        """
        self.logger.info("server closing")

        # Stop accepting new connections.
        self.server.close()

        # Wait until all accepted connections reach connection_made() and call
        # register(). See https://github.com/python/cpython/issues/79033 for
        # details. This workaround can be removed when dropping Python < 3.11.
        await asyncio.sleep(0)

        # After server.close(), handshake() closes OPENING connections with an
        # HTTP 503 error.

        if close_connections:
            # Close OPEN connections with code 1001 by default.
            close_tasks = [
                asyncio.create_task(connection.close(code, reason))
                for connection in self.handlers
                if connection.protocol.state is not CONNECTING
            ]
            # asyncio.wait doesn't accept an empty first argument.
            if close_tasks:
                await asyncio.wait(close_tasks)

        # Wait until all TCP connections are closed.
        await self.server.wait_closed()

        # Wait until all connection handlers terminate.
        # asyncio.wait doesn't accept an empty first argument.
        if self.handlers:
            await asyncio.wait(self.handlers.values())

        # Tell wait_closed() to return.
        self.closed_waiter.set_result(None)

        self.logger.info("server closed")

    async def wait_closed(self) -> None:
        """
        Wait until the server is closed.

        When :meth:`wait_closed` returns, all TCP connections are closed and
        all connection handlers have returned.

        To ensure a fast shutdown, a connection handler should always be
        awaiting at least one of:

        * :meth:`~ServerConnection.recv`: when the connection is closed,
          it raises :exc:`~websockets.exceptions.ConnectionClosedOK`;
        * :meth:`~ServerConnection.wait_closed`: when the connection is
          closed, it returns.

        Then the connection handler is immediately notified of the shutdown;
        it can clean up and exit.

        """
        await asyncio.shield(self.closed_waiter)

    def get_loop(self) -> asyncio.AbstractEventLoop:
        """
        See :meth:`asyncio.Server.get_loop`.

        """
        return self.server.get_loop()

    def is_serving(self) -> bool:  # pragma: no cover
        """
        See :meth:`asyncio.Server.is_serving`.

        """
        return self.server.is_serving()

    async def start_serving(self) -> None:  # pragma: no cover
        """
        See :meth:`asyncio.Server.start_serving`.

        Typical use::

            server = await serve(..., start_serving=False)
            # perform additional setup here...
            # ... then start the server
            await server.start_serving()

        """
        await self.server.start_serving()

    async def serve_forever(self) -> None:  # pragma: no cover
        """
        See :meth:`asyncio.Server.serve_forever`.

        Typical use::

            server = await serve(...)
            # this coroutine doesn't return
            # canceling it stops the server
            await server.serve_forever()

        This is an alternative to using :func:`serve` as an asynchronous context
        manager. Shutdown is triggered by canceling :meth:`serve_forever`
        instead of exiting a :func:`serve` context.

        """
        await self.server.serve_forever()

    @property
    def sockets(self) -> tuple[socket.socket, ...]:
        """
        See :attr:`asyncio.Server.sockets`.

        """
        return self.server.sockets

    async def __aenter__(self) -> Server:  # pragma: no cover
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:  # pragma: no cover
        self.close()
        await self.wait_closed()


# This is spelled in lower case because it's exposed as a callable in the API.
class serve:
    """
    Create a WebSocket server listening on ``host`` and ``port``.

    Whenever a client connects, the server creates a :class:`ServerConnection`,
    performs the opening handshake, and delegates to the ``handler`` coroutine.

    The handler receives the :class:`ServerConnection` instance, which you can
    use to send and receive messages.

    Once the handler completes, either normally or with an exception, the server
    performs the closing handshake and closes the connection.

    This coroutine returns a :class:`Server` whose API mirrors
    :class:`asyncio.Server`. Treat it as an asynchronous context manager to
    ensure that the server will be closed::

        from websockets.asyncio.server import serve

        def handler(websocket):
            ...

        # set this future to exit the server
        stop = asyncio.get_running_loop().create_future()

        async with serve(handler, host, port):
            await stop

    Alternatively, call :meth:`~Server.serve_forever` to serve requests and
    cancel it to stop the server::

        server = await serve(handler, host, port)
        await server.serve_forever()

    Args:
        handler: Connection handler. It receives the WebSocket connection,
            which is a :class:`ServerConnection`, in argument.
        host: Network interfaces the server binds to.
            See :meth:`~asyncio.loop.create_server` for details.
        port: TCP port the server listens on.
            See :meth:`~asyncio.loop.create_server` for details.
        origins: Acceptable values of the ``Origin`` header, for defending
            against Cross-Site WebSocket Hijacking attacks. Values can be
            :class:`str` to test for an exact match or regular expressions
            compiled by :func:`re.compile` to test against a pattern. Include
            :obj:`None` in the list if the lack of an origin is acceptable.
        extensions: List of supported extensions, in order in which they
            should be negotiated and run.
        subprotocols: List of supported subprotocols, in order of decreasing
            preference.
        select_subprotocol: Callback for selecting a subprotocol among
            those supported by the client and the server. It receives a
            :class:`ServerConnection` (not a
            :class:`~websockets.server.ServerProtocol`!) instance and a list of
            subprotocols offered by the client. Other than the first argument,
            it has the same behavior as the
            :meth:`ServerProtocol.select_subprotocol
            <websockets.server.ServerProtocol.select_subprotocol>` method.
        compression: The "permessage-deflate" extension is enabled by default.
            Set ``compression`` to :obj:`None` to disable it. See the
            :doc:`compression guide <../../topics/compression>` for details.
        process_request: Intercept the request during the opening handshake.
            Return an HTTP response to force the response or :obj:`None` to
            continue normally. When you force an HTTP 101 Continue response, the
            handshake is successful. Else, the connection is aborted.
            ``process_request`` may be a function or a coroutine.
        process_response: Intercept the response during the opening handshake.
            Return an HTTP response to force the response or :obj:`None` to
            continue normally. When you force an HTTP 101 Continue response, the
            handshake is successful. Else, the connection is aborted.
            ``process_response`` may be a function or a coroutine.
        server_header: Value of  the ``Server`` response header.
            It defaults to ``"Python/x.y.z websockets/X.Y"``. Setting it to
            :obj:`None` removes the header.
        open_timeout: Timeout for opening connections in seconds.
            :obj:`None` disables the timeout.
        ping_interval: Interval between keepalive pings in seconds.
            :obj:`None` disables keepalive.
        ping_timeout: Timeout for keepalive pings in seconds.
            :obj:`None` disables timeouts.
        close_timeout: Timeout for closing connections in seconds.
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
        logger: Logger for this server.
            It defaults to ``logging.getLogger("websockets.server")``. See the
            :doc:`logging guide <../../topics/logging>` for details.
        create_connection: Factory for the :class:`ServerConnection` managing
            the connection. Set it to a wrapper or a subclass to customize
            connection handling.

    Any other keyword arguments are passed to the event loop's
    :meth:`~asyncio.loop.create_server` method.

    For example:

    * You can set ``ssl`` to a :class:`~ssl.SSLContext` to enable TLS.

    * You can set ``sock`` to provide a preexisting TCP socket. You may call
      :func:`socket.create_server` (not to be confused with the event loop's
      :meth:`~asyncio.loop.create_server` method) to create a suitable server
      socket and customize it.

    * You can set ``start_serving`` to ``False`` to start accepting connections
      only after you call :meth:`~Server.start_serving()` or
      :meth:`~Server.serve_forever()`.

    """

    def __init__(
        self,
        handler: Callable[[ServerConnection], Awaitable[None]],
        host: str | None = None,
        port: int | None = None,
        *,
        # WebSocket
        origins: Sequence[Origin | re.Pattern[str] | None] | None = None,
        extensions: Sequence[ServerExtensionFactory] | None = None,
        subprotocols: Sequence[Subprotocol] | None = None,
        select_subprotocol: (
            Callable[
                [ServerConnection, Sequence[Subprotocol]],
                Subprotocol | None,
            ]
            | None
        ) = None,
        compression: str | None = "deflate",
        # HTTP
        process_request: (
            Callable[
                [ServerConnection, Request],
                Awaitable[Response | None] | Response | None,
            ]
            | None
        ) = None,
        process_response: (
            Callable[
                [ServerConnection, Request, Response],
                Awaitable[Response | None] | Response | None,
            ]
            | None
        ) = None,
        server_header: str | None = SERVER,
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
        create_connection: type[ServerConnection] | None = None,
        # Other keyword arguments are passed to loop.create_server
        **kwargs: Any,
    ) -> None:
        if subprotocols is not None:
            validate_subprotocols(subprotocols)

        if compression == "deflate":
            extensions = enable_server_permessage_deflate(extensions)
        elif compression is not None:
            raise ValueError(f"unsupported compression: {compression}")

        if create_connection is None:
            create_connection = ServerConnection

        self.server = Server(
            handler,
            process_request=process_request,
            process_response=process_response,
            server_header=server_header,
            open_timeout=open_timeout,
            logger=logger,
        )

        if kwargs.get("ssl") is not None:
            kwargs.setdefault("ssl_handshake_timeout", open_timeout)
            if sys.version_info[:2] >= (3, 11):  # pragma: no branch
                kwargs.setdefault("ssl_shutdown_timeout", close_timeout)

        def factory() -> ServerConnection:
            """
            Create an asyncio protocol for managing a WebSocket connection.

            """
            # Create a closure to give select_subprotocol access to connection.
            protocol_select_subprotocol: (
                Callable[
                    [ServerProtocol, Sequence[Subprotocol]],
                    Subprotocol | None,
                ]
                | None
            ) = None
            if select_subprotocol is not None:

                def protocol_select_subprotocol(
                    protocol: ServerProtocol,
                    subprotocols: Sequence[Subprotocol],
                ) -> Subprotocol | None:
                    # mypy doesn't know that select_subprotocol is immutable.
                    assert select_subprotocol is not None
                    # Ensure this function is only used in the intended context.
                    assert protocol is connection.protocol
                    return select_subprotocol(connection, subprotocols)

            # This is a protocol in the Sans-I/O implementation of websockets.
            protocol = ServerProtocol(
                origins=origins,
                extensions=extensions,
                subprotocols=subprotocols,
                select_subprotocol=protocol_select_subprotocol,
                max_size=max_size,
                logger=logger,
            )
            # This is a connection in websockets and a protocol in asyncio.
            connection = create_connection(
                protocol,
                self.server,
                ping_interval=ping_interval,
                ping_timeout=ping_timeout,
                close_timeout=close_timeout,
                max_queue=max_queue,
                write_limit=write_limit,
            )
            return connection

        loop = asyncio.get_running_loop()
        if kwargs.pop("unix", False):
            self.create_server = loop.create_unix_server(factory, **kwargs)
        else:
            # mypy cannot tell that kwargs must provide sock when port is None.
            self.create_server = loop.create_server(factory, host, port, **kwargs)  # type: ignore[arg-type]

    # async with serve(...) as ...: ...

    async def __aenter__(self) -> Server:
        return await self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self.server.close()
        await self.server.wait_closed()

    # ... = await serve(...)

    def __await__(self) -> Generator[Any, None, Server]:
        # Create a suitable iterator by calling __await__ on a coroutine.
        return self.__await_impl__().__await__()

    async def __await_impl__(self) -> Server:
        server = await self.create_server
        self.server.wrap(server)
        return self.server

    # ... = yield from serve(...) - remove when dropping Python < 3.11

    __iter__ = __await__


def unix_serve(
    handler: Callable[[ServerConnection], Awaitable[None]],
    path: str | None = None,
    **kwargs: Any,
) -> Awaitable[Server]:
    """
    Create a WebSocket server listening on a Unix socket.

    This function is identical to :func:`serve`, except the ``host`` and
    ``port`` arguments are replaced by ``path``. It's only available on Unix.

    It's useful for deploying a server behind a reverse proxy such as nginx.

    Args:
        handler: Connection handler. It receives the WebSocket connection,
            which is a :class:`ServerConnection`, in argument.
        path: File system path to the Unix socket.

    """
    return serve(handler, unix=True, path=path, **kwargs)


def is_credentials(credentials: Any) -> bool:
    try:
        username, password = credentials
    except (TypeError, ValueError):
        return False
    else:
        return isinstance(username, str) and isinstance(password, str)


def basic_auth(
    realm: str = "",
    credentials: tuple[str, str] | Iterable[tuple[str, str]] | None = None,
    check_credentials: Callable[[str, str], Awaitable[bool] | bool] | None = None,
) -> Callable[[ServerConnection, Request], Awaitable[Response | None]]:
    """
    Factory for ``process_request`` to enforce HTTP Basic Authentication.

    :func:`basic_auth` is designed to integrate with :func:`serve` as follows::

        from websockets.asyncio.server import basic_auth, serve

        async with serve(
            ...,
            process_request=basic_auth(
                realm="my dev server",
                credentials=("hello", "iloveyou"),
            ),
        ):

    If authentication succeeds, the connection's ``username`` attribute is set.
    If it fails, the server responds with an HTTP 401 Unauthorized status.

    One of ``credentials`` or ``check_credentials`` must be provided; not both.

    Args:
        realm: Scope of protection. It should contain only ASCII characters
            because the encoding of non-ASCII characters is undefined. Refer to
            section 2.2 of :rfc:`7235` for details.
        credentials: Hard coded authorized credentials. It can be a
            ``(username, password)`` pair or a list of such pairs.
        check_credentials: Function or coroutine that verifies credentials.
            It receives ``username`` and ``password`` arguments and returns
            whether they're valid.
    Raises:
        TypeError: If ``credentials`` or ``check_credentials`` is wrong.
        ValueError: If ``credentials`` and ``check_credentials`` are both
            provided or both not provided.

    """
    if (credentials is None) == (check_credentials is None):
        raise ValueError("provide either credentials or check_credentials")

    if credentials is not None:
        if is_credentials(credentials):
            credentials_list = [cast(tuple[str, str], credentials)]
        elif isinstance(credentials, Iterable):
            credentials_list = list(cast(Iterable[tuple[str, str]], credentials))
            if not all(is_credentials(item) for item in credentials_list):
                raise TypeError(f"invalid credentials argument: {credentials}")
        else:
            raise TypeError(f"invalid credentials argument: {credentials}")

        credentials_dict = dict(credentials_list)

        def check_credentials(username: str, password: str) -> bool:
            try:
                expected_password = credentials_dict[username]
            except KeyError:
                return False
            return hmac.compare_digest(expected_password, password)

    assert check_credentials is not None  # help mypy

    async def process_request(
        connection: ServerConnection,
        request: Request,
    ) -> Response | None:
        """
        Perform HTTP Basic Authentication.

        If it succeeds, set the connection's ``username`` attribute and return
        :obj:`None`. If it fails, return an HTTP 401 Unauthorized responss.

        """
        try:
            authorization = request.headers["Authorization"]
        except KeyError:
            response = connection.respond(
                http.HTTPStatus.UNAUTHORIZED,
                "Missing credentials\n",
            )
            response.headers["WWW-Authenticate"] = build_www_authenticate_basic(realm)
            return response

        try:
            username, password = parse_authorization_basic(authorization)
        except InvalidHeader:
            response = connection.respond(
                http.HTTPStatus.UNAUTHORIZED,
                "Unsupported credentials\n",
            )
            response.headers["WWW-Authenticate"] = build_www_authenticate_basic(realm)
            return response

        valid_credentials = check_credentials(username, password)
        if isinstance(valid_credentials, Awaitable):
            valid_credentials = await valid_credentials

        if not valid_credentials:
            response = connection.respond(
                http.HTTPStatus.UNAUTHORIZED,
                "Invalid credentials\n",
            )
            response.headers["WWW-Authenticate"] = build_www_authenticate_basic(realm)
            return response

        connection.username = username
        return None

    return process_request
