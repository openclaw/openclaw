from __future__ import annotations

import functools
import hmac
import http
from collections.abc import Awaitable, Iterable
from typing import Any, Callable, cast

from ..datastructures import Headers
from ..exceptions import InvalidHeader
from ..headers import build_www_authenticate_basic, parse_authorization_basic
from .server import HTTPResponse, WebSocketServerProtocol


__all__ = ["BasicAuthWebSocketServerProtocol", "basic_auth_protocol_factory"]

Credentials = tuple[str, str]


def is_credentials(value: Any) -> bool:
    try:
        username, password = value
    except (TypeError, ValueError):
        return False
    else:
        return isinstance(username, str) and isinstance(password, str)


class BasicAuthWebSocketServerProtocol(WebSocketServerProtocol):
    """
    WebSocket server protocol that enforces HTTP Basic Auth.

    """

    realm: str = ""
    """
    Scope of protection.

    If provided, it should contain only ASCII characters because the
    encoding of non-ASCII characters is undefined.
    """

    username: str | None = None
    """Username of the authenticated user."""

    def __init__(
        self,
        *args: Any,
        realm: str | None = None,
        check_credentials: Callable[[str, str], Awaitable[bool]] | None = None,
        **kwargs: Any,
    ) -> None:
        if realm is not None:
            self.realm = realm  # shadow class attribute
        self._check_credentials = check_credentials
        super().__init__(*args, **kwargs)

    async def check_credentials(self, username: str, password: str) -> bool:
        """
        Check whether credentials are authorized.

        This coroutine may be overridden in a subclass, for example to
        authenticate against a database or an external service.

        Args:
            username: HTTP Basic Auth username.
            password: HTTP Basic Auth password.

        Returns:
            :obj:`True` if the handshake should continue;
            :obj:`False` if it should fail with an HTTP 401 error.

        """
        if self._check_credentials is not None:
            return await self._check_credentials(username, password)

        return False

    async def process_request(
        self,
        path: str,
        request_headers: Headers,
    ) -> HTTPResponse | None:
        """
        Check HTTP Basic Auth and return an HTTP 401 response if needed.

        """
        try:
            authorization = request_headers["Authorization"]
        except KeyError:
            return (
                http.HTTPStatus.UNAUTHORIZED,
                [("WWW-Authenticate", build_www_authenticate_basic(self.realm))],
                b"Missing credentials\n",
            )

        try:
            username, password = parse_authorization_basic(authorization)
        except InvalidHeader:
            return (
                http.HTTPStatus.UNAUTHORIZED,
                [("WWW-Authenticate", build_www_authenticate_basic(self.realm))],
                b"Unsupported credentials\n",
            )

        if not await self.check_credentials(username, password):
            return (
                http.HTTPStatus.UNAUTHORIZED,
                [("WWW-Authenticate", build_www_authenticate_basic(self.realm))],
                b"Invalid credentials\n",
            )

        self.username = username

        return await super().process_request(path, request_headers)


def basic_auth_protocol_factory(
    realm: str | None = None,
    credentials: Credentials | Iterable[Credentials] | None = None,
    check_credentials: Callable[[str, str], Awaitable[bool]] | None = None,
    create_protocol: Callable[..., BasicAuthWebSocketServerProtocol] | None = None,
) -> Callable[..., BasicAuthWebSocketServerProtocol]:
    """
    Protocol factory that enforces HTTP Basic Auth.

    :func:`basic_auth_protocol_factory` is designed to integrate with
    :func:`~websockets.legacy.server.serve` like this::

        serve(
            ...,
            create_protocol=basic_auth_protocol_factory(
                realm="my dev server",
                credentials=("hello", "iloveyou"),
            )
        )

    Args:
        realm: Scope of protection. It should contain only ASCII characters
            because the encoding of non-ASCII characters is undefined.
            Refer to section 2.2 of :rfc:`7235` for details.
        credentials: Hard coded authorized credentials. It can be a
            ``(username, password)`` pair or a list of such pairs.
        check_credentials: Coroutine that verifies credentials.
            It receives ``username`` and ``password`` arguments
            and returns a :class:`bool`. One of ``credentials`` or
            ``check_credentials`` must be provided but not both.
        create_protocol: Factory that creates the protocol. By default, this
            is :class:`BasicAuthWebSocketServerProtocol`. It can be replaced
            by a subclass.
    Raises:
        TypeError: If the ``credentials`` or ``check_credentials`` argument is
            wrong.

    """
    if (credentials is None) == (check_credentials is None):
        raise TypeError("provide either credentials or check_credentials")

    if credentials is not None:
        if is_credentials(credentials):
            credentials_list = [cast(Credentials, credentials)]
        elif isinstance(credentials, Iterable):
            credentials_list = list(cast(Iterable[Credentials], credentials))
            if not all(is_credentials(item) for item in credentials_list):
                raise TypeError(f"invalid credentials argument: {credentials}")
        else:
            raise TypeError(f"invalid credentials argument: {credentials}")

        credentials_dict = dict(credentials_list)

        async def check_credentials(username: str, password: str) -> bool:
            try:
                expected_password = credentials_dict[username]
            except KeyError:
                return False
            return hmac.compare_digest(expected_password, password)

    if create_protocol is None:
        create_protocol = BasicAuthWebSocketServerProtocol

    # Help mypy and avoid this error: "type[BasicAuthWebSocketServerProtocol] |
    # Callable[..., BasicAuthWebSocketServerProtocol]" not callable  [misc]
    create_protocol = cast(
        Callable[..., BasicAuthWebSocketServerProtocol], create_protocol
    )
    return functools.partial(
        create_protocol,
        realm=realm,
        check_credentials=check_credentials,
    )
