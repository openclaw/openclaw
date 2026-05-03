from __future__ import annotations

import http
import ssl as ssl_module
import urllib.parse
from typing import Any, Callable, Literal

from ..http11 import Request, Response
from .server import Server, ServerConnection, serve


__all__ = ["route", "unix_route", "Router"]


try:
    from werkzeug.exceptions import NotFound
    from werkzeug.routing import Map, RequestRedirect

except ImportError:

    def route(
        url_map: Map,
        *args: Any,
        server_name: str | None = None,
        ssl: ssl_module.SSLContext | Literal[True] | None = None,
        create_router: type[Router] | None = None,
        **kwargs: Any,
    ) -> Server:
        raise ImportError("route() requires werkzeug")

    def unix_route(
        url_map: Map,
        path: str | None = None,
        **kwargs: Any,
    ) -> Server:
        raise ImportError("unix_route() requires werkzeug")

else:

    def route(
        url_map: Map,
        *args: Any,
        server_name: str | None = None,
        ssl: ssl_module.SSLContext | Literal[True] | None = None,
        create_router: type[Router] | None = None,
        **kwargs: Any,
    ) -> Server:
        """
        Create a WebSocket server dispatching connections to different handlers.

        This feature requires the third-party library `werkzeug`_:

        .. code-block:: console

            $ pip install werkzeug

        .. _werkzeug: https://werkzeug.palletsprojects.com/

        :func:`route` accepts the same arguments as
        :func:`~websockets.sync.server.serve`, except as described below.

        The first argument is a :class:`werkzeug.routing.Map` that maps URL patterns
        to connection handlers. In addition to the connection, handlers receive
        parameters captured in the URL as keyword arguments.

        Here's an example::


            from websockets.sync.router import route
            from werkzeug.routing import Map, Rule

            def channel_handler(websocket, channel_id):
                ...

            url_map = Map([
                Rule("/channel/<uuid:channel_id>", endpoint=channel_handler),
                ...
            ])

            with route(url_map, ...) as server:
                server.serve_forever()

        Refer to the documentation of :mod:`werkzeug.routing` for details.

        If you define redirects with ``Rule(..., redirect_to=...)`` in the URL map,
        when the server runs behind a reverse proxy that modifies the ``Host``
        header or terminates TLS, you need additional configuration:

        * Set ``server_name`` to the name of the server as seen by clients. When
          not provided, websockets uses the value of the ``Host`` header.

        * Set ``ssl=True`` to generate ``wss://`` URIs without enabling TLS.
          Under the hood, this bind the URL map with a ``url_scheme`` of
          ``wss://`` instead of ``ws://``.

        There is no need to specify ``websocket=True`` in each rule. It is added
        automatically.

        Args:
            url_map: Mapping of URL patterns to connection handlers.
            server_name: Name of the server as seen by clients. If :obj:`None`,
                websockets uses the value of the ``Host`` header.
            ssl: Configuration for enabling TLS on the connection. Set it to
                :obj:`True` if a reverse proxy terminates TLS connections.
            create_router: Factory for the :class:`Router` dispatching requests to
                handlers. Set it to a wrapper or a subclass to customize routing.

        """
        url_scheme = "ws" if ssl is None else "wss"
        if ssl is not True and ssl is not None:
            kwargs["ssl"] = ssl

        if create_router is None:
            create_router = Router

        router = create_router(url_map, server_name, url_scheme)

        _process_request: (
            Callable[
                [ServerConnection, Request],
                Response | None,
            ]
            | None
        ) = kwargs.pop("process_request", None)
        if _process_request is None:
            process_request: Callable[
                [ServerConnection, Request],
                Response | None,
            ] = router.route_request
        else:

            def process_request(
                connection: ServerConnection, request: Request
            ) -> Response | None:
                response = _process_request(connection, request)
                if response is not None:
                    return response
                return router.route_request(connection, request)

        return serve(router.handler, *args, process_request=process_request, **kwargs)

    def unix_route(
        url_map: Map,
        path: str | None = None,
        **kwargs: Any,
    ) -> Server:
        """
        Create a WebSocket Unix server dispatching connections to different handlers.

        :func:`unix_route` combines the behaviors of :func:`route` and
        :func:`~websockets.sync.server.unix_serve`.

        Args:
            url_map: Mapping of URL patterns to connection handlers.
            path: File system path to the Unix socket.

        """
        return route(url_map, unix=True, path=path, **kwargs)


class Router:
    """WebSocket router supporting :func:`route`."""

    def __init__(
        self,
        url_map: Map,
        server_name: str | None = None,
        url_scheme: str = "ws",
    ) -> None:
        self.url_map = url_map
        self.server_name = server_name
        self.url_scheme = url_scheme
        for rule in self.url_map.iter_rules():
            rule.websocket = True

    def get_server_name(self, connection: ServerConnection, request: Request) -> str:
        if self.server_name is None:
            return request.headers["Host"]
        else:
            return self.server_name

    def redirect(self, connection: ServerConnection, url: str) -> Response:
        response = connection.respond(http.HTTPStatus.FOUND, f"Found at {url}")
        response.headers["Location"] = url
        return response

    def not_found(self, connection: ServerConnection) -> Response:
        return connection.respond(http.HTTPStatus.NOT_FOUND, "Not Found")

    def route_request(
        self, connection: ServerConnection, request: Request
    ) -> Response | None:
        """Route incoming request."""
        url_map_adapter = self.url_map.bind(
            server_name=self.get_server_name(connection, request),
            url_scheme=self.url_scheme,
        )
        try:
            parsed = urllib.parse.urlparse(request.path)
            handler, kwargs = url_map_adapter.match(
                path_info=parsed.path,
                query_args=parsed.query,
            )
        except RequestRedirect as redirect:
            return self.redirect(connection, redirect.new_url)
        except NotFound:
            return self.not_found(connection)
        connection.handler, connection.handler_kwargs = handler, kwargs
        return None

    def handler(self, connection: ServerConnection) -> None:
        """Handle a connection."""
        return connection.handler(connection, **connection.handler_kwargs)
