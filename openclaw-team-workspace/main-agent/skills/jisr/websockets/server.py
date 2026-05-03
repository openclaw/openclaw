from __future__ import annotations

import base64
import binascii
import email.utils
import http
import re
import warnings
from collections.abc import Generator, Sequence
from typing import Any, Callable, cast

from .datastructures import Headers, MultipleValuesError
from .exceptions import (
    InvalidHandshake,
    InvalidHeader,
    InvalidHeaderValue,
    InvalidMessage,
    InvalidOrigin,
    InvalidUpgrade,
    NegotiationError,
)
from .extensions import Extension, ServerExtensionFactory
from .headers import (
    build_extension,
    parse_connection,
    parse_extension,
    parse_subprotocol,
    parse_upgrade,
)
from .http11 import Request, Response
from .imports import lazy_import
from .protocol import CONNECTING, OPEN, SERVER, Protocol, State
from .typing import (
    ConnectionOption,
    ExtensionHeader,
    LoggerLike,
    Origin,
    StatusLike,
    Subprotocol,
    UpgradeProtocol,
)
from .utils import accept_key


__all__ = ["ServerProtocol"]


class ServerProtocol(Protocol):
    """
    Sans-I/O implementation of a WebSocket server connection.

    Args:
        origins: Acceptable values of the ``Origin`` header. Values can be
            :class:`str` to test for an exact match or regular expressions
            compiled by :func:`re.compile` to test against a pattern. Include
            :obj:`None` in the list if the lack of an origin is acceptable.
            This is useful for defending against Cross-Site WebSocket
            Hijacking attacks.
        extensions: List of supported extensions, in order in which they
            should be tried.
        subprotocols: List of supported subprotocols, in order of decreasing
            preference.
        select_subprotocol: Callback for selecting a subprotocol among
            those supported by the client and the server. It has the same
            signature as the :meth:`select_subprotocol` method, including a
            :class:`ServerProtocol` instance as first argument.
        state: Initial state of the WebSocket connection.
        max_size: Maximum size of incoming messages in bytes.
            :obj:`None` disables the limit. You may pass a ``(max_message_size,
            max_fragment_size)`` tuple to set different limits for messages and
            fragments when you expect long messages sent in short fragments.
        logger: Logger for this connection;
            defaults to ``logging.getLogger("websockets.server")``;
            see the :doc:`logging guide <../../topics/logging>` for details.

    """

    def __init__(
        self,
        *,
        origins: Sequence[Origin | re.Pattern[str] | None] | None = None,
        extensions: Sequence[ServerExtensionFactory] | None = None,
        subprotocols: Sequence[Subprotocol] | None = None,
        select_subprotocol: (
            Callable[
                [ServerProtocol, Sequence[Subprotocol]],
                Subprotocol | None,
            ]
            | None
        ) = None,
        state: State = CONNECTING,
        max_size: int | None | tuple[int | None, int | None] = 2**20,
        logger: LoggerLike | None = None,
    ) -> None:
        super().__init__(
            side=SERVER,
            state=state,
            max_size=max_size,
            logger=logger,
        )
        self.origins = origins
        self.available_extensions = extensions
        self.available_subprotocols = subprotocols
        if select_subprotocol is not None:
            # Bind select_subprotocol then shadow self.select_subprotocol.
            # Use setattr to work around https://github.com/python/mypy/issues/2427.
            setattr(
                self,
                "select_subprotocol",
                select_subprotocol.__get__(self, self.__class__),
            )

    def accept(self, request: Request) -> Response:
        """
        Create a handshake response to accept the connection.

        If the handshake request is valid and the handshake successful,
        :meth:`accept` returns an HTTP response with status code 101.

        Else, it returns an HTTP response with another status code. This rejects
        the connection, like :meth:`reject` would.

        You must send the handshake response with :meth:`send_response`.

        You may modify the response before sending it, typically by adding HTTP
        headers.

        Args:
            request: WebSocket handshake request received from the client.

        Returns:
            WebSocket handshake response or HTTP response to send to the client.

        """
        try:
            (
                accept_header,
                extensions_header,
                protocol_header,
            ) = self.process_request(request)
        except InvalidOrigin as exc:
            request._exception = exc
            self.handshake_exc = exc
            if self.debug:
                self.logger.debug("! invalid origin", exc_info=True)
            return self.reject(
                http.HTTPStatus.FORBIDDEN,
                f"Failed to open a WebSocket connection: {exc}.\n",
            )
        except InvalidUpgrade as exc:
            request._exception = exc
            self.handshake_exc = exc
            if self.debug:
                self.logger.debug("! invalid upgrade", exc_info=True)
            response = self.reject(
                http.HTTPStatus.UPGRADE_REQUIRED,
                (
                    f"Failed to open a WebSocket connection: {exc}.\n"
                    f"\n"
                    f"You cannot access a WebSocket server directly "
                    f"with a browser. You need a WebSocket client.\n"
                ),
            )
            response.headers["Upgrade"] = "websocket"
            return response
        except InvalidHandshake as exc:
            request._exception = exc
            self.handshake_exc = exc
            if self.debug:
                self.logger.debug("! invalid handshake", exc_info=True)
            exc_chain = cast(BaseException, exc)
            exc_str = f"{exc_chain}"
            while exc_chain.__cause__ is not None:
                exc_chain = exc_chain.__cause__
                exc_str += f"; {exc_chain}"
            return self.reject(
                http.HTTPStatus.BAD_REQUEST,
                f"Failed to open a WebSocket connection: {exc_str}.\n",
            )
        except Exception as exc:
            # Handle exceptions raised by user-provided select_subprotocol and
            # unexpected errors.
            request._exception = exc
            self.handshake_exc = exc
            self.logger.error("opening handshake failed", exc_info=True)
            return self.reject(
                http.HTTPStatus.INTERNAL_SERVER_ERROR,
                (
                    "Failed to open a WebSocket connection.\n"
                    "See server log for more information.\n"
                ),
            )

        headers = Headers()
        headers["Date"] = email.utils.formatdate(usegmt=True)
        headers["Upgrade"] = "websocket"
        headers["Connection"] = "Upgrade"
        headers["Sec-WebSocket-Accept"] = accept_header
        if extensions_header is not None:
            headers["Sec-WebSocket-Extensions"] = extensions_header
        if protocol_header is not None:
            headers["Sec-WebSocket-Protocol"] = protocol_header
        return Response(101, "Switching Protocols", headers)

    def process_request(
        self,
        request: Request,
    ) -> tuple[str, str | None, str | None]:
        """
        Check a handshake request and negotiate extensions and subprotocol.

        This function doesn't verify that the request is an HTTP/1.1 or higher
        GET request and doesn't check the ``Host`` header. These controls are
        usually performed earlier in the HTTP request handling code. They're
        the responsibility of the caller.

        Args:
            request: WebSocket handshake request received from the client.

        Returns:
            ``Sec-WebSocket-Accept``, ``Sec-WebSocket-Extensions``, and
            ``Sec-WebSocket-Protocol`` headers for the handshake response.

        Raises:
            InvalidHandshake: If the handshake request is invalid;
                then the server must return 400 Bad Request error.

        """
        headers = request.headers

        connection: list[ConnectionOption] = sum(
            [parse_connection(value) for value in headers.get_all("Connection")], []
        )
        if not any(value.lower() == "upgrade" for value in connection):
            raise InvalidUpgrade(
                "Connection", ", ".join(connection) if connection else None
            )

        upgrade: list[UpgradeProtocol] = sum(
            [parse_upgrade(value) for value in headers.get_all("Upgrade")], []
        )
        # For compatibility with non-strict implementations, ignore case when
        # checking the Upgrade header. The RFC always uses "websocket", except
        # in section 11.2. (IANA registration) where it uses "WebSocket".
        if not (len(upgrade) == 1 and upgrade[0].lower() == "websocket"):
            raise InvalidUpgrade("Upgrade", ", ".join(upgrade) if upgrade else None)

        try:
            key = headers["Sec-WebSocket-Key"]
        except KeyError:
            raise InvalidHeader("Sec-WebSocket-Key") from None
        except MultipleValuesError:
            raise InvalidHeader("Sec-WebSocket-Key", "multiple values") from None
        try:
            raw_key = base64.b64decode(key.encode(), validate=True)
        except binascii.Error as exc:
            raise InvalidHeaderValue("Sec-WebSocket-Key", key) from exc
        if len(raw_key) != 16:
            raise InvalidHeaderValue("Sec-WebSocket-Key", key)
        accept_header = accept_key(key)

        try:
            version = headers["Sec-WebSocket-Version"]
        except KeyError:
            raise InvalidHeader("Sec-WebSocket-Version") from None
        except MultipleValuesError:
            raise InvalidHeader("Sec-WebSocket-Version", "multiple values") from None
        if version != "13":
            raise InvalidHeaderValue("Sec-WebSocket-Version", version)

        self.origin = self.process_origin(headers)
        extensions_header, self.extensions = self.process_extensions(headers)
        protocol_header = self.subprotocol = self.process_subprotocol(headers)

        return (accept_header, extensions_header, protocol_header)

    def process_origin(self, headers: Headers) -> Origin | None:
        """
        Handle the Origin HTTP request header.

        Args:
            headers: WebSocket handshake request headers.

        Returns:
           origin, if it is acceptable.

        Raises:
            InvalidHandshake: If the Origin header is invalid.
            InvalidOrigin: If the origin isn't acceptable.

        """
        # "The user agent MUST NOT include more than one Origin header field"
        # per https://datatracker.ietf.org/doc/html/rfc6454#section-7.3.
        try:
            origin = headers.get("Origin")
        except MultipleValuesError:
            raise InvalidHeader("Origin", "multiple values") from None
        if origin is not None:
            origin = cast(Origin, origin)
        if self.origins is not None:
            for origin_or_regex in self.origins:
                if origin_or_regex == origin or (
                    isinstance(origin_or_regex, re.Pattern)
                    and origin is not None
                    and origin_or_regex.fullmatch(origin) is not None
                ):
                    break
            else:
                raise InvalidOrigin(origin)
        return origin

    def process_extensions(
        self,
        headers: Headers,
    ) -> tuple[str | None, list[Extension]]:
        """
        Handle the Sec-WebSocket-Extensions HTTP request header.

        Accept or reject each extension proposed in the client request.
        Negotiate parameters for accepted extensions.

        Per :rfc:`6455`, negotiation rules are defined by the specification of
        each extension.

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
            headers: WebSocket handshake request headers.

        Returns:
            ``Sec-WebSocket-Extensions`` HTTP response header and list of
            accepted extensions.

        Raises:
            InvalidHandshake: If the Sec-WebSocket-Extensions header is invalid.

        """
        response_header_value: str | None = None

        extension_headers: list[ExtensionHeader] = []
        accepted_extensions: list[Extension] = []

        header_values = headers.get_all("Sec-WebSocket-Extensions")

        if header_values and self.available_extensions:
            parsed_header_values: list[ExtensionHeader] = sum(
                [parse_extension(header_value) for header_value in header_values], []
            )

            for name, request_params in parsed_header_values:
                for ext_factory in self.available_extensions:
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

    def process_subprotocol(self, headers: Headers) -> Subprotocol | None:
        """
        Handle the Sec-WebSocket-Protocol HTTP request header.

        Args:
            headers: WebSocket handshake request headers.

        Returns:
           Subprotocol, if one was selected; this is also the value of the
           ``Sec-WebSocket-Protocol`` response header.

        Raises:
            InvalidHandshake: If the Sec-WebSocket-Subprotocol header is invalid.

        """
        subprotocols: Sequence[Subprotocol] = sum(
            [
                parse_subprotocol(header_value)
                for header_value in headers.get_all("Sec-WebSocket-Protocol")
            ],
            [],
        )
        return self.select_subprotocol(subprotocols)

    def select_subprotocol(
        self,
        subprotocols: Sequence[Subprotocol],
    ) -> Subprotocol | None:
        """
        Pick a subprotocol among those offered by the client.

        If several subprotocols are supported by both the client and the server,
        pick the first one in the list declared the server.

        If the server doesn't support any subprotocols, continue without a
        subprotocol, regardless of what the client offers.

        If the server supports at least one subprotocol and the client doesn't
        offer any, abort the handshake with an HTTP 400 error.

        You provide a ``select_subprotocol`` argument to :class:`ServerProtocol`
        to override this logic. For example, you could accept the connection
        even if client doesn't offer a subprotocol, rather than reject it.

        Here's how to negotiate the ``chat`` subprotocol if the client supports
        it and continue without a subprotocol otherwise::

            def select_subprotocol(protocol, subprotocols):
                if "chat" in subprotocols:
                    return "chat"

        Args:
            subprotocols: List of subprotocols offered by the client.

        Returns:
            Selected subprotocol, if a common subprotocol was found.

            :obj:`None` to continue without a subprotocol.

        Raises:
            NegotiationError: Custom implementations may raise this exception
                to abort the handshake with an HTTP 400 error.

        """
        # Server doesn't offer any subprotocols.
        if not self.available_subprotocols:  # None or empty list
            return None

        # Server offers at least one subprotocol but client doesn't offer any.
        if not subprotocols:
            raise NegotiationError("missing subprotocol")

        # Server and client both offer subprotocols. Look for a shared one.
        proposed_subprotocols = set(subprotocols)
        for subprotocol in self.available_subprotocols:
            if subprotocol in proposed_subprotocols:
                return subprotocol

        # No common subprotocol was found.
        raise NegotiationError(
            "invalid subprotocol; expected one of "
            + ", ".join(self.available_subprotocols)
        )

    def reject(self, status: StatusLike, text: str) -> Response:
        """
        Create a handshake response to reject the connection.

        A short plain text response is the best fallback when failing to
        establish a WebSocket connection.

        You must send the handshake response with :meth:`send_response`.

        You may modify the response before sending it, for example by changing
        HTTP headers.

        Args:
            status: HTTP status code.
            text: HTTP response body; it will be encoded to UTF-8.

        Returns:
            HTTP response to send to the client.

        """
        # If status is an int instead of an HTTPStatus, fix it automatically.
        status = http.HTTPStatus(status)
        body = text.encode()
        headers = Headers(
            [
                ("Date", email.utils.formatdate(usegmt=True)),
                ("Connection", "close"),
                ("Content-Length", str(len(body))),
                ("Content-Type", "text/plain; charset=utf-8"),
            ]
        )
        return Response(status.value, status.phrase, headers, body)

    def send_response(self, response: Response) -> None:
        """
        Send a handshake response to the client.

        Args:
            response: WebSocket handshake response event to send.

        """
        if self.debug:
            code, phrase = response.status_code, response.reason_phrase
            self.logger.debug("> HTTP/1.1 %d %s", code, phrase)
            for key, value in response.headers.raw_items():
                self.logger.debug("> %s: %s", key, value)
            if response.body:
                self.logger.debug("> [body] (%d bytes)", len(response.body))

        self.writes.append(response.serialize())

        if response.status_code == 101:
            assert self.state is CONNECTING
            self.state = OPEN
            self.logger.info("connection open")

        else:
            self.logger.info(
                "connection rejected (%d %s)",
                response.status_code,
                response.reason_phrase,
            )

            self.send_eof()
            self.parser = self.discard()
            next(self.parser)  # start coroutine

    def parse(self) -> Generator[None]:
        if self.state is CONNECTING:
            try:
                request = yield from Request.parse(
                    self.reader.read_line,
                )
            except Exception as exc:
                self.handshake_exc = InvalidMessage(
                    "did not receive a valid HTTP request"
                )
                self.handshake_exc.__cause__ = exc
                self.send_eof()
                self.parser = self.discard()
                next(self.parser)  # start coroutine
                yield

            if self.debug:
                self.logger.debug("< GET %s HTTP/1.1", request.path)
                for key, value in request.headers.raw_items():
                    self.logger.debug("< %s: %s", key, value)

            self.events.append(request)

        yield from super().parse()


class ServerConnection(ServerProtocol):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        warnings.warn(  # deprecated in 11.0 - 2023-04-02
            "ServerConnection was renamed to ServerProtocol",
            DeprecationWarning,
        )
        super().__init__(*args, **kwargs)


lazy_import(
    globals(),
    deprecated_aliases={
        # deprecated in 14.0 - 2024-11-09
        "WebSocketServer": ".legacy.server",
        "WebSocketServerProtocol": ".legacy.server",
        "broadcast": ".legacy.server",
        "serve": ".legacy.server",
        "unix_serve": ".legacy.server",
    },
)
