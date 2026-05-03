from __future__ import annotations

import enum
import logging
import uuid
from collections.abc import Generator

from .exceptions import (
    ConnectionClosed,
    ConnectionClosedError,
    ConnectionClosedOK,
    InvalidState,
    PayloadTooBig,
    ProtocolError,
)
from .extensions import Extension
from .frames import (
    OK_CLOSE_CODES,
    OP_BINARY,
    OP_CLOSE,
    OP_CONT,
    OP_PING,
    OP_PONG,
    OP_TEXT,
    Close,
    CloseCode,
    Frame,
)
from .http11 import Request, Response
from .streams import StreamReader
from .typing import BytesLike, LoggerLike, Origin, Subprotocol


__all__ = [
    "Protocol",
    "Side",
    "State",
    "SEND_EOF",
]

Event = Request | Response | Frame
"""Events that :meth:`~Protocol.events_received` may return."""


class Side(enum.IntEnum):
    """A WebSocket connection is either a server or a client."""

    SERVER, CLIENT = range(2)


SERVER = Side.SERVER
CLIENT = Side.CLIENT


class State(enum.IntEnum):
    """A WebSocket connection is in one of these four states."""

    CONNECTING, OPEN, CLOSING, CLOSED = range(4)


CONNECTING = State.CONNECTING
OPEN = State.OPEN
CLOSING = State.CLOSING
CLOSED = State.CLOSED


SEND_EOF = b""
"""Sentinel signaling that the TCP connection must be half-closed."""


class Protocol:
    """
    Sans-I/O implementation of a WebSocket connection.

    Args:
        side: :attr:`~Side.CLIENT` or :attr:`~Side.SERVER`.
        state: Initial state of the WebSocket connection.
        max_size: Maximum size of incoming messages in bytes.
            :obj:`None` disables the limit. You may pass a ``(max_message_size,
            max_fragment_size)`` tuple to set different limits for messages and
            fragments when you expect long messages sent in short fragments.
        logger: Logger for this connection; depending on ``side``,
            defaults to ``logging.getLogger("websockets.client")``
            or ``logging.getLogger("websockets.server")``;
            see the :doc:`logging guide <../../topics/logging>` for details.

    """

    def __init__(
        self,
        side: Side,
        *,
        state: State = OPEN,
        max_size: tuple[int | None, int | None] | int | None = 2**20,
        logger: LoggerLike | None = None,
    ) -> None:
        # Unique identifier. For logs.
        self.id: uuid.UUID = uuid.uuid4()
        """Unique identifier of the connection. Useful in logs."""

        # Logger or LoggerAdapter for this connection.
        if logger is None:
            logger = logging.getLogger(f"websockets.{side.name.lower()}")
        self.logger: LoggerLike = logger
        """Logger for this connection."""

        # Track if DEBUG is enabled. Shortcut logging calls if it isn't.
        self.debug = logger.isEnabledFor(logging.DEBUG)

        # Connection side. CLIENT or SERVER.
        self.side = side

        # Connection state. Initially OPEN because subclasses handle CONNECTING.
        self.state = state

        # Maximum size of incoming messages in bytes.
        if isinstance(max_size, int) or max_size is None:
            self.max_message_size, self.max_fragment_size = max_size, None
        else:
            self.max_message_size, self.max_fragment_size = max_size

        # Current size of incoming message in bytes. Only set while reading a
        # fragmented message i.e. a data frames with the FIN bit not set.
        self.current_size: int | None = None

        # True while sending a fragmented message i.e. a data frames with the
        # FIN bit not set.
        self.expect_continuation_frame = False

        # WebSocket protocol parameters.
        self.origin: Origin | None = None
        self.extensions: list[Extension] = []
        self.subprotocol: Subprotocol | None = None

        # Close code and reason, set when a close frame is sent or received.
        self.close_rcvd: Close | None = None
        self.close_sent: Close | None = None
        self.close_rcvd_then_sent: bool | None = None

        # Track if an exception happened during the handshake.
        self.handshake_exc: Exception | None = None
        """
        Exception to raise if the opening handshake failed.

        :obj:`None` if the opening handshake succeeded.

        """

        # Track if send_eof() was called.
        self.eof_sent = False

        # Parser state.
        self.reader = StreamReader()
        self.events: list[Event] = []
        self.writes: list[bytes] = []
        self.parser = self.parse()
        next(self.parser)  # start coroutine
        self.parser_exc: Exception | None = None

    @property
    def state(self) -> State:
        """
        State of the WebSocket connection.

        Defined in 4.1_, 4.2_, 7.1.3_, and 7.1.4_ of :rfc:`6455`.

        .. _4.1: https://datatracker.ietf.org/doc/html/rfc6455#section-4.1
        .. _4.2: https://datatracker.ietf.org/doc/html/rfc6455#section-4.2
        .. _7.1.3: https://datatracker.ietf.org/doc/html/rfc6455#section-7.1.3
        .. _7.1.4: https://datatracker.ietf.org/doc/html/rfc6455#section-7.1.4

        """
        return self._state

    @state.setter
    def state(self, state: State) -> None:
        if self.debug:
            self.logger.debug("= connection is %s", state.name)
        self._state = state

    @property
    def close_code(self) -> int | None:
        """
        WebSocket close code received from the remote endpoint.

        Defined in 7.1.5_ of :rfc:`6455`.

        .. _7.1.5: https://datatracker.ietf.org/doc/html/rfc6455#section-7.1.5

        :obj:`None` if the connection isn't closed yet.

        """
        if self.state is not CLOSED:
            return None
        elif self.close_rcvd is None:
            return CloseCode.ABNORMAL_CLOSURE
        else:
            return self.close_rcvd.code

    @property
    def close_reason(self) -> str | None:
        """
        WebSocket close reason  received from the remote endpoint.

        Defined in 7.1.6_ of :rfc:`6455`.

        .. _7.1.6: https://datatracker.ietf.org/doc/html/rfc6455#section-7.1.6

        :obj:`None` if the connection isn't closed yet.

        """
        if self.state is not CLOSED:
            return None
        elif self.close_rcvd is None:
            return ""
        else:
            return self.close_rcvd.reason

    @property
    def close_exc(self) -> ConnectionClosed:
        """
        Exception to raise when trying to interact with a closed connection.

        Don't raise this exception while the connection :attr:`state`
        is :attr:`~websockets.protocol.State.CLOSING`; wait until
        it's :attr:`~websockets.protocol.State.CLOSED`.

        Indeed, the exception includes the close code and reason, which are
        known only once the connection is closed.

        Raises:
            AssertionError: If the connection isn't closed yet.

        """
        assert self.state is CLOSED, "connection isn't closed yet"
        exc_type: type[ConnectionClosed]
        if (
            self.close_rcvd is not None
            and self.close_sent is not None
            and self.close_rcvd.code in OK_CLOSE_CODES
            and self.close_sent.code in OK_CLOSE_CODES
        ):
            exc_type = ConnectionClosedOK
        else:
            exc_type = ConnectionClosedError
        exc: ConnectionClosed = exc_type(
            self.close_rcvd,
            self.close_sent,
            self.close_rcvd_then_sent,
        )
        # Chain to the exception raised in the parser, if any.
        exc.__cause__ = self.parser_exc
        return exc

    # Public methods for receiving data.

    def receive_data(self, data: bytes | bytearray) -> None:
        """
        Receive data from the network.

        After calling this method:

        - You must call :meth:`data_to_send` and send this data to the network.
        - You should call :meth:`events_received` and process resulting events.

        Raises:
            EOFError: If :meth:`receive_eof` was called earlier.

        """
        self.reader.feed_data(data)
        next(self.parser)

    def receive_eof(self) -> None:
        """
        Receive the end of the data stream from the network.

        After calling this method:

        - You must call :meth:`data_to_send` and send this data to the network;
          it will return ``[b""]``, signaling the end of the stream, or ``[]``.
        - You aren't expected to call :meth:`events_received`; it won't return
          any new events.

        :meth:`receive_eof` is idempotent.

        """
        if self.reader.eof:
            return
        self.reader.feed_eof()
        next(self.parser)

    # Public methods for sending events.

    def send_continuation(self, data: BytesLike, fin: bool) -> None:
        """
        Send a `Continuation frame`_.

        .. _Continuation frame:
            https://datatracker.ietf.org/doc/html/rfc6455#section-5.6

        Parameters:
            data: payload containing the same kind of data
                as the initial frame.
            fin: FIN bit; set it to :obj:`True` if this is the last frame
                of a fragmented message and to :obj:`False` otherwise.

        Raises:
            ProtocolError: If a fragmented message isn't in progress.

        """
        if not self.expect_continuation_frame:
            raise ProtocolError("unexpected continuation frame")
        if self._state is not OPEN:
            raise InvalidState(f"connection is {self.state.name.lower()}")
        self.expect_continuation_frame = not fin
        self.send_frame(Frame(OP_CONT, data, fin))

    def send_text(self, data: BytesLike, fin: bool = True) -> None:
        """
        Send a `Text frame`_.

        .. _Text frame:
            https://datatracker.ietf.org/doc/html/rfc6455#section-5.6

        Parameters:
            data: payload containing text encoded with UTF-8.
            fin: FIN bit; set it to :obj:`False` if this is the first frame of
                a fragmented message.

        Raises:
            ProtocolError: If a fragmented message is in progress.

        """
        if self.expect_continuation_frame:
            raise ProtocolError("expected a continuation frame")
        if self._state is not OPEN:
            raise InvalidState(f"connection is {self.state.name.lower()}")
        self.expect_continuation_frame = not fin
        self.send_frame(Frame(OP_TEXT, data, fin))

    def send_binary(self, data: BytesLike, fin: bool = True) -> None:
        """
        Send a `Binary frame`_.

        .. _Binary frame:
            https://datatracker.ietf.org/doc/html/rfc6455#section-5.6

        Parameters:
            data: payload containing arbitrary binary data.
            fin: FIN bit; set it to :obj:`False` if this is the first frame of
                a fragmented message.

        Raises:
            ProtocolError: If a fragmented message is in progress.

        """
        if self.expect_continuation_frame:
            raise ProtocolError("expected a continuation frame")
        if self._state is not OPEN:
            raise InvalidState(f"connection is {self.state.name.lower()}")
        self.expect_continuation_frame = not fin
        self.send_frame(Frame(OP_BINARY, data, fin))

    def send_close(self, code: CloseCode | int | None = None, reason: str = "") -> None:
        """
        Send a `Close frame`_.

        .. _Close frame:
            https://datatracker.ietf.org/doc/html/rfc6455#section-5.5.1

        Parameters:
            code: close code.
            reason: close reason.

        Raises:
            ProtocolError: If the code isn't valid or if a reason is provided
                without a code.

        """
        # While RFC 6455 doesn't rule out sending more than one close Frame,
        # websockets is conservative in what it sends and doesn't allow that.
        if self._state is not OPEN:
            raise InvalidState(f"connection is {self.state.name.lower()}")
        if code is None:
            if reason != "":
                raise ProtocolError("cannot send a reason without a code")
            close = Close(CloseCode.NO_STATUS_RCVD, "")
            data = b""
        else:
            close = Close(code, reason)
            data = close.serialize()
        # 7.1.3. The WebSocket Closing Handshake is Started
        self.send_frame(Frame(OP_CLOSE, data))
        # Since the state is OPEN, no close frame was received yet.
        # As a consequence, self.close_rcvd_then_sent remains None.
        assert self.close_rcvd is None
        self.close_sent = close
        self.state = CLOSING

    def send_ping(self, data: BytesLike) -> None:
        """
        Send a `Ping frame`_.

        .. _Ping frame:
            https://datatracker.ietf.org/doc/html/rfc6455#section-5.5.2

        Parameters:
            data: payload containing arbitrary binary data.

        """
        # RFC 6455 allows control frames after starting the closing handshake.
        if self._state is not OPEN and self._state is not CLOSING:
            raise InvalidState(f"connection is {self.state.name.lower()}")
        self.send_frame(Frame(OP_PING, data))

    def send_pong(self, data: BytesLike) -> None:
        """
        Send a `Pong frame`_.

        .. _Pong frame:
            https://datatracker.ietf.org/doc/html/rfc6455#section-5.5.3

        Parameters:
            data: payload containing arbitrary binary data.

        """
        # RFC 6455 allows control frames after starting the closing handshake.
        if self._state is not OPEN and self._state is not CLOSING:
            raise InvalidState(f"connection is {self.state.name.lower()}")
        self.send_frame(Frame(OP_PONG, data))

    def fail(self, code: CloseCode | int, reason: str = "") -> None:
        """
        `Fail the WebSocket connection`_.

        .. _Fail the WebSocket connection:
            https://datatracker.ietf.org/doc/html/rfc6455#section-7.1.7

        Parameters:
            code: close code
            reason: close reason

        Raises:
            ProtocolError: If the code isn't valid.
        """
        # 7.1.7. Fail the WebSocket Connection

        # Send a close frame when the state is OPEN (a close frame was already
        # sent if it's CLOSING), except when failing the connection because
        # of an error reading from or writing to the network.
        if self.state is OPEN:
            if code != CloseCode.ABNORMAL_CLOSURE:
                close = Close(code, reason)
                data = close.serialize()
                self.send_frame(Frame(OP_CLOSE, data))
                self.close_sent = close
                # If recv_messages() raised an exception upon receiving a close
                # frame but before echoing it, then close_rcvd is not None even
                # though the state is OPEN. This happens when the connection is
                # closed while receiving a fragmented message.
                if self.close_rcvd is not None:
                    self.close_rcvd_then_sent = True
                self.state = CLOSING

        # When failing the connection, a server closes the TCP connection
        # without waiting for the client to complete the handshake, while a
        # client waits for the server to close the TCP connection, possibly
        # after sending a close frame that the client will ignore.
        if self.side is SERVER and not self.eof_sent:
            self.send_eof()

        # 7.1.7. Fail the WebSocket Connection "An endpoint MUST NOT continue
        # to attempt to process data(including a responding Close frame) from
        # the remote endpoint after being instructed to _Fail the WebSocket
        # Connection_."
        self.parser = self.discard()
        next(self.parser)  # start coroutine

    # Public method for getting incoming events after receiving data.

    def events_received(self) -> list[Event]:
        """
        Fetch events generated from data received from the network.

        Call this method immediately after any of the ``receive_*()`` methods.

        Process resulting events, likely by passing them to the application.

        Returns:
            Events read from the connection.
        """
        events, self.events = self.events, []
        return events

    # Public method for getting outgoing data after receiving data or sending events.

    def data_to_send(self) -> list[bytes]:
        """
        Obtain data to send to the network.

        Call this method immediately after any of the ``receive_*()``,
        ``send_*()``, or :meth:`fail` methods.

        Write resulting data to the connection.

        The empty bytestring :data:`~websockets.protocol.SEND_EOF` signals
        the end of the data stream. When you receive it, half-close the TCP
        connection.

        Returns:
            Data to write to the connection.

        """
        writes, self.writes = self.writes, []
        return writes

    def close_expected(self) -> bool:
        """
        Tell if the TCP connection is expected to close soon.

        Call this method immediately after any of the ``receive_*()``,
        ``send_close()``, or :meth:`fail` methods.

        If it returns :obj:`True`, schedule closing the TCP connection after a
        short timeout if the other side hasn't already closed it.

        Returns:
            Whether the TCP connection is expected to close soon.

        """
        # During the opening handshake, when our state is CONNECTING, we expect
        # a TCP close if and only if the hansdake fails. When it does, we start
        # the TCP closing handshake by sending EOF with send_eof().

        # Once the opening handshake completes successfully, we expect a TCP
        # close if and only if we sent a close frame, meaning that our state
        # progressed to CLOSING:

        # * Normal closure: once we send a close frame, we expect a TCP close:
        #   server waits for client to complete the TCP closing handshake;
        #   client waits for server to initiate the TCP closing handshake.

        # * Abnormal closure: we always send a close frame and the same logic
        #   applies, except on EOFError where we don't send a close frame
        #   because we already received the TCP close, so we don't expect it.

        # If our state is CLOSED, we already received a TCP close so we don't
        # expect it anymore.

        # Micro-optimization: put the most common case first
        if self.state is OPEN:
            return False
        if self.state is CLOSING:
            return True
        if self.state is CLOSED:
            return False
        assert self.state is CONNECTING
        return self.eof_sent

    # Private methods for receiving data.

    def parse(self) -> Generator[None]:
        """
        Parse incoming data into frames.

        :meth:`receive_data` and :meth:`receive_eof` run this generator
        coroutine until it needs more data or reaches EOF.

        :meth:`parse` never raises an exception. Instead, it sets the
        :attr:`parser_exc` and yields control.

        """
        try:
            while True:
                if (yield from self.reader.at_eof()):
                    if self.debug:
                        self.logger.debug("< EOF")
                    # If the WebSocket connection is closed cleanly, with a
                    # closing handhshake, recv_frame() substitutes parse()
                    # with discard(). This branch is reached only when the
                    # connection isn't closed cleanly.
                    raise EOFError("unexpected end of stream")

                max_size = None

                if self.max_message_size is not None:
                    if self.current_size is None:
                        max_size = self.max_message_size
                    else:
                        max_size = self.max_message_size - self.current_size

                if self.max_fragment_size is not None:
                    if max_size is None:
                        max_size = self.max_fragment_size
                    else:
                        max_size = min(max_size, self.max_fragment_size)

                # During a normal closure, execution ends here on the next
                # iteration of the loop after receiving a close frame. At
                # this point, recv_frame() replaced parse() by discard().
                frame = yield from Frame.parse(
                    self.reader.read_exact,
                    mask=self.side is SERVER,
                    max_size=max_size,
                    extensions=self.extensions,
                )

                if self.debug:
                    self.logger.debug("< %s", frame)

                self.recv_frame(frame)

        except ProtocolError as exc:
            self.fail(CloseCode.PROTOCOL_ERROR, str(exc))
            self.parser_exc = exc

        except EOFError as exc:
            self.fail(CloseCode.ABNORMAL_CLOSURE, str(exc))
            self.parser_exc = exc

        except UnicodeDecodeError as exc:
            self.fail(CloseCode.INVALID_DATA, f"{exc.reason} at position {exc.start}")
            self.parser_exc = exc

        except PayloadTooBig as exc:
            exc.set_current_size(self.current_size)
            self.fail(CloseCode.MESSAGE_TOO_BIG, str(exc))
            self.parser_exc = exc

        except Exception as exc:
            self.logger.error("parser failed", exc_info=True)
            # Don't include exception details, which may be security-sensitive.
            self.fail(CloseCode.INTERNAL_ERROR)
            self.parser_exc = exc

        # During an abnormal closure, execution ends here after catching an
        # exception. At this point, fail() replaced parse() by discard().
        yield
        raise AssertionError("parse() shouldn't step after error")

    def discard(self) -> Generator[None]:
        """
        Discard incoming data.

        This coroutine replaces :meth:`parse`:

        - after receiving a close frame, during a normal closure (1.4);
        - after sending a close frame, during an abnormal closure (7.1.7).

        """
        # After the opening handshake completes, the server closes the TCP
        # connection in the same circumstances where discard() replaces parse().
        # The client closes it when it receives EOF from the server or times
        # out. (The latter case cannot be handled in this Sans-I/O layer.)
        assert (self.side is SERVER or self.state is CONNECTING) == (self.eof_sent)
        while not (yield from self.reader.at_eof()):
            self.reader.discard()
        if self.debug:
            self.logger.debug("< EOF")
        # A server closes the TCP connection immediately, while a client
        # waits for the server to close the TCP connection.
        if self.side is CLIENT and self.state is not CONNECTING:
            self.send_eof()
        self.state = CLOSED
        # If discard() completes normally, execution ends here.
        yield
        # Once the reader reaches EOF, its feed_data/eof() methods raise an
        # error, so our receive_data/eof() methods don't step the generator.
        raise AssertionError("discard() shouldn't step after EOF")

    def recv_frame(self, frame: Frame) -> None:
        """
        Process an incoming frame.

        """
        if frame.opcode is OP_TEXT or frame.opcode is OP_BINARY:
            if self.current_size is not None:
                raise ProtocolError("expected a continuation frame")
            if not frame.fin:
                self.current_size = len(frame.data)

        elif frame.opcode is OP_CONT:
            if self.current_size is None:
                raise ProtocolError("unexpected continuation frame")
            if frame.fin:
                self.current_size = None
            else:
                self.current_size += len(frame.data)

        elif frame.opcode is OP_PING:
            # 5.5.2. Ping: "Upon receipt of a Ping frame, an endpoint MUST
            # send a Pong frame in response"
            pong_frame = Frame(OP_PONG, frame.data)
            self.send_frame(pong_frame)

        elif frame.opcode is OP_PONG:
            # 5.5.3 Pong: "A response to an unsolicited Pong frame is not
            # expected."
            pass

        elif frame.opcode is OP_CLOSE:
            # 7.1.5.  The WebSocket Connection Close Code
            # 7.1.6.  The WebSocket Connection Close Reason
            self.close_rcvd = Close.parse(frame.data)
            if self.state is CLOSING:
                assert self.close_sent is not None
                self.close_rcvd_then_sent = False

            if self.current_size is not None:
                raise ProtocolError("incomplete fragmented message")

            # 5.5.1 Close: "If an endpoint receives a Close frame and did
            # not previously send a Close frame, the endpoint MUST send a
            # Close frame in response. (When sending a Close frame in
            # response, the endpoint typically echos the status code it
            # received.)"

            if self.state is OPEN:
                # Echo the original data instead of re-serializing it with
                # Close.serialize() because that fails when the close frame
                # is empty and Close.parse() synthesizes a 1005 close code.
                # The rest is identical to send_close().
                self.send_frame(Frame(OP_CLOSE, frame.data))
                self.close_sent = self.close_rcvd
                self.close_rcvd_then_sent = True
                self.state = CLOSING

            # 7.1.2. Start the WebSocket Closing Handshake: "Once an
            # endpoint has both sent and received a Close control frame,
            # that endpoint SHOULD _Close the WebSocket Connection_"

            # A server closes the TCP connection immediately, while a client
            # waits for the server to close the TCP connection.
            if self.side is SERVER:
                self.send_eof()

            # 1.4. Closing Handshake: "after receiving a control frame
            # indicating the connection should be closed, a peer discards
            # any further data received."
            # RFC 6455 allows reading Ping and Pong frames after a Close frame.
            # However, that doesn't seem useful; websockets doesn't support it.
            self.parser = self.discard()
            next(self.parser)  # start coroutine

        else:
            # This can't happen because Frame.parse() validates opcodes.
            raise AssertionError(f"unexpected opcode: {frame.opcode:02x}")

        self.events.append(frame)

    # Private methods for sending events.

    def send_frame(self, frame: Frame) -> None:
        if self.debug:
            self.logger.debug("> %s", frame)
        self.writes.append(
            frame.serialize(
                mask=self.side is CLIENT,
                extensions=self.extensions,
            )
        )

    def send_eof(self) -> None:
        assert not self.eof_sent
        self.eof_sent = True
        if self.debug:
            self.logger.debug("> EOF")
        self.writes.append(SEND_EOF)
