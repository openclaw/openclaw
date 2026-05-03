from __future__ import annotations

import asyncio
import email.utils
import functools
import http
import inspect
import logging
import socket
import warnings
from collections.abc import Awaitable, Generator, Iterable, Sequence
from types import TracebackType
from typing import Any, Callable, cast

from ..asyncio.compatibility import asyncio_timeout
from ..datastructures import Headers, HeadersLike, MultipleValuesError
from ..exceptions import (
    InvalidHandshake,
    InvalidHeader,
    InvalidMessage,
    InvalidOrigin,
    InvalidUpgrade,
    NegotiationError,
)
from ..extensions import Extension, ServerExtensionFactory
from ..extensions.permessage_deflate import enable_server_permessage_deflate
from ..headers import (
    build_extension,
    parse_extension,
    parse_subprotocol,
    validate_subprotocols,
)
from ..http11 import SERVER
from ..protocol import State
from ..typing import ExtensionHeader, LoggerLike, Origin, StatusLike, Subprotocol
from .exceptions import AbortHandshake
from .handshake import build_response, check_request
from .http import read_request
from .protocol import WebSocketCommonProtocol, broadcast


__all__ = [
    "broadcast",
    "serve",
    "unix_serve",
    "WebSocketServerProtocol",
    "WebSocketServer",
]


HeadersLikeOrCallable = HeadersLike | Callable[[str, Headers], HeadersLike]

HTTPResponse = tuple[StatusLike, HeadersLike, bytes]


class WebSocketServerProtocol(WebSocketCommonProtocol):
    """
    WebSocket server connection.

    :class:`WebSocketServerProtocol` provides :meth:`recv` and :meth:`send`
    coroutines for receiving and sending messages.

    It supports asynchronous iteration to receive messages::

        async for message in websocket:
            await process(message)

    The iterator exits normally when the connection is closed with close code
    1000 (OK) or 1001 (going away) or without a close code. It raises
    a :exc:`~websockets.exceptions.ConnectionClosedError` when the connection
    is closed with any other code.

    You may customize the opening handshake in a subclass by
    overriding :meth:`process_request` or :meth:`select_subprotocol`.

    Args:
        ws_server: WebSocket server that created this connection.

    See :func:`serve` for the documentation of ``ws_handler``, ``logger``, ``origins``,
    ``extensions``, ``subprotocols``, ``extra_headers``, and ``server_header``.

    See :class:`~websockets.legacy.protocol.WebSocketCommonProtocol` for the
    documentation of ``ping_interval``, ``ping_timeout``, ``close_timeout``,
    ``max_size``, ``max_queue``, ``read_limit``, and ``write_limit``.

    """

    is_client = False
    side = "server"

    def __init__(
        self,
        # The version that accepts the path in the second argument is deprecated.
        ws_handler: (
            Callable[[WebSocketServerProtocol], Awaitable[Any]]
            | Callable[[WebSocketServerProtocol, str], Awaitable[Any]]
        ),
        ws_server: WebSocketServer,
        *,
        logger: LoggerLike | None = None,
        origins: Sequence[Origin | None] | None = None,
        extensions: Sequence[ServerExtensionFactory] | None = None,
        subprotocols: Sequence[Subprotocol] | None = None,
        extra_headers: HeadersLikeOrCallable | None = None,
        server_header: str | None = SERVER,
        process_request: (
            Callable[[str, Headers], Awaitable[HTTPResponse | None]] | None
        ) = None,
        select_subprotocol: (
            Callable[[Sequence[Subprotocol], Sequence[Subprotocol]], Subprotocol] | None
        ) = None,
        open_timeout: float | None = 10,
        **kwargs: Any,
    ) -> None:
        if logger is None:
            logger = logging.getLogger("websockets.server")
        super().__init__(logger=logger, **kwargs)
        # For backwards compatibility with 6.0 or earlier.
        if origins is not None and "" in origins:
            warnings.warn("use None instead of '' in origins", DeprecationWarning)
            origins = [None if origin == "" else origin for origin in origins]
        # For backwards compatibility with 10.0 or earlier. Done here in
        # addition to serve to trigger the deprecation warning on direct
        # use of WebSocketServerProtocol.
        self.ws_handler = remove_path_argument(ws_handler)
        self.ws_server = ws_server
        self.origins = origins
        self.available_extensions = extensions
        self.available_subprotocols = subprotocols
        self.extra_headers = extra_headers
        self.server_header = server_header
        self._process_request = process_request
        self._select_subprotocol = select_subprotocol
        self.open_timeout = open_timeout

    def connection_made(self, transport: asyncio.BaseTransport) -> None:
        """
        Register connection and initialize a task to handle it.

        """
        super().connection_made(transport)
        # Register the connection with the server before creating the handler
        # task. Registering at the beginning of the handler coroutine would
        # create a race condition between the creation of the task, which
        # schedules its execution, and the moment the handler starts running.
        self.ws_server.register(self)
        self.handler_task = self.loop.create_task(self.handler())

    async def handler(self) -> None:
        """
        Handle the lifecycle of a WebSocket connection.

        Since this method doesn't have a caller able to handle exceptions, it
        attempts to log relevant ones and guarantees that the TCP connection is
        closed before exiting.

        """
        try:
            try:
                async with asyncio_timeout(self.open_timeout):
                    await self.handshake(
                        origins=self.origins,
                        available_extensions=self.available_extensions,
                        available_subprotocols=self.available_subprotocols,
                        extra_headers=self.extra_headers,
                    )
            except asyncio.TimeoutError:  # pragma: no cover
                raise
            except ConnectionError:
                raise
            except Exception as exc:
                if isinstance(exc, AbortHandshake):
                    status, headers, body = exc.status, exc.headers, exc.body
                elif isinstance(exc, InvalidOrigin):
                    if self.debug:
                        self.logger.debug("! invalid origin", exc_info=True)
                    status, headers, body = (
                        http.HTTPStatus.FORBIDDEN,
                        Headers(),
                        f"Failed to open a WebSocket connection: {exc}.\n".encode(),
                    )
                elif isinstance(exc, InvalidUpgrade):
                    if self.debug:
                        self.logger.debug("! invalid upgrade", exc_info=True)
                    status, headers, body = (
                        http.HTTPStatus.UPGRADE_REQUIRED,
                        Headers([("Upgrade", "websocket")]),
                        (
                            f"Failed to open a WebSocket connection: {exc}.\n"
                            f"\n"
                            f"You cannot access a WebSocket server directly "
                            f"with a browser. You need a WebSocket client.\n"
                        ).encode(),
                    )
                elif isinstance(exc, InvalidHandshake):
                    if self.debug:
                        self.logger.debug("! invalid handshake", exc_info=True)
                    exc_chain = cast(BaseException, exc)
                    exc_str = f"{exc_chain}"
                    while exc_chain.__cause__ is not None:
                        exc_chain = exc_chain.__cause__
                        exc_str += f"; {exc_chain}"
                    status, headers, body = (
                        http.HTTPStatus.BAD_REQUEST,
                        Headers(),
                        f"Failed to open a WebSocket connection: {exc_str}.\n".encode(),
                    )
                else:
                    self.logger.error("opening handshake failed", exc_info=True)
                    status, headers, body = (
                        http.HTTPStatus.INTERNAL_SERVER_ERROR,
                        Headers(),
                        (
                            b"Failed to open a WebSocket connection.\n"
                            b"See server log for more information.\n"
                        ),
                    )

                headers.setdefault("Date", email.utils.formatdate(usegmt=True))
                if self.server_header:
                    headers.setdefault("Server", self.server_header)

                headers.setdefault("Content-Length", str(len(body)))
                headers.setdefault("Content-Type", "text/plain")
                headers.setdefault("Connection", "close")

                self.write_http_response(status, headers, body)
                self.logger.info(
                    "connection rejected (%d %s)", status.value, status.phrase
                )
                await self.close_transport()
                return

            try:
                await self.ws_handler(self)
            except Exception:
                self.logger.error("connection handler failed", exc_info=True)
                if not self.closed:
                    self.fail_connection(1011)
                raise

            try:
                await self.close()
            except ConnectionError:
                raise
            except Exception:
                self.logger.error("closing handshake failed", exc_info=True)
                raise

        except Exception:
            # Last-ditch attempt to avoid leaking connections on errors.
            try:
                self.transport.close()
            except Exception:  # pragma: no cover
                pass

        finally:
            # Unregister the connection with the server when the handler task
            # terminates. Registration is tied to the lifecycle of the handler
            # task because the server waits for tasks attached to registered
            # connections before terminating.
            self.ws_server.unregister(self)
            self.logger.info("connection closed")

    async def read_http_request(self) -> tuple[str, Headers]:
        """
        Read request line and headers from the HTTP request.

        If the request contains a body, it may be read from ``self.reader``
        after this coroutine returns.

        Raises:
            InvalidMessage: If the HTTP message is malformed or isn't an
                HTTP/1.1 GET request.

        """
        try:
            path, headers = await read_request(self.reader)
        except asyncio.CancelledError:  # pragma: no cover
            raise
        except Exception as exc:
            raise InvalidMessage("did not receive a valid HTTP request") from exc

        if self.debug:
            self.logger.debug("< GET %s HTTP/1.1", path)
            for key, value in headers.raw_items():
                self.logger.debug("< %s: %s", key, value)

        self.path = path
        self.request_headers = headers

        return path, headers

    def write_http_response(
        self, status: http.HTTPStatus, headers: Headers, body: bytes | None = None
    ) -> None:
        """
        Write status line and headers to the HTTP response.

        This coroutine is also able to write a response body.

        """
        self.response_headers = headers

        if self.debug:
            self.logger.debug("> HTTP/1.1 %d %s", status.value, status.phrase)
            for key, value in headers.raw_items():
                self.logger.debug("> %s: %s", key, value)
            if body is not None:
                self.logger.debug("> [body] (%d bytes)", len(body))

        # Since the status line and headers only contain ASCII characters,
        # we can keep this simple.
        response = f"HTTP/1.1 {status.value} {status.phrase}\r\n"
        response += str(headers)

        self.transport.write(response.encode())

        if body is not None:
            self.transport.write(body)

    async def process_request(
        self, path: str, request_headers: Headers
    ) -> HTTPResponse | None:
        """
        Intercept the HTTP request and return an HTTP response if appropriate.

        You may override this method in a :class:`WebSocketServerProtocol`
        subclass, for example:

        * to return an HTTP 200 OK response on a given path; then a load
          balancer can use this path for a health check;
        * to authenticate the request and return an HTTP 401 Unauthorized or an
          HTTP 403 Forbidden when authentication fails.

        You may also override this method with the ``process_request``
        argument of :func:`serve` and :class:`WebSocketServerProtocol`. This
        is equivalent, except ``process_request`` won't have access to the
        protocol instance, so it can't store information for later use.

        :meth:`process_request` is expected to complete quickly. If it may run
        for a long time, then it should await :meth:`wait_closed` and exit if
        :meth:`wait_closed` completes, or else it could prevent the server
        from shutting down.

        Args:
            path: Request path, including optional query string.
            request_headers: Request headers.

        Returns:
            tuple[StatusLike, HeadersLike, bytes] | None: :obj:`None` to
            continue the WebSocket handshake normally.

            An HTTP response, represented by a 3-uple of the response status,
            headers, and body, to abort the WebSocket handshake and return
            that HTTP response instead.

        """
        if self._process_request is not None:
            response = self._process_request(path, request_headers)
            if isinstance(response, Awaitable):
                return await response
            else:
                # For backwards compatibility with 7.0.
                warnings.warn(
                    "declare process_request as a coroutine", DeprecationWarning
                )
                return response
        return None

    @staticmethod
    def process_origin(
        headers: Headers, origins: Sequence[Origin | None] | None = None
    ) -> Origin | None:
        """
        Handle the Origin HTTP request header.

        Args:
            headers: Request headers.
            origins: Optional list of acceptable origins.

        Raises:
            InvalidOrigin: If the origin isn't acceptable.

        """
        # "The user agent MUST NOT include more than one Origin header field"
        # per https://datatracker.ietf.org/doc/html/rfc6454#section-7.3.
        try:
            origin = headers.get("Origin")
        except MultipleValuesError as exc:
            raise InvalidHeader("Origin", "multiple values") from exc
        if origin is not None:
            origin = cast(Origin, origin)
        if origins is not None:
            if origin not in origins:
                raise InvalidOrigin(origin)
        return origin

    @staticmethod
    def process_extensions(
        headers: Headers,
        available_extensions: Sequence[ServerExtensionFactory] | None,
    ) -> tuple[str | None, list[Extension]]:
        """
        Handle the Sec-WebSocket-Extensions HTTP request header.

        Accept or reject each extension proposed in the client request.
        Negotiate parameters for accepted extensions.

        Return the Sec-WebSocket-Extensions HTTP response header and the list
        of accepted extensions.

        :rfc:`6455` leaves the rules up to the specification of each
        :extension.

        To provide this level of flexibility, for each extension proposed by
        the client, we check for a match with each extension available in the
        server configuration. If no match is found, the extension is ignored.

        If several variants of the same extension are proposed by the client,
        it may be accepted several times, which won't make sense in general.
        Extensions must implement their own requirements. For this purpose,
        the list of previously accepted extensions is provided.

        This process doesn't allow the server to reorder extensions. It can
        only select a subset of the extensions proposed by the client.

        Other requirements, for example related to mandatory extensions or the
        order of extensions, may be implemented by overriding this method.

        Args:
            headers: Request headers.
            extensions: Optional list of supported extensions.

        Raises:
            InvalidHandshake: To abort the handshake with an HTTP 400 error.

        """
        response_header_value: str | None = None

        extension_headers: list[ExtensionHeader] = []
        accepted_extensions: list[Extension] = []

        header_values = headers.get_all("Sec-WebSocket-Extensions")

        if header_values and available_extensions:
            parsed_header_values: list[ExtensionHeader] = sum(
                [parse_extension(header_value) for header_value in header_values], []
            )

            for name, request_params in parsed_header_values:
                for ext_factory in available_extensions:
                    # Skip non-matching extensions based on their name.
                    if ext_factory.name != name:
                        continue

                    # Skip non-matching extensions based on their params.
                    try:
                        response_params, extension = ext_factory.process_request_params(
                            request_params, accepted_extensions
                        )
                    except NegotiationError:
                        continue

                    # Add matching extension to the final list.
                    extension_headers.append((name, response_params))
                    accepted_extensions.append(extension)

                    # Break out of the loop once we have a match.
                    break

                # If we didn't break from the loop, no extension in our list
                # matched what the client sent. The extension is declined.

        # Serialize extension header.
        if extension_headers:
            response_header_value = build_extension(extension_headers)

        return response_header_value, accepted_extensions

    # Not @staticmethod because it calls self.select_subprotocol()
    def process_subprotocol(
        self, headers: Headers, available_subprotocols: Sequence[Subprotocol] | None
    ) -> Subprotocol | None:
        """
        Handle the Sec-WebSocket-Protocol HTTP request header.

        Return Sec-WebSocket-Protocol HTTP response header, which is the same
        as the selected subprotocol.

        Args:
            headers: Request headers.
            available_subprotocols: Optional list of supported subprotocols.

        Raises:
            InvalidHandshake: To abort the handshake with an HTTP 400 error.

        """
        subprotocol: Subprotocol | None = None

        header_values = headers.get_all("Sec-WebSocket-Protocol")

        if header_values and available_subprotocols:
            parsed_header_values: list[Subprotocol] = sum(
                [parse_subprotocol(header_value) for header_value in header_values], []
            )

            subprotocol = self.select_subprotocol(
                parsed_header_values, available_subprotocols
            )

        return subprotocol

    def select_subprotocol(
        self,
        client_subprotocols: Sequence[Subprotocol],
        server_subprotocols: Sequence[Subprotocol],
    ) -> Subprotocol | None:
        """
        Pick a subprotocol among those supported by the client and the server.

        If several subprotocols are available, select the preferred subprotocol
        by giving equal weight to the preferences of the client and the server.

        If no subprotocol is available, proceed without a subprotocol.

        You may provide a ``select_subprotocol`` argument to :func:`serve` or
        :class:`WebSocketServerProtocol` to override this logic. For example,
        you could reject the handshake if the client doesn't support a
        particular subprotocol, rather than accept the handshake without that
        subprotocol.

        Args:
            client_subprotocols: List of subprotocols offered by the client.
            server_subprotocols: List of subprotocols available on the server.

        Returns:
            Selected subprotocol, if a common subprotocol was found.

            :obj:`None` to continue without a subprotocol.

        """
        if self._select_subprotocol is not None:
            return self._select_subprotocol(client_subprotocols, server_subprotocols)

        subprotocols = set(client_subprotocols) & set(server_subprotocols)
        if not subprotocols:
            return None
        return sorted(
            subprotocols,
            key=lambda p: client_subprotocols.index(p) + server_subprotocols.index(p),
        )[0]

    async def handshake(
        self,
        origins: Sequence[Origin | None] | None = None,
        available_extensions: Sequence[ServerExtensionFactory] | None = None,
        available_subprotocols: Sequence[Subprotocol] | None = None,
        extra_headers: HeadersLikeOrCallable | None = None,
    ) -> str:
        """
        Perform the server side of the opening handshake.

        Args:
            origins: List of acceptable values of the Origin HTTP header;
                include :obj:`None` if the lack of an origin is acceptable.
            extensions: List of supported extensions, in order in which they
                should be tried.
            subprotocols: List of supported subprotocols, in order of
                decreasing preference.
            extra_headers: Arbitrary HTTP headers to add to the response when
                the handshake succeeds.

        Returns:
            path of the URI of the request.

        Raises:
            InvalidHandshake: If the handshake fails.

        """
        path, request_headers = await self.read_http_request()

        # Hook for customizing request handling, for example checking
        # authentication or treating some paths as plain HTTP endpoints.
        early_response_awaitable = self.process_request(path, request_headers)
        if isinstance(early_response_awaitable, Awaitable):
            early_response = await early_response_awaitable
        else:
            # For backwards compatibility with 7.0.
            warnings.warn("declare process_request as a coroutine", DeprecationWarning)
            early_response = early_response_awaitable

        # The connection may drop while process_request is running.
        if self.state is State.CLOSED:
            # This subclass of ConnectionError is silently ignored in handler().
            raise BrokenPipeError("connection closed during opening handshake")

        # Change the response to a 503 error if the server is shutting down.
        if not self.ws_server.is_serving():
            early_response = (
                http.HTTPStatus.SERVICE_UNAVAILABLE,
                [],
                b"Server is shutting down.\n",
            )

        if early_response is not None:
            raise AbortHandshake(*early_response)

        key = check_request(request_headers)

        self.origin = self.process_origin(request_headers, origins)

        extensions_header, self.extensions = self.process_extensions(
            request_headers, available_extensions
        )

        protocol_header = self.subprotocol = self.process_subprotocol(
            request_headers, available_subprotocols
        )

        response_headers = Headers()

        build_response(response_headers, key)

        if extensions_header is not None:
            response_headers["Sec-WebSocket-Extensions"] = extensions_header

        if protocol_header is not None:
            response_headers["Sec-WebSocket-Protocol"] = protocol_header

        if callable(extra_headers):
            extra_headers = extra_headers(path, self.request_headers)
        if extra_headers is not None:
            response_headers.update(extra_headers)

        response_headers.setdefault("Date", email.utils.formatdate(usegmt=True))
        if self.server_header is not None:
            response_headers.setdefault("Server", self.server_header)

        self.write_http_response(http.HTTPStatus.SWITCHING_PROTOCOLS, response_headers)

        self.logger.info("connection open")

        self.connection_open()

        return path


class WebSocketServer:
    """
    WebSocket server returned by :func:`serve`.

    This class mirrors the API of :class:`~asyncio.Server`.

    It keeps track of WebSocket connections in order to close them properly
    when shutting down.

    Args:
        logger: Logger for this server.
            It defaults to ``logging.getLogger("websockets.server")``.
            See the :doc:`logging guide <../../topics/logging>` for details.

    """

    def __init__(self, logger: LoggerLike | None = None) -> None:
        if logger is None:
            logger = logging.getLogger("websockets.server")
        self.logger = logger

        # Keep track of active connections.
        self.websockets: set[WebSocketServerProtocol] = set()

        # Task responsible for closing the server and terminating connections.
        self.close_task: asyncio.Task[None] | None = None

        # Completed when the server is closed and connections are terminated.
        self.closed_waiter: asyncio.Future[None]

    def wrap(self, server: asyncio.base_events.Server) -> None:
        """
        Attach to a given :class:`~asyncio.Server`.

        Since :meth:`~asyncio.loop.create_server` doesn't support injecting a
        custom ``Server`` class, the easiest solution that doesn't rely on
        private :mod:`asyncio` APIs is to:

        - instantiate a :class:`WebSocketServer`
        - give the protocol factory a reference to that instance
        - call :meth:`~asyncio.loop.create_server` with the factory
        - attach the resulting :class:`~asyncio.Server` with this method

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

        # Initialized here because we need a reference to the event loop.
        # This could be moved back to __init__ now that Python < 3.10 isn't
        # supported anymore, but I'm not taking that risk in legacy code.
        self.closed_waiter = server.get_loop().create_future()

    def register(self, protocol: WebSocketServerProtocol) -> None:
        """
        Register a connection with this server.

        """
        self.websockets.add(protocol)

    def unregister(self, protocol: WebSocketServerProtocol) -> None:
        """
        Unregister a connection with this server.

        """
        self.websockets.remove(protocol)

    def close(self, close_connections: bool = True) -> None:
        """
        Close the server.

        * Close the underlying :class:`~asyncio.Server`.
        * When ``close_connections`` is :obj:`True`, which is the default,
          close existing connections. Specifically:

          * Reject opening WebSocket connections with an HTTP 503 (service
            unavailable) error. This happens when the server accepted the TCP
            connection but didn't complete the opening handshake before closing.
          * Close open WebSocket connections with close code 1001 (going away).

        * Wait until all connection handlers terminate.

        :meth:`close` is idempotent.

        """
        if self.close_task is None:
            self.close_task = self.get_loop().create_task(
                self._close(close_connections)
            )

    async def _close(self, close_connections: bool) -> None:
        """
        Implementation of :meth:`close`.

        This calls :meth:`~asyncio.Server.close` on the underlying
        :class:`~asyncio.Server` object to stop accepting new connections and
        then closes open connections with close code 1001.

        """
        self.logger.info("server closing")

        # Stop accepting new connections.
        self.server.close()

        # Wait until all accepted connections reach connection_made() and call
        # register(). See https://github.com/python/cpython/issues/79033 for
        # details. This workaround can be removed when dropping Python < 3.11.
        await asyncio.sleep(0)

        if close_connections:
            # Close OPEN connections with close code 1001. After server.close(),
            # handshake() closes OPENING connections with an HTTP 503 error.
            close_tasks = [
                asyncio.create_task(websocket.close(1001))
                for websocket in self.websockets
                if websocket.state is not State.CONNECTING
            ]
            # asyncio.wait doesn't accept an empty first argument.
            if close_tasks:
                await asyncio.wait(close_tasks)

        # Wait until all TCP connections are closed.
        await self.server.wait_closed()

        # Wait until all connection handlers terminate.
        # asyncio.wait doesn't accept an empty first argument.
        if self.websockets:
            await asyncio.wait(
                [websocket.handler_task for websocket in self.websockets]
            )

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

        * :meth:`~WebSocketServerProtocol.recv`: when the connection is closed,
          it raises :exc:`~websockets.exceptions.ConnectionClosedOK`;
        * :meth:`~WebSocketServerProtocol.wait_closed`: when the connection is
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

    def is_serving(self) -> bool:
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
    def sockets(self) -> Iterable[socket.socket]:
        """
        See :attr:`asyncio.Server.sockets`.

        """
        return self.server.sockets

    async def __aenter__(self) -> WebSocketServer:  # pragma: no cover
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:  # pragma: no cover
        self.close()
        await self.wait_closed()


class Serve:
    """
    Start a WebSocket server listening on ``host`` and ``port``.

    Whenever a client connects, the server creates a
    :class:`WebSocketServerProtocol`, performs the opening handshake, and
    delegates to the connection handler, ``ws_handler``.

    The handler receives the :class:`WebSocketServerProtocol` and uses it to
    send and receive messages.

    Once the handler completes, either normally or with an exception, the
    server performs the closing handshake and closes the connection.

    Awaiting :func:`serve` yields a :class:`WebSocketServer`. This object
    provides a :meth:`~WebSocketServer.close` method to shut down the server::

        # set this future to exit the server
        stop = asyncio.get_running_loop().create_future()

        server = await serve(...)
        await stop
        server.close()
        await server.wait_closed()

    :func:`serve` can be used as an asynchronous context manager. Then, the
    server is shut down automatically when exiting the context::

        # set this future to exit the server
        stop = asyncio.get_running_loop().create_future()

        async with serve(...):
            await stop

    Args:
        ws_handler: Connection handler. It receives the WebSocket connection,
            which is a :class:`WebSocketServerProtocol`, in argument.
        host: Network interfaces the server binds to.
            See :meth:`~asyncio.loop.create_server` for details.
        port: TCP port the server listens on.
            See :meth:`~asyncio.loop.create_server` for details.
        create_protocol: Factory for the :class:`asyncio.Protocol` managing
            the connection. It defaults to :class:`WebSocketServerProtocol`.
            Set it to a wrapper or a subclass to customize connection handling.
        logger: Logger for this server.
            It defaults to ``logging.getLogger("websockets.server")``.
            See the :doc:`logging guide <../../topics/logging>` for details.
        compression: The "permessage-deflate" extension is enabled by default.
            Set ``compression`` to :obj:`None` to disable it. See the
            :doc:`compression guide <../../topics/compression>` for details.
        origins: Acceptable values of the ``Origin`` header, for defending
            against Cross-Site WebSocket Hijacking attacks. Include :obj:`None`
            in the list if the lack of an origin is acceptable.
        extensions: List of supported extensions, in order in which they
            should be negotiated and run.
        subprotocols: List of supported subprotocols, in order of decreasing
            preference.
        extra_headers (HeadersLike | Callable[[str, Headers] | HeadersLike]):
            Arbitrary HTTP headers to add to the response. This can be
            a :data:`~websockets.datastructures.HeadersLike` or a callable
            taking the request path and headers in arguments and returning
            a :data:`~websockets.datastructures.HeadersLike`.
        server_header: Value of  the ``Server`` response header.
            It defaults to ``"Python/x.y.z websockets/X.Y"``.
            Setting it to :obj:`None` removes the header.
        process_request (Callable[[str, Headers], \
            Awaitable[tuple[StatusLike, HeadersLike, bytes] | None]] | None):
            Intercept HTTP request before the opening handshake.
            See :meth:`~WebSocketServerProtocol.process_request` for details.
        select_subprotocol: Select a subprotocol supported by the client.
            See :meth:`~WebSocketServerProtocol.select_subprotocol` for details.
        open_timeout: Timeout for opening connections in seconds.
            :obj:`None` disables the timeout.

    See :class:`~websockets.legacy.protocol.WebSocketCommonProtocol` for the
    documentation of ``ping_interval``, ``ping_timeout``, ``close_timeout``,
    ``max_size``, ``max_queue``, ``read_limit``, and ``write_limit``.

    Any other keyword arguments are passed the event loop's
    :meth:`~asyncio.loop.create_server` method.

    For example:

    * You can set ``ssl`` to a :class:`~ssl.SSLContext` to enable TLS.

    * You can set ``sock`` to a :obj:`~socket.socket` that you created
      outside of websockets.

    Returns:
        WebSocket server.

    """

    def __init__(
        self,
        # The version that accepts the path in the second argument is deprecated.
        ws_handler: (
            Callable[[WebSocketServerProtocol], Awaitable[Any]]
            | Callable[[WebSocketServerProtocol, str], Awaitable[Any]]
        ),
        host: str | Sequence[str] | None = None,
        port: int | None = None,
        *,
        create_protocol: Callable[..., WebSocketServerProtocol] | None = None,
        logger: LoggerLike | None = None,
        compression: str | None = "deflate",
        origins: Sequence[Origin | None] | None = None,
        extensions: Sequence[ServerExtensionFactory] | None = None,
        subprotocols: Sequence[Subprotocol] | None = None,
        extra_headers: HeadersLikeOrCallable | None = None,
        server_header: str | None = SERVER,
        process_request: (
            Callable[[str, Headers], Awaitable[HTTPResponse | None]] | None
        ) = None,
        select_subprotocol: (
            Callable[[Sequence[Subprotocol], Sequence[Subprotocol]], Subprotocol] | None
        ) = None,
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
        klass: type[WebSocketServerProtocol] | None = kwargs.pop("klass", None)
        if klass is None:
            klass = WebSocketServerProtocol
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

        ws_server = WebSocketServer(logger=logger)

        secure = kwargs.get("ssl") is not None

        if compression == "deflate":
            extensions = enable_server_permessage_deflate(extensions)
        elif compression is not None:
            raise ValueError(f"unsupported compression: {compression}")

        if subprotocols is not None:
            validate_subprotocols(subprotocols)

        # Help mypy and avoid this error: "type[WebSocketServerProtocol] |
        # Callable[..., WebSocketServerProtocol]" not callable  [misc]
        create_protocol = cast(Callable[..., WebSocketServerProtocol], create_protocol)
        factory = functools.partial(
            create_protocol,
            # For backwards compatibility with 10.0 or earlier. Done here in
            # addition to WebSocketServerProtocol to trigger the deprecation
            # warning once per serve() call rather than once per connection.
            remove_path_argument(ws_handler),
            ws_server,
            host=host,
            port=port,
            secure=secure,
            open_timeout=open_timeout,
            ping_interval=ping_interval,
            ping_timeout=ping_timeout,
            close_timeout=close_timeout,
            max_size=max_size,
            max_queue=max_queue,
            read_limit=read_limit,
            write_limit=write_limit,
            loop=_loop,
            legacy_recv=legacy_recv,
            origins=origins,
            extensions=extensions,
            subprotocols=subprotocols,
            extra_headers=extra_headers,
            server_header=server_header,
            process_request=process_request,
            select_subprotocol=select_subprotocol,
            logger=logger,
        )

        if kwargs.pop("unix", False):
            path: str | None = kwargs.pop("path", None)
            # unix_serve(path) must not specify host and port parameters.
            assert host is None and port is None
            create_server = functools.partial(
                loop.create_unix_server, factory, path, **kwargs
            )
        else:
            create_server = functools.partial(
                loop.create_server, factory, host, port, **kwargs
            )

        # This is a coroutine function.
        self._create_server = create_server
        self.ws_server = ws_server

    # async with serve(...)

    async def __aenter__(self) -> WebSocketServer:
        return await self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self.ws_server.close()
        await self.ws_server.wait_closed()

    # await serve(...)

    def __await__(self) -> Generator[Any, None, WebSocketServer]:
        # Create a suitable iterator by calling __await__ on a coroutine.
        return self.__await_impl__().__await__()

    async def __await_impl__(self) -> WebSocketServer:
        server = await self._create_server()
        self.ws_server.wrap(server)
        return self.ws_server

    # yield from serve(...) - remove when dropping Python < 3.11

    __iter__ = __await__


serve = Serve


def unix_serve(
    # The version that accepts the path in the second argument is deprecated.
    ws_handler: (
        Callable[[WebSocketServerProtocol], Awaitable[Any]]
        | Callable[[WebSocketServerProtocol, str], Awaitable[Any]]
    ),
    path: str | None = None,
    **kwargs: Any,
) -> Serve:
    """
    Start a WebSocket server listening on a Unix socket.

    This function is identical to :func:`serve`, except the ``host`` and
    ``port`` arguments are replaced by ``path``. It is only available on Unix.

    Unrecognized keyword arguments are passed the event loop's
    :meth:`~asyncio.loop.create_unix_server` method.

    It's useful for deploying a server behind a reverse proxy such as nginx.

    Args:
        path: File system path to the Unix socket.

    """
    return serve(ws_handler, path=path, unix=True, **kwargs)


def remove_path_argument(
    ws_handler: (
        Callable[[WebSocketServerProtocol], Awaitable[Any]]
        | Callable[[WebSocketServerProtocol, str], Awaitable[Any]]
    ),
) -> Callable[[WebSocketServerProtocol], Awaitable[Any]]:
    try:
        inspect.signature(ws_handler).bind(None)
    except TypeError:
        try:
            inspect.signature(ws_handler).bind(None, "")
        except TypeError:  # pragma: no cover
            # ws_handler accepts neither one nor two arguments; leave it alone.
            pass
        else:
            # ws_handler accepts two arguments; activate backwards compatibility.
            warnings.warn("remove second argument of ws_handler", DeprecationWarning)

            async def _ws_handler(websocket: WebSocketServerProtocol) -> Any:
                return await cast(
                    Callable[[WebSocketServerProtocol, str], Awaitable[Any]],
                    ws_handler,
                )(websocket, websocket.path)

            return _ws_handler

    return cast(
        Callable[[WebSocketServerProtocol], Awaitable[Any]],
        ws_handler,
    )
