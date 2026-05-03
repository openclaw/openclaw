from __future__ import annotations

import contextlib
import logging
import random
import socket
import struct
import threading
import time
import uuid
from collections.abc import Iterable, Iterator, Mapping
from types import TracebackType
from typing import Any, Literal, overload

from ..exceptions import (
    ConcurrencyError,
    ConnectionClosed,
    ConnectionClosedOK,
    ProtocolError,
)
from ..frames import DATA_OPCODES, CloseCode, Frame, Opcode
from ..http11 import Request, Response
from ..protocol import CLOSED, OPEN, Event, Protocol, State
from ..typing import BytesLike, Data, DataLike, LoggerLike, Subprotocol
from .messages import Assembler
from .utils import Deadline


__all__ = ["Connection"]


class Connection:
    """
    :mod:`threading` implementation of a WebSocket connection.

    :class:`Connection` provides APIs shared between WebSocket servers and
    clients.

    You shouldn't use it directly. Instead, use
    :class:`~websockets.sync.client.ClientConnection` or
    :class:`~websockets.sync.server.ServerConnection`.

    """

    recv_bufsize = 65536

    def __init__(
        self,
        socket: socket.socket,
        protocol: Protocol,
        *,
        ping_interval: float | None = 20,
        ping_timeout: float | None = 20,
        close_timeout: float | None = 10,
        max_queue: int | None | tuple[int | None, int | None] = 16,
    ) -> None:
        self.socket = socket
        self.protocol = protocol
        self.ping_interval = ping_interval
        self.ping_timeout = ping_timeout
        self.close_timeout = close_timeout
        if isinstance(max_queue, int) or max_queue is None:
            max_queue_high, max_queue_low = max_queue, None
        else:
            max_queue_high, max_queue_low = max_queue

        # Inject reference to this instance in the protocol's logger.
        self.protocol.logger = logging.LoggerAdapter(
            self.protocol.logger,
            {"websocket": self},
        )

        # Copy attributes from the protocol for convenience.
        self.id: uuid.UUID = self.protocol.id
        """Unique identifier of the connection. Useful in logs."""
        self.logger: LoggerLike = self.protocol.logger
        """Logger for this connection."""
        self.debug = self.protocol.debug

        # HTTP handshake request and response.
        self.request: Request | None = None
        """Opening handshake request."""
        self.response: Response | None = None
        """Opening handshake response."""

        # Mutex serializing interactions with the protocol.
        self.protocol_mutex = threading.Lock()

        # Lock stopping reads when the assembler buffer is full.
        self.recv_flow_control = threading.Lock()

        # Assembler turning frames into messages and serializing reads.
        self.recv_messages = Assembler(
            max_queue_high,
            max_queue_low,
            pause=self.recv_flow_control.acquire,
            resume=self.recv_flow_control.release,
        )

        # Deadline for the closing handshake.
        self.close_deadline: Deadline | None = None

        # Whether we are busy sending a fragmented message.
        self.send_in_progress = False

        # Mapping of ping IDs to pong waiters, in chronological order.
        self.pending_pings: dict[bytes, tuple[threading.Event, float, bool]] = {}

        self.latency: float = 0.0
        """
        Latency of the connection, in seconds.

        Latency is defined as the round-trip time of the connection. It is
        measured by sending a Ping frame and waiting for a matching Pong frame.
        Before the first measurement, :attr:`latency` is ``0.0``.

        By default, websockets enables a :ref:`keepalive <keepalive>` mechanism
        that sends Ping frames automatically at regular intervals. You can also
        send Ping frames and measure latency with :meth:`ping`.
        """

        # Thread that sends keepalive pings. None when ping_interval is None.
        self.keepalive_thread: threading.Thread | None = None

        # Exception raised while reading from the connection, to be chained to
        # ConnectionClosed in order to show why the TCP connection dropped.
        self.recv_exc: BaseException | None = None

        # Receiving events from the socket. This thread is marked as daemon to
        # allow creating a connection in a non-daemon thread and using it in a
        # daemon thread. This mustn't prevent the interpreter from exiting.
        self.recv_events_thread = threading.Thread(
            target=self.recv_events,
            daemon=True,
        )

        # Start recv_events only after all attributes are initialized.
        self.recv_events_thread.start()

    # Public attributes

    @property
    def local_address(self) -> Any:
        """
        Local address of the connection.

        For IPv4 connections, this is a ``(host, port)`` tuple.

        The format of the address depends on the address family.
        See :meth:`~socket.socket.getsockname`.

        """
        return self.socket.getsockname()

    @property
    def remote_address(self) -> Any:
        """
        Remote address of the connection.

        For IPv4 connections, this is a ``(host, port)`` tuple.

        The format of the address depends on the address family.
        See :meth:`~socket.socket.getpeername`.

        """
        return self.socket.getpeername()

    @property
    def state(self) -> State:
        """
        State of the WebSocket connection, defined in :rfc:`6455`.

        This attribute is provided for completeness. Typical applications
        shouldn't check its value. Instead, they should call :meth:`~recv` or
        :meth:`send` and handle :exc:`~websockets.exceptions.ConnectionClosed`
        exceptions.

        """
        return self.protocol.state

    @property
    def subprotocol(self) -> Subprotocol | None:
        """
        Subprotocol negotiated during the opening handshake.

        :obj:`None` if no subprotocol was negotiated.

        """
        return self.protocol.subprotocol

    @property
    def close_code(self) -> int | None:
        """
        State of the WebSocket connection, defined in :rfc:`6455`.

        This attribute is provided for completeness. Typical applications
        shouldn't check its value. Instead, they should inspect attributes
        of :exc:`~websockets.exceptions.ConnectionClosed` exceptions.

        """
        return self.protocol.close_code

    @property
    def close_reason(self) -> str | None:
        """
        State of the WebSocket connection, defined in :rfc:`6455`.

        This attribute is provided for completeness. Typical applications
        shouldn't check its value. Instead, they should inspect attributes
        of :exc:`~websockets.exceptions.ConnectionClosed` exceptions.

        """
        return self.protocol.close_reason

    # Public methods

    def __enter__(self) -> Connection:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        if exc_type is None:
            self.close()
        else:
            self.close(CloseCode.INTERNAL_ERROR)

    def __iter__(self) -> Iterator[Data]:
        """
        Iterate on incoming messages.

        The iterator calls :meth:`recv` and yields messages in an infinite loop.

        It exits when the connection is closed normally. It raises a
        :exc:`~websockets.exceptions.ConnectionClosedError` exception after a
        protocol error or a network failure.

        """
        try:
            while True:
                yield self.recv()
        except ConnectionClosedOK:
            return

    # This overload structure is required to avoid the error:
    # "parameter without a default follows parameter with a default"

    @overload
    def recv(self, timeout: float | None, decode: Literal[True]) -> str: ...

    @overload
    def recv(self, timeout: float | None, decode: Literal[False]) -> bytes: ...

    @overload
    def recv(self, timeout: float | None = None, *, decode: Literal[True]) -> str: ...

    @overload
    def recv(
        self, timeout: float | None = None, *, decode: Literal[False]
    ) -> bytes: ...

    @overload
    def recv(
        self, timeout: float | None = None, decode: bool | None = None
    ) -> Data: ...

    def recv(self, timeout: float | None = None, decode: bool | None = None) -> Data:
        """
        Receive the next message.

        When the connection is closed, :meth:`recv` raises
        :exc:`~websockets.exceptions.ConnectionClosed`. Specifically, it raises
        :exc:`~websockets.exceptions.ConnectionClosedOK` after a normal closure
        and :exc:`~websockets.exceptions.ConnectionClosedError` after a protocol
        error or a network failure. This is how you detect the end of the
        message stream.

        If ``timeout`` is :obj:`None`, block until a message is received. If
        ``timeout`` is set, wait up to ``timeout`` seconds for a message to be
        received and return it, else raise :exc:`TimeoutError`. If ``timeout``
        is ``0`` or negative, check if a message has been received already and
        return it, else raise :exc:`TimeoutError`.

        When the message is fragmented, :meth:`recv` waits until all fragments
        are received, reassembles them, and returns the whole message.

        Args:
            timeout: Timeout for receiving a message in seconds.
            decode: Set this flag to override the default behavior of returning
                :class:`str` or :class:`bytes`. See below for details.

        Returns:
            A string (:class:`str`) for a Text_ frame or a bytestring
            (:class:`bytes`) for a Binary_ frame.

            .. _Text: https://datatracker.ietf.org/doc/html/rfc6455#section-5.6
            .. _Binary: https://datatracker.ietf.org/doc/html/rfc6455#section-5.6

            You may override this behavior with the ``decode`` argument:

            * Set ``decode=False`` to disable UTF-8 decoding of Text_ frames and
              return a bytestring (:class:`bytes`). This improves performance
              when decoding isn't needed, for example if the message contains
              JSON and you're using a JSON library that expects a bytestring.
            * Set ``decode=True`` to force UTF-8 decoding of Binary_ frames and
              return strings (:class:`str`). This may be useful for servers that
              send binary frames instead of text frames.

        Raises:
            ConnectionClosed: When the connection is closed.
            ConcurrencyError: If two threads call :meth:`recv` or
                :meth:`recv_streaming` concurrently.

        """
        try:
            return self.recv_messages.get(timeout, decode)
        except EOFError:
            pass
            # fallthrough
        except ConcurrencyError:
            raise ConcurrencyError(
                "cannot call recv while another thread "
                "is already running recv or recv_streaming"
            ) from None
        except UnicodeDecodeError as exc:
            with self.send_context():
                self.protocol.fail(
                    CloseCode.INVALID_DATA,
                    f"{exc.reason} at position {exc.start}",
                )
            # fallthrough

        # Wait for the protocol state to be CLOSED before accessing close_exc.
        self.recv_events_thread.join()
        raise self.protocol.close_exc from self.recv_exc

    @overload
    def recv_streaming(self, decode: Literal[True]) -> Iterator[str]: ...

    @overload
    def recv_streaming(self, decode: Literal[False]) -> Iterator[bytes]: ...

    @overload
    def recv_streaming(self, decode: bool | None = None) -> Iterator[Data]: ...

    def recv_streaming(self, decode: bool | None = None) -> Iterator[Data]:
        """
        Receive the next message frame by frame.

        This method is designed for receiving fragmented messages. It returns an
        iterator that yields each fragment as it is received. This iterator must
        be fully consumed. Else, future calls to :meth:`recv` or
        :meth:`recv_streaming` will raise
        :exc:`~websockets.exceptions.ConcurrencyError`, making the connection
        unusable.

        :meth:`recv_streaming` raises the same exceptions as :meth:`recv`.

        Args:
            decode: Set this flag to override the default behavior of returning
                :class:`str` or :class:`bytes`. See below for details.

        Returns:
            An iterator of strings (:class:`str`) for a Text_ frame or
            bytestrings (:class:`bytes`) for a Binary_ frame.

            .. _Text: https://datatracker.ietf.org/doc/html/rfc6455#section-5.6
            .. _Binary: https://datatracker.ietf.org/doc/html/rfc6455#section-5.6

            You may override this behavior with the ``decode`` argument:

            * Set ``decode=False`` to disable UTF-8 decoding of Text_ frames and
              yield bytestrings (:class:`bytes`). This improves performance
              when decoding isn't needed.
            * Set ``decode=True`` to force UTF-8 decoding of Binary_ frames and
              yield strings (:class:`str`). This may be useful for servers that
              send binary frames instead of text frames.

        Raises:
            ConnectionClosed: When the connection is closed.
            ConcurrencyError: If two threads call :meth:`recv` or
                :meth:`recv_streaming` concurrently.

        """
        try:
            yield from self.recv_messages.get_iter(decode)
            return
        except EOFError:
            pass
            # fallthrough
        except ConcurrencyError:
            raise ConcurrencyError(
                "cannot call recv_streaming while another thread "
                "is already running recv or recv_streaming"
            ) from None
        except UnicodeDecodeError as exc:
            with self.send_context():
                self.protocol.fail(
                    CloseCode.INVALID_DATA,
                    f"{exc.reason} at position {exc.start}",
                )
            # fallthrough

        # Wait for the protocol state to be CLOSED before accessing close_exc.
        self.recv_events_thread.join()
        raise self.protocol.close_exc from self.recv_exc

    def send(
        self,
        message: DataLike | Iterable[DataLike],
        text: bool | None = None,
    ) -> None:
        """
        Send a message.

        A string (:class:`str`) is sent as a Text_ frame. A bytestring or
        bytes-like object (:class:`bytes`, :class:`bytearray`, or
        :class:`memoryview`) is sent as a Binary_ frame.

        .. _Text: https://datatracker.ietf.org/doc/html/rfc6455#section-5.6
        .. _Binary: https://datatracker.ietf.org/doc/html/rfc6455#section-5.6

        You may override this behavior with the ``text`` argument:

        * Set ``text=True`` to send an UTF-8 bytestring or bytes-like object
          (:class:`bytes`, :class:`bytearray`, or :class:`memoryview`) in a
          Text_ frame. This improves performance when the message is already
          UTF-8 encoded, for example if the message contains JSON and you're
          using a JSON library that produces a bytestring.
        * Set ``text=False`` to send a string (:class:`str`) in a Binary_
          frame. This may be useful for servers that expect binary frames
          instead of text frames.

        :meth:`send` also accepts an iterable of strings, bytestrings, or
        bytes-like objects to enable fragmentation_. Each item is treated as a
        message fragment and sent in its own frame. All items must be of the
        same type, or else :meth:`send` will raise a :exc:`TypeError` and the
        connection will be closed.

        .. _fragmentation: https://datatracker.ietf.org/doc/html/rfc6455#section-5.4

        :meth:`send` rejects dict-like objects because this is often an error.
        (If you really want to send the keys of a dict-like object as fragments,
        call its :meth:`~dict.keys` method and pass the result to :meth:`send`.)

        When the connection is closed, :meth:`send` raises
        :exc:`~websockets.exceptions.ConnectionClosed`. Specifically, it
        raises :exc:`~websockets.exceptions.ConnectionClosedOK` after a normal
        connection closure and
        :exc:`~websockets.exceptions.ConnectionClosedError` after a protocol
        error or a network failure.

        Args:
            message: Message to send.

        Raises:
            ConnectionClosed: When the connection is closed.
            ConcurrencyError: If the connection is sending a fragmented message.
            TypeError: If ``message`` doesn't have a supported type.

        """
        # Unfragmented message -- this case must be handled first because
        # strings and bytes-like objects are iterable.

        if isinstance(message, str):
            with self.send_context():
                if self.send_in_progress:
                    raise ConcurrencyError(
                        "cannot call send while another thread is already running send"
                    )
                if text is False:
                    self.protocol.send_binary(message.encode())
                else:
                    self.protocol.send_text(message.encode())

        elif isinstance(message, BytesLike):
            with self.send_context():
                if self.send_in_progress:
                    raise ConcurrencyError(
                        "cannot call send while another thread is already running send"
                    )
                if text is True:
                    self.protocol.send_text(message)
                else:
                    self.protocol.send_binary(message)

        # Catch a common mistake -- passing a dict to send().

        elif isinstance(message, Mapping):
            raise TypeError("data is a dict-like object")

        # Fragmented message -- regular iterator.

        elif isinstance(message, Iterable):
            chunks = iter(message)
            try:
                chunk = next(chunks)
            except StopIteration:
                return

            try:
                # First fragment.
                if isinstance(chunk, str):
                    with self.send_context():
                        if self.send_in_progress:
                            raise ConcurrencyError(
                                "cannot call send while another thread "
                                "is already running send"
                            )
                        self.send_in_progress = True
                        if text is False:
                            self.protocol.send_binary(chunk.encode(), fin=False)
                        else:
                            self.protocol.send_text(chunk.encode(), fin=False)
                    encode = True
                elif isinstance(chunk, BytesLike):
                    with self.send_context():
                        if self.send_in_progress:
                            raise ConcurrencyError(
                                "cannot call send while another thread "
                                "is already running send"
                            )
                        self.send_in_progress = True
                        if text is True:
                            self.protocol.send_text(chunk, fin=False)
                        else:
                            self.protocol.send_binary(chunk, fin=False)
                    encode = False
                else:
                    raise TypeError("iterable must contain bytes or str")

                # Other fragments
                for chunk in chunks:
                    if isinstance(chunk, str) and encode:
                        with self.send_context():
                            assert self.send_in_progress
                            self.protocol.send_continuation(chunk.encode(), fin=False)
                    elif isinstance(chunk, BytesLike) and not encode:
                        with self.send_context():
                            assert self.send_in_progress
                            self.protocol.send_continuation(chunk, fin=False)
                    else:
                        raise TypeError("iterable must contain uniform types")

                # Final fragment.
                with self.send_context():
                    self.protocol.send_continuation(b"", fin=True)
                    self.send_in_progress = False

            except ConcurrencyError:
                # We didn't start sending a fragmented message.
                # The connection is still usable.
                raise

            except Exception:
                # We're half-way through a fragmented message and we can't
                # complete it. This makes the connection unusable.
                with self.send_context():
                    self.protocol.fail(
                        CloseCode.INTERNAL_ERROR,
                        "error in fragmented message",
                    )
                raise

        else:
            raise TypeError("data must be str, bytes, or iterable")

    def close(
        self,
        code: CloseCode | int = CloseCode.NORMAL_CLOSURE,
        reason: str = "",
    ) -> None:
        """
        Perform the closing handshake.

        :meth:`close` waits for the other end to complete the handshake and
        for the TCP connection to terminate.

        :meth:`close` is idempotent: it doesn't do anything once the
        connection is closed.

        Args:
            code: WebSocket close code.
            reason: WebSocket close reason.

        """
        try:
            # The context manager takes care of waiting for the TCP connection
            # to terminate after calling a method that sends a close frame.
            with self.send_context():
                if self.send_in_progress:
                    self.protocol.fail(
                        CloseCode.INTERNAL_ERROR,
                        "close during fragmented message",
                    )
                else:
                    self.protocol.send_close(code, reason)
        except ConnectionClosed:
            # Ignore ConnectionClosed exceptions raised from send_context().
            # They mean that the connection is closed, which was the goal.
            pass

    def ping(
        self,
        data: DataLike | None = None,
        ack_on_close: bool = False,
    ) -> threading.Event:
        """
        Send a Ping_.

        .. _Ping: https://datatracker.ietf.org/doc/html/rfc6455#section-5.5.2

        A ping may serve as a keepalive or as a check that the remote endpoint
        received all messages up to this point

        Args:
            data: Payload of the ping. A :class:`str` will be encoded to UTF-8.
                If ``data`` is :obj:`None`, the payload is four random bytes.
            ack_on_close: when this option is :obj:`True`, the event will also
                be set when the connection is closed. While this avoids getting
                stuck waiting for a pong that will never arrive, it requires
                checking that the state of the connection is still ``OPEN`` to
                confirm that a pong was received, rather than the connection
                being closed.

        Returns:
            An event that will be set when the corresponding pong is received.
            You can ignore it if you don't intend to wait.

            ::

                pong_received = ws.ping()
                # only if you want to wait for the corresponding pong
                pong_received.wait()

        Raises:
            ConnectionClosed: When the connection is closed.
            ConcurrencyError: If another ping was sent with the same data and
                the corresponding pong wasn't received yet.

        """
        if isinstance(data, BytesLike):
            data = bytes(data)
        elif isinstance(data, str):
            data = data.encode()
        elif data is not None:
            raise TypeError("data must be str or bytes-like")

        with self.send_context():
            # Protect against duplicates if a payload is explicitly set.
            if data in self.pending_pings:
                raise ConcurrencyError("already waiting for a pong with the same data")

            # Generate a unique random payload otherwise.
            while data is None or data in self.pending_pings:
                data = struct.pack("!I", random.getrandbits(32))

            pong_received = threading.Event()
            ping_timestamp = time.monotonic()
            self.pending_pings[data] = (pong_received, ping_timestamp, ack_on_close)
            self.protocol.send_ping(data)
            return pong_received

    def pong(self, data: DataLike = b"") -> None:
        """
        Send a Pong_.

        .. _Pong: https://datatracker.ietf.org/doc/html/rfc6455#section-5.5.3

        An unsolicited pong may serve as a unidirectional heartbeat.

        Args:
            data: Payload of the pong. A :class:`str` will be encoded to UTF-8.

        Raises:
            ConnectionClosed: When the connection is closed.

        """
        if isinstance(data, BytesLike):
            data = bytes(data)
        elif isinstance(data, str):
            data = data.encode()
        else:
            raise TypeError("data must be str or bytes-like")

        with self.send_context():
            self.protocol.send_pong(data)

    # Private methods

    def process_event(self, event: Event) -> None:
        """
        Process one incoming event.

        This method is overridden in subclasses to handle the handshake.

        """
        assert isinstance(event, Frame)
        if event.opcode in DATA_OPCODES:
            self.recv_messages.put(event)

        if event.opcode is Opcode.PONG:
            self.acknowledge_pings(bytes(event.data))

    def acknowledge_pings(self, data: bytes) -> None:
        """
        Acknowledge pings when receiving a pong.

        """
        with self.protocol_mutex:
            # Ignore unsolicited pong.
            if data not in self.pending_pings:
                return

            pong_timestamp = time.monotonic()

            # Sending a pong for only the most recent ping is legal.
            # Acknowledge all previous pings too in that case.
            ping_id = None
            ping_ids = []
            for ping_id, (
                pong_received,
                ping_timestamp,
                _ack_on_close,
            ) in self.pending_pings.items():
                ping_ids.append(ping_id)
                pong_received.set()
                if ping_id == data:
                    self.latency = pong_timestamp - ping_timestamp
                    break
            else:
                raise AssertionError("solicited pong not found in pings")

            # Remove acknowledged pings from self.pending_pings.
            for ping_id in ping_ids:
                del self.pending_pings[ping_id]

    def terminate_pending_pings(self) -> None:
        """
        Acknowledge pending pings when the connection is closed.

        """
        assert self.protocol_mutex.locked()
        assert self.protocol.state is CLOSED

        for pong_received, _ping_timestamp, ack_on_close in self.pending_pings.values():
            if ack_on_close:
                pong_received.set()

        self.pending_pings.clear()

    def keepalive(self) -> None:
        """
        Send a Ping frame and wait for a Pong frame at regular intervals.

        """
        assert self.ping_interval is not None
        try:
            while True:
                # If self.ping_timeout > self.latency > self.ping_interval,
                # pings will be sent immediately after receiving pongs.
                # The period will be longer than self.ping_interval.
                self.recv_events_thread.join(self.ping_interval - self.latency)
                if not self.recv_events_thread.is_alive():
                    break

                try:
                    pong_received = self.ping(ack_on_close=True)
                except ConnectionClosed:
                    break
                if self.debug:
                    self.logger.debug("% sent keepalive ping")

                if self.ping_timeout is not None:
                    if pong_received.wait(self.ping_timeout):
                        if self.debug:
                            self.logger.debug("% received keepalive pong")
                    else:
                        if self.debug:
                            self.logger.debug("- timed out waiting for keepalive pong")
                        with self.send_context():
                            self.protocol.fail(
                                CloseCode.INTERNAL_ERROR,
                                "keepalive ping timeout",
                            )
                        break
        except Exception:
            self.logger.error("keepalive ping failed", exc_info=True)

    def start_keepalive(self) -> None:
        """
        Run :meth:`keepalive` in a thread, unless keepalive is disabled.

        """
        if self.ping_interval is not None:
            # This thread is marked as daemon like self.recv_events_thread.
            self.keepalive_thread = threading.Thread(
                target=self.keepalive,
                daemon=True,
            )
            self.keepalive_thread.start()

    def recv_events(self) -> None:
        """
        Read incoming data from the socket and process events.

        Run this method in a thread as long as the connection is alive.

        ``recv_events()`` exits immediately when ``self.socket`` is closed.

        """
        try:
            while True:
                try:
                    # If the assembler buffer is full, block until it drains.
                    with self.recv_flow_control:
                        pass
                    if self.close_deadline is not None:
                        self.socket.settimeout(self.close_deadline.timeout())
                    data = self.socket.recv(self.recv_bufsize)
                except Exception as exc:
                    if self.debug:
                        self.logger.debug(
                            "! error while receiving data",
                            exc_info=True,
                        )
                    # When the closing handshake is initiated by our side,
                    # recv() may block until send_context() closes the socket.
                    # In that case, send_context() already set recv_exc.
                    # Calling set_recv_exc() avoids overwriting it.
                    with self.protocol_mutex:
                        self.set_recv_exc(exc)
                    break

                if data == b"":
                    break

                # Acquire the connection lock.
                with self.protocol_mutex:
                    # Feed incoming data to the protocol.
                    self.protocol.receive_data(data)

                    # This isn't expected to raise an exception.
                    events = self.protocol.events_received()

                    # Write outgoing data to the socket.
                    try:
                        self.send_data()
                    except Exception as exc:
                        if self.debug:
                            self.logger.debug(
                                "! error while sending data",
                                exc_info=True,
                            )
                        # Similarly to the above, avoid overriding an exception
                        # set by send_context(), in case of a race condition
                        # i.e. send_context() closes the socket after recv()
                        # returns above but before send_data() calls send().
                        self.set_recv_exc(exc)
                        break

                    # If needed, set the close deadline based on the close timeout.
                    if self.protocol.close_expected():
                        if self.close_deadline is None:
                            self.close_deadline = Deadline(self.close_timeout)

                # Unlock conn_mutex before processing events. Else, the
                # application can't send messages in response to events.

                # If self.send_data raised an exception, then events are lost.
                # Given that automatic responses write small amounts of data,
                # this should be uncommon, so we don't handle the edge case.

                for event in events:
                    # This isn't expected to raise an exception.
                    self.process_event(event)

            # Breaking out of the while True: ... loop means that we believe
            # that the socket doesn't work anymore.

            with self.protocol_mutex:
                # Feed the end of the data stream to the protocol.
                self.protocol.receive_eof()

                # This isn't expected to raise an exception.
                events = self.protocol.events_received()

                # There is no error handling because send_data() can only write
                # the end of the data stream and it handles errors by itself.
                self.send_data()

            # This code path is triggered when receiving an HTTP response
            # without a Content-Length header. This is the only case where
            # reading until EOF generates an event; all other events have
            # a known length. Ignore for coverage measurement because tests
            # are in test_client.py rather than test_connection.py.
            for event in events:  # pragma: no cover
                # This isn't expected to raise an exception.
                self.process_event(event)

        except Exception as exc:
            # This branch should never run. It's a safety net in case of bugs.
            self.logger.error("unexpected internal error", exc_info=True)
            with self.protocol_mutex:
                self.set_recv_exc(exc)
        finally:
            # This isn't expected to raise an exception.
            self.close_socket()

    @contextlib.contextmanager
    def send_context(
        self,
        *,
        expected_state: State = OPEN,  # CONNECTING during the opening handshake
    ) -> Iterator[None]:
        """
        Create a context for writing to the connection from user code.

        On entry, :meth:`send_context` acquires the connection lock and checks
        that the connection is open; on exit, it writes outgoing data to the
        socket and releases the connection lock::

            with self.send_context():
                self.protocol.send_text(message.encode())

        When the connection isn't open on entry, when the connection is expected
        to close on exit, or when an unexpected error happens, terminating the
        connection, :meth:`send_context` waits until the connection is closed
        then raises :exc:`~websockets.exceptions.ConnectionClosed`.

        """
        # Should we wait until the connection is closed?
        wait_for_close = False
        # Should we close the socket and raise ConnectionClosed?
        raise_close_exc = False
        # What exception should we chain ConnectionClosed to?
        original_exc: BaseException | None = None

        # Acquire the protocol lock.
        with self.protocol_mutex:
            if self.protocol.state is expected_state:
                # Let the caller interact with the protocol.
                try:
                    yield
                except (ProtocolError, ConcurrencyError):
                    # The protocol state wasn't changed. Exit immediately.
                    raise
                except Exception as exc:
                    self.logger.error("unexpected internal error", exc_info=True)
                    # This branch should never run. It's a safety net in case of
                    # bugs. Since we don't know what happened, we will close the
                    # connection and raise the exception to the caller.
                    wait_for_close = False
                    raise_close_exc = True
                    original_exc = exc
                else:
                    # Check if the connection is expected to close soon.
                    if self.protocol.close_expected():
                        wait_for_close = True
                        # Set the close deadline based on the close timeout.
                        # Since we tested earlier that protocol.state is OPEN
                        # (or CONNECTING) and we didn't release protocol_mutex,
                        # self.close_deadline is still None.
                        assert self.close_deadline is None
                        self.close_deadline = Deadline(self.close_timeout)
                    # Write outgoing data to the socket.
                    try:
                        self.send_data()
                    except Exception as exc:
                        if self.debug:
                            self.logger.debug(
                                "! error while sending data",
                                exc_info=True,
                            )
                        # While the only expected exception here is OSError,
                        # other exceptions would be treated identically.
                        wait_for_close = False
                        raise_close_exc = True
                        original_exc = exc

            else:  # self.protocol.state is not expected_state
                # Minor layering violation: we assume that the connection
                # will be closing soon if it isn't in the expected state.
                wait_for_close = True
                # Calculate close_deadline if it wasn't set yet.
                if self.close_deadline is None:
                    self.close_deadline = Deadline(self.close_timeout)
                raise_close_exc = True

        # To avoid a deadlock, release the connection lock by exiting the
        # context manager before waiting for recv_events() to terminate.

        # If the connection is expected to close soon and the close timeout
        # elapses, close the socket to terminate the connection.
        if wait_for_close:
            # Thread.join() returns immediately if timeout is negative.
            assert self.close_deadline is not None
            timeout = self.close_deadline.timeout(raise_if_elapsed=False)
            self.recv_events_thread.join(timeout)
            if self.recv_events_thread.is_alive():
                # There's no risk of overwriting another error because
                # original_exc is never set when wait_for_close is True.
                assert original_exc is None
                original_exc = TimeoutError("timed out while closing connection")
                # Set recv_exc before closing the socket in order to get
                # proper exception reporting.
                raise_close_exc = True
                with self.protocol_mutex:
                    self.set_recv_exc(original_exc)

        # If an error occurred, close the socket to terminate the connection and
        # raise an exception.
        if raise_close_exc:
            self.close_socket()
            # Wait for the protocol state to be CLOSED before accessing close_exc.
            self.recv_events_thread.join()
            raise self.protocol.close_exc from original_exc

    def send_data(self) -> None:
        """
        Send outgoing data.

        This method requires holding protocol_mutex.

        """
        assert self.protocol_mutex.locked()
        for data in self.protocol.data_to_send():
            if data:
                if self.close_deadline is not None:
                    self.socket.settimeout(self.close_deadline.timeout())
                self.socket.sendall(data)
            else:
                try:
                    self.socket.shutdown(socket.SHUT_WR)
                except OSError:  # socket already closed
                    pass

    def set_recv_exc(self, exc: BaseException | None) -> None:
        """
        Set recv_exc, if not set yet.

        This method requires holding protocol_mutex and must be called only from
        the thread running recv_events().

        """
        assert self.protocol_mutex.locked()
        if self.recv_exc is None:
            self.recv_exc = exc

    def close_socket(self) -> None:
        """
        Shutdown and close socket. Close message assembler.

        Calling close_socket() guarantees that recv_events() terminates. Indeed,
        recv_events() may block only on socket.recv() or on recv_messages.put().

        """
        # shutdown() is required to interrupt recv() on Linux.
        try:
            self.socket.shutdown(socket.SHUT_RDWR)
        except OSError:  # socket already closed
            pass
        self.socket.close()

        # Calling protocol.receive_eof() is safe because it's idempotent.
        # This guarantees that the protocol state becomes CLOSED.
        with self.protocol_mutex:
            self.protocol.receive_eof()
            assert self.protocol.state is CLOSED

            # Abort recv() with a ConnectionClosed exception.
            self.recv_messages.close()

            # Acknowledge pings sent with the ack_on_close option.
            self.terminate_pending_pings()
