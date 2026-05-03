from __future__ import annotations

import dataclasses
import urllib.parse

from .exceptions import InvalidURI


__all__ = ["parse_uri", "WebSocketURI"]


# All characters from the gen-delims and sub-delims sets in RFC 3987.
DELIMS = ":/?#[]@!$&'()*+,;="


@dataclasses.dataclass
class WebSocketURI:
    """
    WebSocket URI.

    Attributes:
        secure: :obj:`True` for a ``wss`` URI, :obj:`False` for a ``ws`` URI.
        host: Normalized to lower case.
        port: Always set even if it's the default.
        path: May be empty.
        query: May be empty if the URI doesn't include a query component.
        username: Available when the URI contains `User Information`_.
        password: Available when the URI contains `User Information`_.

    .. _User Information: https://datatracker.ietf.org/doc/html/rfc3986#section-3.2.1

    """

    secure: bool
    host: str
    port: int
    path: str
    query: str
    username: str | None = None
    password: str | None = None

    @property
    def resource_name(self) -> str:
        if self.path:
            resource_name = self.path
        else:
            resource_name = "/"
        if self.query:
            resource_name += "?" + self.query
        return resource_name

    @property
    def user_info(self) -> tuple[str, str] | None:
        if self.username is None:
            return None
        assert self.password is not None
        return (self.username, self.password)


def parse_uri(uri: str) -> WebSocketURI:
    """
    Parse and validate a WebSocket URI.

    Args:
        uri: WebSocket URI.

    Returns:
        Parsed WebSocket URI.

    Raises:
        InvalidURI: If ``uri`` isn't a valid WebSocket URI.

    """
    parsed = urllib.parse.urlparse(uri)
    if parsed.scheme not in ["ws", "wss"]:
        raise InvalidURI(uri, "scheme isn't ws or wss")
    if parsed.hostname is None:
        raise InvalidURI(uri, "hostname isn't provided")
    if parsed.fragment != "":
        raise InvalidURI(uri, "fragment identifier is meaningless")

    secure = parsed.scheme == "wss"
    host = parsed.hostname
    port = parsed.port or (443 if secure else 80)
    path = parsed.path
    query = parsed.query
    username = parsed.username
    password = parsed.password
    # urllib.parse.urlparse accepts URLs with a username but without a
    # password. This doesn't make sense for HTTP Basic Auth credentials.
    if username is not None and password is None:
        raise InvalidURI(uri, "username provided without password")

    try:
        uri.encode("ascii")
    except UnicodeEncodeError:
        # Input contains non-ASCII characters.
        # It must be an IRI. Convert it to a URI.
        host = host.encode("idna").decode()
        path = urllib.parse.quote(path, safe=DELIMS)
        query = urllib.parse.quote(query, safe=DELIMS)
        if username is not None:
            assert password is not None
            username = urllib.parse.quote(username, safe=DELIMS)
            password = urllib.parse.quote(password, safe=DELIMS)

    return WebSocketURI(secure, host, port, path, query, username, password)
