from __future__ import annotations

import asyncio
import os
import re

from ..datastructures import Headers
from ..exceptions import SecurityError


__all__ = ["read_request", "read_response"]

MAX_NUM_HEADERS = int(os.environ.get("WEBSOCKETS_MAX_NUM_HEADERS", "128"))
MAX_LINE_LENGTH = int(os.environ.get("WEBSOCKETS_MAX_LINE_LENGTH", "8192"))


def d(value: bytes) -> str:
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


async def read_request(stream: asyncio.StreamReader) -> tuple[str, Headers]:
    """
    Read an HTTP/1.1 GET request and return ``(path, headers)``.

    ``path`` isn't URL-decoded or validated in any way.

    ``path`` and ``headers`` are expected to contain only ASCII characters.
    Other characters are represented with surrogate escapes.

    :func:`read_request` doesn't attempt to read the request body because
    WebSocket handshake requests don't have one. If the request contains a
    body, it may be read from ``stream`` after this coroutine returns.

    Args:
        stream: Input to read the request from.

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
        request_line = await read_line(stream)
    except EOFError as exc:
        raise EOFError("connection closed while reading HTTP request line") from exc

    try:
        method, raw_path, version = request_line.split(b" ", 2)
    except ValueError:  # not enough values to unpack (expected 3, got 1-2)
        raise ValueError(f"invalid HTTP request line: {d(request_line)}") from None

    if method != b"GET":
        raise ValueError(f"unsupported HTTP method: {d(method)}")
    if version != b"HTTP/1.1":
        raise ValueError(f"unsupported HTTP version: {d(version)}")
    path = raw_path.decode("ascii", "surrogateescape")

    headers = await read_headers(stream)

    return path, headers


async def read_response(stream: asyncio.StreamReader) -> tuple[int, str, Headers]:
    """
    Read an HTTP/1.1 response and return ``(status_code, reason, headers)``.

    ``reason`` and ``headers`` are expected to contain only ASCII characters.
    Other characters are represented with surrogate escapes.

    :func:`read_request` doesn't attempt to read the response body because
    WebSocket handshake responses don't have one. If the response contains a
    body, it may be read from ``stream`` after this coroutine returns.

    Args:
        stream: Input to read the response from.

    Raises:
        EOFError: If the connection is closed without a full HTTP response.
        SecurityError: If the response exceeds a security limit.
        ValueError: If the response isn't well formatted.

    """
    # https://datatracker.ietf.org/doc/html/rfc7230#section-3.1.2

    # As in read_request, parsing is simple because a fixed value is expected
    # for version, status_code is a 3-digit number, and reason can be ignored.

    try:
        status_line = await read_line(stream)
    except EOFError as exc:
        raise EOFError("connection closed while reading HTTP status line") from exc

    try:
        version, raw_status_code, raw_reason = status_line.split(b" ", 2)
    except ValueError:  # not enough values to unpack (expected 3, got 1-2)
        raise ValueError(f"invalid HTTP status line: {d(status_line)}") from None

    if version != b"HTTP/1.1":
        raise ValueError(f"unsupported HTTP version: {d(version)}")
    try:
        status_code = int(raw_status_code)
    except ValueError:  # invalid literal for int() with base 10
        raise ValueError(f"invalid HTTP status code: {d(raw_status_code)}") from None
    if not 100 <= status_code < 1000:
        raise ValueError(f"unsupported HTTP status code: {d(raw_status_code)}")
    if not _value_re.fullmatch(raw_reason):
        raise ValueError(f"invalid HTTP reason phrase: {d(raw_reason)}")
    reason = raw_reason.decode()

    headers = await read_headers(stream)

    return status_code, reason, headers


async def read_headers(stream: asyncio.StreamReader) -> Headers:
    """
    Read HTTP headers from ``stream``.

    Non-ASCII characters are represented with surrogate escapes.

    """
    # https://datatracker.ietf.org/doc/html/rfc7230#section-3.2

    # We don't attempt to support obsolete line folding.

    headers = Headers()
    for _ in range(MAX_NUM_HEADERS + 1):
        try:
            line = await read_line(stream)
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


async def read_line(stream: asyncio.StreamReader) -> bytes:
    """
    Read a single line from ``stream``.

    CRLF is stripped from the return value.

    """
    # Security: this is bounded by the StreamReader's limit (default = 32 KiB).
    line = await stream.readline()
    # Security: this guarantees header values are small (hard-coded = 8 KiB)
    if len(line) > MAX_LINE_LENGTH:
        raise SecurityError("line too long")
    # Not mandatory but safe - https://datatracker.ietf.org/doc/html/rfc7230#section-3.5
    if not line.endswith(b"\r\n"):
        raise EOFError("line without CRLF")
    return line[:-2]
