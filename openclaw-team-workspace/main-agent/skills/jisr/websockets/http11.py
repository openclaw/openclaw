from __future__ import annotations

import dataclasses
import os
import re
import sys
import warnings
from collections.abc import Generator
from typing import Callable

from .datastructures import Headers
from .exceptions import SecurityError
from .version import version as websockets_version


__all__ = [
    "SERVER",
    "USER_AGENT",
    "Request",
    "Response",
]


PYTHON_VERSION = "{}.{}".format(*sys.version_info)

# User-Agent header for HTTP requests.
USER_AGENT = os.environ.get(
    "WEBSOCKETS_USER_AGENT",
    f"Python/{PYTHON_VERSION} websockets/{websockets_version}",
)

# Server header for HTTP responses.
SERVER = os.environ.get(
    "WEBSOCKETS_SERVER",
    f"Python/{PYTHON_VERSION} websockets/{websockets_version}",
)

# Maximum total size of headers is around 128 * 8 KiB = 1 MiB.
MAX_NUM_HEADERS = int(os.environ.get("WEBSOCKETS_MAX_NUM_HEADERS", "128"))

# Limit request line and header lines. 8KiB is the most common default
# configuration of popular HTTP servers.
MAX_LINE_LENGTH = int(os.environ.get("WEBSOCKETS_MAX_LINE_LENGTH", "8192"))

# Support for HTTP response bodies is intended to read an error message
# returned by a server. It isn't designed to perform large file transfers.
MAX_BODY_SIZE = int(os.environ.get("WEBSOCKETS_MAX_BODY_SIZE", "1_048_576"))  # 1 MiB


def d(value: bytes | bytearray) -> str:
    """
    Decode a bytestring for interpolating into an error message.

    """
    return value.decode(errors="backslashreplace")


# See https://datatracker.ietf.org/doc/html/rfc7230#appendix-B.

# Regex for validating header names.

_token_re = re.compile(rb"[-!#$%&\'*+.^_`|~0-9a-zA-Z]+")

# Regex for validating header values.

# We don't attempt to support obsolete line folding.

# Include HTAB (\x09), SP (\x20), VCHAR (\x21-\x7e), obs-text (\x80-\xff).

# The ABNF is complicated because it attempts to express that optional
# whitespace is ignored. We strip whitespace and don't revalidate that.

# See also https://www.rfc-editor.org/errata_search.php?rfc=7230&eid=4189

_value_re = re.compile(rb"[\x09\x20-\x7e\x80-\xff]*")


@dataclasses.dataclass
class Request:
    """
    WebSocket handshake request.

    Attributes:
        path: Request path, including optional query.
        headers: Request headers.
    """

    path: str
    headers: Headers
    # body isn't useful is the context of this library.

    _exception: Exception | None = None

    @property
    def exception(self) -> Exception | None:  # pragma: no cover
        warnings.warn(  # deprecated in 10.3 - 2022-04-17
            "Request.exception is deprecated; use ServerProtocol.handshake_exc instead",
            DeprecationWarning,
        )
        return self._exception

    @classmethod
    def parse(
        cls,
        read_line: Callable[[int], Generator[None, None, bytes | bytearray]],
    ) -> Generator[None, None, Request]:
        """
        Parse a WebSocket handshake request.

        This is a generator-based coroutine.

        The request path isn't URL-decoded or validated in any way.

        The request path and headers are expected to contain only ASCII
        characters. Other characters are represented with surrogate escapes.

        :meth:`parse` doesn't attempt to read the request body because
        WebSocket handshake requests don't have one. If the request contains a
        body, it may be read from the data stream after :meth:`parse` returns.

        Args:
            read_line: Generator-based coroutine that reads a LF-terminated
                line or raises an exception if there isn't enough data

        Raises:
            EOFError: If the connection is closed without a full HTTP request.
            SecurityError: If the request exceeds a security limit.
            ValueError: If the request isn't well formatted.

        """
        # https://datatracker.ietf.org/doc/html/rfc7230#section-3.1.1

        # Parsing is simple because fixed values are expected for method and
        # version and because path isn't checked. Since WebSocket software tends
        # to implement HTTP/1.1 strictly, there's little need for lenient parsing.

        try:
            request_line = yield from parse_line(read_line)
        except EOFError as exc:
            raise EOFError("connection closed while reading HTTP request line") from exc

        try:
            method, raw_path, protocol = request_line.split(b" ", 2)
        except ValueError:  # not enough values to unpack (expected 3, got 1-2)
            raise ValueError(f"invalid HTTP request line: {d(request_line)}") from None
        if protocol != b"HTTP/1.1":
            raise ValueError(
                f"unsupported protocol; expected HTTP/1.1: {d(request_line)}"
            )
        if method != b"GET":
            raise ValueError(f"unsupported HTTP method; expected GET; got {d(method)}")
        path = raw_path.decode("ascii", "surrogateescape")

        headers = yield from parse_headers(read_line)

        # https://datatracker.ietf.org/doc/html/rfc7230#section-3.3.3

        if "Transfer-Encoding" in headers:
            raise NotImplementedError("transfer codings aren't supported")

        if "Content-Length" in headers:
            # Some devices send a Content-Length header with a value of 0.
            # This raises ValueError if Content-Length isn't an integer too.
            if int(headers["Content-Length"]) != 0:
                raise ValueError("unsupported request body")

        return cls(path, headers)

    def serialize(self) -> bytes:
        """
        Serialize a WebSocket handshake request.

        """
        # Since the request line and headers only contain ASCII characters,
        # we can keep this simple.
        request = f"GET {self.path} HTTP/1.1\r\n".encode()
        request += self.headers.serialize()
        return request


@dataclasses.dataclass
class Response:
    """
    WebSocket handshake response.

    Attributes:
        status_code: Response code.
        reason_phrase: Response reason.
        headers: Response headers.
        body: Response body.

    """

    status_code: int
    reason_phrase: str
    headers: Headers
    body: bytes | bytearray = b""

    _exception: Exception | None = None

    @property
    def exception(self) -> Exception | None:  # pragma: no cover
        warnings.warn(  # deprecated in 10.3 - 2022-04-17
            "Response.exception is deprecated; "
            "use ClientProtocol.handshake_exc instead",
            DeprecationWarning,
        )
        return self._exception

    @classmethod
    def parse(
        cls,
        read_line: Callable[[int], Generator[None, None, bytes | bytearray]],
        read_exact: Callable[[int], Generator[None, None, bytes | bytearray]],
        read_to_eof: Callable[[int], Generator[None, None, bytes | bytearray]],
        proxy: bool = False,
    ) -> Generator[None, None, Response]:
        """
        Parse a WebSocket handshake response.

        This is a generator-based coroutine.

        The reason phrase and headers are expected to contain only ASCII
        characters. Other characters are represented with surrogate escapes.

        Args:
            read_line: Generator-based coroutine that reads a LF-terminated
                line or raises an exception if there isn't enough data.
            read_exact: Generator-based coroutine that reads the requested
                bytes or raises an exception if there isn't enough data.
            read_to_eof: Generator-based coroutine that reads until the end
                of the stream.

        Raises:
            EOFError: If the connection is closed without a full HTTP response.
            SecurityError: If the response exceeds a security limit.
            LookupError: If the response isn't well formatted.
            ValueError: If the response isn't well formatted.

        """
        # https://datatracker.ietf.org/doc/html/rfc7230#section-3.1.2

        try:
            status_line = yield from parse_line(read_line)
        except EOFError as exc:
            raise EOFError("connection closed while reading HTTP status line") from exc

        try:
            protocol, raw_status_code, raw_reason = status_line.split(b" ", 2)
        except ValueError:  # not enough values to unpack (expected 3, got 1-2)
            raise ValueError(f"invalid HTTP status line: {d(status_line)}") from None
        if proxy:  # some proxies still use HTTP/1.0
            if protocol not in [b"HTTP/1.1", b"HTTP/1.0"]:
                raise ValueError(
                    f"unsupported protocol; expected HTTP/1.1 or HTTP/1.0: "
                    f"{d(status_line)}"
                )
        else:
            if protocol != b"HTTP/1.1":
                raise ValueError(
                    f"unsupported protocol; expected HTTP/1.1: {d(status_line)}"
                )
        try:
            status_code = int(raw_status_code)
        except ValueError:  # invalid literal for int() with base 10
            raise ValueError(
                f"invalid status code; expected integer; got {d(raw_status_code)}"
            ) from None
        if not 100 <= status_code < 600:
            raise ValueError(
                f"invalid status code; expected 100–599; got {d(raw_status_code)}"
            )
        if not _value_re.fullmatch(raw_reason):
            raise ValueError(f"invalid HTTP reason phrase: {d(raw_reason)}")
        reason = raw_reason.decode("ascii", "surrogateescape")

        headers = yield from parse_headers(read_line)

        body: bytes | bytearray
        if proxy:
            body = b""
        else:
            body = yield from read_body(
                status_code, headers, read_line, read_exact, read_to_eof
            )

        return cls(status_code, reason, headers, body)

    def serialize(self) -> bytes:
        """
        Serialize a WebSocket handshake response.

        """
        # Since the status line and headers only contain ASCII characters,
        # we can keep this simple.
        response = f"HTTP/1.1 {self.status_code} {self.reason_phrase}\r\n".encode()
        response += self.headers.serialize()
        response += self.body
        return response


def parse_line(
    read_line: Callable[[int], Generator[None, None, bytes | bytearray]],
) -> Generator[None, None, bytes | bytearray]:
    """
    Parse a single line.

    CRLF is stripped from the return value.

    Args:
        read_line: Generator-based coroutine that reads a LF-terminated line
            or raises an exception if there isn't enough data.

    Raises:
        EOFError: If the connection is closed without a CRLF.
        SecurityError: If the response exceeds a security limit.

    """
    try:
        line = yield from read_line(MAX_LINE_LENGTH)
    except RuntimeError:
        raise SecurityError("line too long")
    # Not mandatory but safe - https://datatracker.ietf.org/doc/html/rfc7230#section-3.5
    if not line.endswith(b"\r\n"):
        raise EOFError("line without CRLF")
    return line[:-2]


def parse_headers(
    read_line: Callable[[int], Generator[None, None, bytes | bytearray]],
) -> Generator[None, None, Headers]:
    """
    Parse HTTP headers.

    Non-ASCII characters are represented with surrogate escapes.

    Args:
        read_line: Generator-based coroutine that reads a LF-terminated line
            or raises an exception if there isn't enough data.

    Raises:
        EOFError: If the connection is closed without complete headers.
        SecurityError: If the request exceeds a security limit.
        ValueError: If the request isn't well formatted.

    """
    # https://datatracker.ietf.org/doc/html/rfc7230#section-3.2

    # We don't attempt to support obsolete line folding.

    headers = Headers()
    for _ in range(MAX_NUM_HEADERS + 1):
        try:
            line = yield from parse_line(read_line)
        except EOFError as exc:
            raise EOFError("connection closed while reading HTTP headers") from exc
        if line == b"":
            break

        try:
            raw_name, raw_value = line.split(b":", 1)
        except ValueError:  # not enough values to unpack (expected 2, got 1)
            raise ValueError(f"invalid HTTP header line: {d(line)}") from None
        if not _token_re.fullmatch(raw_name):
            raise ValueError(f"invalid HTTP header name: {d(raw_name)}")
        raw_value = raw_value.strip(b" \t")
        if not _value_re.fullmatch(raw_value):
            raise ValueError(f"invalid HTTP header value: {d(raw_value)}")

        name = raw_name.decode("ascii")  # guaranteed to be ASCII at this point
        value = raw_value.decode("ascii", "surrogateescape")
        headers[name] = value

    else:
        raise SecurityError("too many HTTP headers")

    return headers


def read_body(
    status_code: int,
    headers: Headers,
    read_line: Callable[[int], Generator[None, None, bytes | bytearray]],
    read_exact: Callable[[int], Generator[None, None, bytes | bytearray]],
    read_to_eof: Callable[[int], Generator[None, None, bytes | bytearray]],
) -> Generator[None, None, bytes | bytearray]:
    # https://datatracker.ietf.org/doc/html/rfc7230#section-3.3.3

    # Since websockets only does GET requests (no HEAD, no CONNECT), all
    # responses except 1xx, 204, and 304 include a message body.
    if 100 <= status_code < 200 or status_code == 204 or status_code == 304:
        return b""

    # MultipleValuesError is sufficiently unlikely that we don't attempt to
    # handle it when accessing headers. Instead we document that its parent
    # class, LookupError, may be raised.
    # Conversions from str to int are protected by sys.set_int_max_str_digits..

    elif (coding := headers.get("Transfer-Encoding")) is not None:
        if coding != "chunked":
            raise NotImplementedError(f"transfer coding {coding} isn't supported")

        body = b""
        while True:
            chunk_size_line = yield from parse_line(read_line)
            raw_chunk_size = chunk_size_line.split(b";", 1)[0]
            # Set a lower limit than default_max_str_digits; 1 EB is plenty.
            if len(raw_chunk_size) > 15:
                str_chunk_size = raw_chunk_size.decode(errors="backslashreplace")
                raise SecurityError(f"chunk too large: 0x{str_chunk_size} bytes")
            chunk_size = int(raw_chunk_size, 16)
            if chunk_size == 0:
                break
            if len(body) + chunk_size > MAX_BODY_SIZE:
                raise SecurityError(
                    f"chunk too large: {chunk_size} bytes after {len(body)} bytes"
                )
            body += yield from read_exact(chunk_size)
            if (yield from read_exact(2)) != b"\r\n":
                raise ValueError("chunk without CRLF")
        # Read the trailer.
        yield from parse_headers(read_line)
        return body

    elif (raw_content_length := headers.get("Content-Length")) is not None:
        # Set a lower limit than default_max_str_digits; 1 EiB is plenty.
        if len(raw_content_length) > 18:
            raise SecurityError(f"body too large: {raw_content_length} bytes")
        content_length = int(raw_content_length)
        if content_length > MAX_BODY_SIZE:
            raise SecurityError(f"body too large: {content_length} bytes")
        return (yield from read_exact(content_length))

    else:
        try:
            return (yield from read_to_eof(MAX_BODY_SIZE))
        except RuntimeError:
            raise SecurityError(f"body too large: over {MAX_BODY_SIZE} bytes")
