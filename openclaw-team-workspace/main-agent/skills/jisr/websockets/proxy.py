from __future__ import annotations

import dataclasses
import urllib.parse
import urllib.request

from .datastructures import Headers
from .exceptions import InvalidProxy
from .headers import build_authorization_basic, build_host
from .http11 import USER_AGENT
from .uri import DELIMS, WebSocketURI


__all__ = ["get_proxy", "parse_proxy", "Proxy"]


@dataclasses.dataclass
class Proxy:
    """
    Proxy address.

    Attributes:
        scheme: ``"socks5h"``, ``"socks5"``, ``"socks4a"``, ``"socks4"``,
            ``"https"``, or ``"http"``.
        host: Normalized to lower case.
        port: Always set even if it's the default.
        username: Available when the proxy address contains `User Information`_.
        password: Available when the proxy address contains `User Information`_.

    .. _User Information: https://datatracker.ietf.org/doc/html/rfc3986#section-3.2.1

    """

    scheme: str
    host: str
    port: int
    username: str | None = None
    password: str | None = None

    @property
    def user_info(self) -> tuple[str, str] | None:
        if self.username is None:
            return None
        assert self.password is not None
        return (self.username, self.password)


def parse_proxy(proxy: str) -> Proxy:
    """
    Parse and validate a proxy.

    Args:
        proxy: proxy.

    Returns:
        Parsed proxy.

    Raises:
        InvalidProxy: If ``proxy`` isn't a valid proxy.

    """
    parsed = urllib.parse.urlparse(proxy)
    if parsed.scheme not in ["socks5h", "socks5", "socks4a", "socks4", "https", "http"]:
        raise InvalidProxy(proxy, f"scheme {parsed.scheme} isn't supported")
    if parsed.hostname is None:
        raise InvalidProxy(proxy, "hostname isn't provided")
    if parsed.path not in ["", "/"]:
        raise InvalidProxy(proxy, "path is meaningless")
    if parsed.query != "":
        raise InvalidProxy(proxy, "query is meaningless")
    if parsed.fragment != "":
        raise InvalidProxy(proxy, "fragment is meaningless")

    scheme = parsed.scheme
    host = parsed.hostname
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    username = parsed.username
    password = parsed.password
    # urllib.parse.urlparse accepts URLs with a username but without a
    # password. This doesn't make sense for HTTP Basic Auth credentials.
    if username is not None and password is None:
        raise InvalidProxy(proxy, "username provided without password")

    try:
        proxy.encode("ascii")
    except UnicodeEncodeError:
        # Input contains non-ASCII characters.
        # It must be an IRI. Convert it to a URI.
        host = host.encode("idna").decode()
        if username is not None:
            assert password is not None
            username = urllib.parse.quote(username, safe=DELIMS)
            password = urllib.parse.quote(password, safe=DELIMS)

    return Proxy(scheme, host, port, username, password)


def get_proxy(uri: WebSocketURI) -> str | None:
    """
    Return the proxy to use for connecting to the given WebSocket URI, if any.

    """
    if urllib.request.proxy_bypass(f"{uri.host}:{uri.port}"):
        return None

    # According to the _Proxy Usage_ section of RFC 6455, use a SOCKS5 proxy if
    # available, else favor the proxy for HTTPS connections over the proxy for
    # HTTP connections.

    # The priority of a proxy for WebSocket connections is unspecified. We give
    # it the highest priority. This makes it easy to configure a specific proxy
    # for websockets.

    # getproxies() may return SOCKS proxies as {"socks": "http://host:port"} or
    # as {"https": "socks5h://host:port"} depending on whether they're declared
    # in the operating system or in environment variables.

    proxies = urllib.request.getproxies()
    if uri.secure:
        schemes = ["wss", "socks", "https"]
    else:
        schemes = ["ws", "socks", "https", "http"]

    for scheme in schemes:
        proxy = proxies.get(scheme)
        if proxy is not None:
            if scheme == "socks" and proxy.startswith("http://"):
                proxy = "socks5h://" + proxy[7:]
            return proxy
    else:
        return None


def prepare_connect_request(
    proxy: Proxy,
    ws_uri: WebSocketURI,
    user_agent_header: str | None = USER_AGENT,
) -> bytes:
    host = build_host(ws_uri.host, ws_uri.port, ws_uri.secure, always_include_port=True)
    headers = Headers()
    headers["Host"] = build_host(ws_uri.host, ws_uri.port, ws_uri.secure)
    if user_agent_header is not None:
        headers["User-Agent"] = user_agent_header
    if proxy.username is not None:
        assert proxy.password is not None  # enforced by parse_proxy()
        headers["Proxy-Authorization"] = build_authorization_basic(
            proxy.username, proxy.password
        )
    # We cannot use the Request class because it supports only GET requests.
    return f"CONNECT {host} HTTP/1.1\r\n".encode() + headers.serialize()
