from __future__ import annotations

import socket
import ssl as ssl_module
import threading
import warnings
from collections.abc import Sequence
from typing import Any, Callable, Literal, TypeVar, cast

from ..client import ClientProtocol
from ..datastructures import HeadersLike
from ..exceptions import InvalidProxyMessage, InvalidProxyStatus, ProxyError
from ..extensions.base import ClientExtensionFactory
from ..extensions.permessage_deflate import enable_client_permessage_deflate
from ..headers import validate_subprotocols
from ..http11 import USER_AGENT, Response
from ..protocol import CONNECTING, Event
from ..proxy import Proxy, get_proxy, parse_proxy, prepare_connect_request
from ..streams import StreamReader
from ..typing import BytesLike, LoggerLike, Origin, Subprotocol
from ..uri import WebSocketURI, parse_uri
from .connection import Connection
from .utils import Deadline


__all__ = ["connect", "unix_connect", "ClientConnection"]


class ClientConnection(Connection):
    """
    :mod:`threading` implementation of a WebSocket client connection.

    :class:`ClientConnection` provides :meth:`recv` and :meth:`send` methods for
    receiving and sending messages.

    It supports iteration to receive messages::

        for message in websocket:
            process(message)

    The iterator exits normally when the connection is closed with code
    1000 (OK) or 1001 (going away) or without a close code. It raises a
    :exc:`~websockets.exceptions.ConnectionClosedError` when the connection is
    closed with any other code.

    The ``ping_interval``, ``ping_timeout``, ``close_timeout``, and
    ``max_queue`` arguments have the same meaning as in :func:`connect`.

    Args:
        socket: Socket connected to a WebSocket server.
        protocol: Sans-I/O connection.

    """

    def __init__(
        self,
        socket: socket.socket,
        protocol: ClientProtocol,
        *,
        ping_interval: float | None = 20,
        ping_timeout: float | None = 20,
        close_timeout: float | None = 10,
        max_queue: int | None | tuple[int | None, int | None] = 16,
    ) -> None:
        self.protocol: ClientProtocol
        self.response_rcvd = threading.Event()
        super().__init__(
            socket,
            protocol,
            ping_interval=ping_interval,
            ping_timeout=ping_timeout,
            close_timeout=close_timeout,
            max_queue=max_queue,
        )

    def handshake(
        self,
        additional_headers: HeadersLike | None = None,
        user_agent_header: str | None = USER_AGENT,
        timeout: float | None = None,
    ) -> None:
        """
        Perform the opening handshake.

        """
        with self.send_context(expected_state=CONNECTING):
            self.request = self.protocol.connect()
            if additional_headers is not None:
                self.request.headers.update(additional_headers)
            if user_agent_header is not None:
                self.request.headers.setdefault("User-Agent", user_agent_header)
            self.protocol.send_request(self.request)

        if not self.response_rcvd.wait(timeout):
            raise TimeoutError("timed out while waiting for handshake response")

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
            self.response_rcvd.set()
        # Later events - frames.
        else:
            super().process_event(event)

    def recv_events(self) -> None:
        """
        Read incoming data from the socket and process events.

        """
        try:
            super().recv_events()
        finally:
            # If the connection is closed during the handshake, unblock it.
            self.response_rcvd.set()


def connect(
    uri: str,
    *,
    # TCP/TLS
    sock: socket.socket | None = None,
    ssl: ssl_module.SSLContext | None = None,
    server_hostname: str | None = None,
    # WebSocket
    origin: Origin | None = None,
    extensions: Sequence[ClientExtensionFactory] | None = None,
    subprotocols: Sequence[Subprotocol] | None = None,
    compression: str | None = "deflate",
    # HTTP
    additional_headers: HeadersLike | None = None,
    user_agent_header: str | None = USER_AGENT,
    proxy: str | Literal[True] | None = True,
    proxy_ssl: ssl_module.SSLContext | None = None,
    proxy_server_hostname: str | None = None,
    # Timeouts
    open_timeout: float | None = 10,
    ping_interval: float | None = 20,
    ping_timeout: float | None = 20,
    close_timeout: float | None = 10,
    # Limits
    max_size: int | None | tuple[int | None, int | None] = 2**20,
    max_queue: int | None | tuple[int | None, int | None] = 16,
    # Logging
    logger: LoggerLike | None = None,
    # Escape hatch for advanced customization
    create_connection: type[ClientConnection] | None = None,
    **kwargs: Any,
) -> ClientConnection:
    """
    Connect to the WebSocket server at ``uri``.

    This function returns a :class:`ClientConnection` instance, which you can
    use to send and receive messages.

    :func:`connect` may be used as a context manager::

        from websockets.sync.client import connect

        with connect(...) as websocket:
            ...

    The connection is closed automatically when exiting the context.

    Args:
        uri: URI of the WebSocket server.
        sock: Preexisting TCP socket. ``sock`` overrides the host and port
            from ``uri``. You may call :func:`socket.create_connection` to
            create a suitable TCP socket.
        ssl: Configuration for enabling TLS on the connection.
        server_hostname: Host name for the TLS handshake. ``server_hostname``
            overrides the host name from ``uri``.
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
        proxy_ssl: Configuration for enabling TLS on the proxy connection.
        proxy_server_hostname: Host name for the TLS handshake with the proxy.
            ``proxy_server_hostname`` overrides the host name from ``proxy``.
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
        logger: Logger for this client.
            It defaults to ``logging.getLogger("websockets.client")``.
            See the :doc:`logging guide <../../topics/logging>` for details.
        create_connection: Factory for the :class:`ClientConnection` managing
            the connection. Set it to a wrapper or a subclass to customize
            connection handling.

    Any other keyword arguments are passed to :func:`~socket.create_connection`.

    Raises:
        InvalidURI: If ``uri`` isn't a valid WebSocket URI.
        OSError: If the TCP connection fails.
        InvalidHandshake: If the opening handshake fails.
        TimeoutError: If the opening handshake times out.

    """

    # Process parameters

    # Backwards compatibility: ssl used to be called ssl_context.
    if ssl is None and "ssl_context" in kwargs:
        ssl = kwargs.pop("ssl_context")
        warnings.warn(  # deprecated in 13.0 - 2024-08-20
            "ssl_context was renamed to ssl",
            DeprecationWarning,
        )

    ws_uri = parse_uri(uri)
    if not ws_uri.secure and ssl is not None:
        raise ValueError("ssl argument is incompatible with a ws:// URI")

    # Private APIs for unix_connect()
    unix: bool = kwargs.pop("unix", False)
    path: str | None = kwargs.pop("path", None)

    if unix:
        if path is None and sock is None:
            raise ValueError("missing path argument")
        elif path is not None and sock is not None:
            raise ValueError("path and sock arguments are incompatible")

    if subprotocols is not None:
        validate_subprotocols(subprotocols)

    if compression == "deflate":
        extensions = enable_client_permessage_deflate(extensions)
    elif compression is not None:
        raise ValueError(f"unsupported compression: {compression}")

    if unix:
        proxy = None
    if sock is not None:
        proxy = None
    if proxy is True:
        proxy = get_proxy(ws_uri)

    # Calculate timeouts on the TCP, TLS, and WebSocket handshakes.
    # The TCP and TLS timeouts must be set on the socket, then removed
    # to avoid conflicting with the WebSocket timeout in handshake().
    deadline = Deadline(open_timeout)

    if create_connection is None:
        create_connection = ClientConnection

    try:
        # Connect socket

        if sock is None:
            if unix:
                sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                sock.settimeout(deadline.timeout())
                assert path is not None  # mypy cannot figure this out
                sock.connect(path)
            elif proxy is not None:
                proxy_parsed = parse_proxy(proxy)
                if proxy_parsed.scheme[:5] == "socks":
                    # Connect to the server through the proxy.
                    sock = connect_socks_proxy(
                        proxy_parsed,
                        ws_uri,
                        deadline,
                        # websockets is consistent with the socket module while
                        # python_socks is consistent across implementations.
                        local_addr=kwargs.pop("source_address", None),
                    )
                elif proxy_parsed.scheme[:4] == "http":
                    # Validate the proxy_ssl argument.
                    if proxy_parsed.scheme != "https" and proxy_ssl is not None:
                        raise ValueError(
                            "proxy_ssl argument is incompatible with an http:// proxy"
                        )
                    # Connect to the server through the proxy.
                    sock = connect_http_proxy(
                        proxy_parsed,
                        ws_uri,
                        deadline,
                        user_agent_header=user_agent_header,
                        ssl=proxy_ssl,
                        server_hostname=proxy_server_hostname,
                        **kwargs,
                    )
                else:
                    raise AssertionError("unsupported proxy")
            else:
                kwargs.setdefault("timeout", deadline.timeout())
                sock = socket.create_connection(
                    (ws_uri.host, ws_uri.port),
                    **kwargs,
                )
            sock.settimeout(None)

        # Disable Nagle algorithm

        if not unix:
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, True)

        # Initialize TLS wrapper and perform TLS handshake

        if ws_uri.secure:
            if ssl is None:
                ssl = ssl_module.create_default_context()
            if server_hostname is None:
                server_hostname = ws_uri.host
            sock.settimeout(deadline.timeout())
            if proxy_ssl is None:
                sock = ssl.wrap_socket(sock, server_hostname=server_hostname)
            else:
                sock_2 = SSLSSLSocket(sock, ssl, server_hostname=server_hostname)
                # Let's pretend that sock is a socket, even though it isn't.
                sock = cast(socket.socket, sock_2)
            sock.settimeout(None)

        # Initialize WebSocket protocol

        protocol = ClientProtocol(
            ws_uri,
            origin=origin,
            extensions=extensions,
            subprotocols=subprotocols,
            max_size=max_size,
            logger=logger,
        )

        # Initialize WebSocket connection

        connection = create_connection(
            sock,
            protocol,
            ping_interval=ping_interval,
            ping_timeout=ping_timeout,
            close_timeout=close_timeout,
            max_queue=max_queue,
        )
    except Exception:
        if sock is not None:
            sock.close()
        raise

    try:
        connection.handshake(
            additional_headers,
            user_agent_header,
            deadline.timeout(),
        )
    except Exception:
        connection.close_socket()
        connection.recv_events_thread.join()
        raise

    connection.start_keepalive()
    return connection


def unix_connect(
    path: str | None = None,
    uri: str | None = None,
    **kwargs: Any,
) -> ClientConnection:
    """
    Connect to a WebSocket server listening on a Unix socket.

    This function accepts the same keyword arguments as :func:`connect`.

    It's only available on Unix.

    It's mainly useful for debugging servers listening on Unix sockets.

    Args:
        path: File system path to the Unix socket.
        uri: URI of the WebSocket server. ``uri`` defaults to
            ``ws://localhost/`` or, when a ``ssl`` is provided, to
            ``wss://localhost/``.

    """
    if uri is None:
        # Backwards compatibility: ssl used to be called ssl_context.
        if kwargs.get("ssl") is None and kwargs.get("ssl_context") is None:
            uri = "ws://localhost/"
        else:
            uri = "wss://localhost/"
    return connect(uri=uri, unix=True, path=path, **kwargs)


try:
    from python_socks import ProxyType
    from python_socks.sync import Proxy as SocksProxy

except ImportError:

    def connect_socks_proxy(
        proxy: Proxy,
        ws_uri: WebSocketURI,
        deadline: Deadline,
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

    def connect_socks_proxy(
        proxy: Proxy,
        ws_uri: WebSocketURI,
        deadline: Deadline,
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
        kwargs.setdefault("timeout", deadline.timeout())
        # connect() is documented to raise OSError and TimeoutError.
        # Wrap other exceptions in ProxyError, a subclass of InvalidHandshake.
        try:
            return socks_proxy.connect(ws_uri.host, ws_uri.port, **kwargs)
        except (OSError, TimeoutError, socket.timeout):
            raise
        except Exception as exc:
            raise ProxyError("failed to connect to SOCKS proxy") from exc


def read_connect_response(sock: socket.socket, deadline: Deadline) -> Response:
    reader = StreamReader()
    parser = Response.parse(
        reader.read_line,
        reader.read_exact,
        reader.read_to_eof,
        proxy=True,
    )
    try:
        while True:
            sock.settimeout(deadline.timeout())
            data = sock.recv(4096)
            if data:
                reader.feed_data(data)
            else:
                reader.feed_eof()
            next(parser)
    except StopIteration as exc:
        assert isinstance(exc.value, Response)  # help mypy
        response = exc.value
        if 200 <= response.status_code < 300:
            return response
        else:
            raise InvalidProxyStatus(response)
    except socket.timeout:
        raise TimeoutError("timed out while connecting to HTTP proxy")
    except Exception as exc:
        raise InvalidProxyMessage(
            "did not receive a valid HTTP response from proxy"
        ) from exc
    finally:
        sock.settimeout(None)


def connect_http_proxy(
    proxy: Proxy,
    ws_uri: WebSocketURI,
    deadline: Deadline,
    *,
    user_agent_header: str | None = None,
    ssl: ssl_module.SSLContext | None = None,
    server_hostname: str | None = None,
    **kwargs: Any,
) -> socket.socket:
    # Connect socket

    kwargs.setdefault("timeout", deadline.timeout())
    sock = socket.create_connection((proxy.host, proxy.port), **kwargs)

    # Initialize TLS wrapper and perform TLS handshake

    if proxy.scheme == "https":
        if ssl is None:
            ssl = ssl_module.create_default_context()
        if server_hostname is None:
            server_hostname = proxy.host
        sock.settimeout(deadline.timeout())
        sock = ssl.wrap_socket(sock, server_hostname=server_hostname)
        sock.settimeout(None)

    # Send CONNECT request to the proxy and read response.

    sock.sendall(prepare_connect_request(proxy, ws_uri, user_agent_header))
    try:
        read_connect_response(sock, deadline)
    except Exception:
        sock.close()
        raise

    return sock


T = TypeVar("T")
F = TypeVar("F", bound=Callable[..., T])


class SSLSSLSocket:
    """
    Socket-like object providing TLS-in-TLS.

    Only methods that are used by websockets are implemented.

    """

    recv_bufsize = 65536

    def __init__(
        self,
        sock: socket.socket,
        ssl_context: ssl_module.SSLContext,
        server_hostname: str | None = None,
    ) -> None:
        self.incoming = ssl_module.MemoryBIO()
        self.outgoing = ssl_module.MemoryBIO()
        self.ssl_socket = sock
        self.ssl_object = ssl_context.wrap_bio(
            self.incoming,
            self.outgoing,
            server_hostname=server_hostname,
        )
        self.run_io(self.ssl_object.do_handshake)

    def run_io(self, func: Callable[..., T], *args: Any) -> T:
        while True:
            want_read = False
            want_write = False
            try:
                result = func(*args)
            except ssl_module.SSLWantReadError:
                want_read = True
            except ssl_module.SSLWantWriteError:  # pragma: no cover
                want_write = True

            # Write outgoing data in all cases.
            data = self.outgoing.read()
            if data:
                self.ssl_socket.sendall(data)

            # Read incoming data and retry on SSLWantReadError.
            if want_read:
                data = self.ssl_socket.recv(self.recv_bufsize)
                if data:
                    self.incoming.write(data)
                else:
                    self.incoming.write_eof()
                continue
            # Retry after writing outgoing data on SSLWantWriteError.
            if want_write:  # pragma: no cover
                continue
            # Return result if no error happened.
            return result

    def recv(self, buflen: int) -> bytes:
        try:
            return self.run_io(self.ssl_object.read, buflen)
        except ssl_module.SSLEOFError:
            return b""  # always ignore ragged EOFs

    def send(self, data: BytesLike) -> int:
        return self.run_io(self.ssl_object.write, data)

    def sendall(self, data: BytesLike) -> None:
        # adapted from ssl_module.SSLSocket.sendall()
        count = 0
        with memoryview(data) as view, view.cast("B") as byte_view:
            amount = len(byte_view)
            while count < amount:
                count += self.send(byte_view[count:])

    # recv_into(), recvfrom(), recvfrom_into(), sendto(), unwrap(), and the
    # flags argument aren't implemented because websockets doesn't need them.

    def __getattr__(self, name: str) -> Any:
        return getattr(self.ssl_socket, name)
