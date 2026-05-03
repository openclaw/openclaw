from __future__ import annotations

import base64
import binascii

from ..datastructures import Headers, MultipleValuesError
from ..exceptions import InvalidHeader, InvalidHeaderValue, InvalidUpgrade
from ..headers import parse_connection, parse_upgrade
from ..typing import ConnectionOption, UpgradeProtocol
from ..utils import accept_key as accept, generate_key


__all__ = ["build_request", "check_request", "build_response", "check_response"]


def build_request(headers: Headers) -> str:
    """
    Build a handshake request to send to the server.

    Update request headers passed in argument.

    Args:
        headers: Handshake request headers.

    Returns:
        ``key`` that must be passed to :func:`check_response`.

    """
    key = generate_key()
    headers["Upgrade"] = "websocket"
    headers["Connection"] = "Upgrade"
    headers["Sec-WebSocket-Key"] = key
    headers["Sec-WebSocket-Version"] = "13"
    return key


def check_request(headers: Headers) -> str:
    """
    Check a handshake request received from the client.

    This function doesn't verify that the request is an HTTP/1.1 or higher GET
    request and doesn't perform ``Host`` and ``Origin`` checks. These controls
    are usually performed earlier in the HTTP request handling code. They're
    the responsibility of the caller.

    Args:
        headers: Handshake request headers.

    Returns:
        ``key`` that must be passed to :func:`build_response`.

    Raises:
        InvalidHandshake: If the handshake request is invalid.
            Then, the server must return a 400 Bad Request error.

    """
    connection: list[ConnectionOption] = sum(
        [parse_connection(value) for value in headers.get_all("Connection")], []
    )

    if not any(value.lower() == "upgrade" for value in connection):
        raise InvalidUpgrade("Connection", ", ".join(connection))

    upgrade: list[UpgradeProtocol] = sum(
        [parse_upgrade(value) for value in headers.get_all("Upgrade")], []
    )

    # For compatibility with non-strict implementations, ignore case when
    # checking the Upgrade header. The RFC always uses "websocket", except
    # in section 11.2. (IANA registration) where it uses "WebSocket".
    if not (len(upgrade) == 1 and upgrade[0].lower() == "websocket"):
        raise InvalidUpgrade("Upgrade", ", ".join(upgrade))

    try:
        s_w_key = headers["Sec-WebSocket-Key"]
    except KeyError as exc:
        raise InvalidHeader("Sec-WebSocket-Key") from exc
    except MultipleValuesError as exc:
        raise InvalidHeader("Sec-WebSocket-Key", "multiple values") from exc

    try:
        raw_key = base64.b64decode(s_w_key.encode(), validate=True)
    except binascii.Error as exc:
        raise InvalidHeaderValue("Sec-WebSocket-Key", s_w_key) from exc
    if len(raw_key) != 16:
        raise InvalidHeaderValue("Sec-WebSocket-Key", s_w_key)

    try:
        s_w_version = headers["Sec-WebSocket-Version"]
    except KeyError as exc:
        raise InvalidHeader("Sec-WebSocket-Version") from exc
    except MultipleValuesError as exc:
        raise InvalidHeader("Sec-WebSocket-Version", "multiple values") from exc

    if s_w_version != "13":
        raise InvalidHeaderValue("Sec-WebSocket-Version", s_w_version)

    return s_w_key


def build_response(headers: Headers, key: str) -> None:
    """
    Build a handshake response to send to the client.

    Update response headers passed in argument.

    Args:
        headers: Handshake response headers.
        key: Returned by :func:`check_request`.

    """
    headers["Upgrade"] = "websocket"
    headers["Connection"] = "Upgrade"
    headers["Sec-WebSocket-Accept"] = accept(key)


def check_response(headers: Headers, key: str) -> None:
    """
    Check a handshake response received from the server.

    This function doesn't verify that the response is an HTTP/1.1 or higher
    response with a 101 status code. These controls are the responsibility of
    the caller.

    Args:
        headers: Handshake response headers.
        key: Returned by :func:`build_request`.

    Raises:
        InvalidHandshake: If the handshake response is invalid.

    """
    connection: list[ConnectionOption] = sum(
        [parse_connection(value) for value in headers.get_all("Connection")], []
    )

    if not any(value.lower() == "upgrade" for value in connection):
        raise InvalidUpgrade("Connection", " ".join(connection))

    upgrade: list[UpgradeProtocol] = sum(
        [parse_upgrade(value) for value in headers.get_all("Upgrade")], []
    )

    # For compatibility with non-strict implementations, ignore case when
    # checking the Upgrade header. The RFC always uses "websocket", except
    # in section 11.2. (IANA registration) where it uses "WebSocket".
    if not (len(upgrade) == 1 and upgrade[0].lower() == "websocket"):
        raise InvalidUpgrade("Upgrade", ", ".join(upgrade))

    try:
        s_w_accept = headers["Sec-WebSocket-Accept"]
    except KeyError as exc:
        raise InvalidHeader("Sec-WebSocket-Accept") from exc
    except MultipleValuesError as exc:
        raise InvalidHeader("Sec-WebSocket-Accept", "multiple values") from exc

    if s_w_accept != accept(key):
        raise InvalidHeaderValue("Sec-WebSocket-Accept", s_w_accept)
