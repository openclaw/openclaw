"""OpenClaw Gateway server module.

This module provides the HTTP API and WebSocket server for OpenClaw.
"""

from .app import create_app
from .auth import authorize_gateway_request, get_client_ip, is_local_request
from .http_common import (
    send_invalid_request,
    send_json,
    send_method_not_allowed,
    send_not_found,
    send_text,
    send_unauthorized,
)
from .server import GatewayServer, start_server, stop_server
from .types import (
    ConfigSnapshotResponse,
    GatewayAuth,
    HealthCheckResponse,
    SessionListResponse,
)
from .ws_connection import WebSocketConnectionManager
from .ws_server import broadcast_to_all, get_connection_manager
from .ws_types import (
    ConnectParams,
    WebSocketClient,
    WebSocketEvent,
    WebSocketFrame,
    WebSocketRequest,
    WebSocketResponse,
)

__all__ = [
    # App
    "create_app",
    # Server
    "GatewayServer",
    "start_server",
    "stop_server",
    # Auth
    "authorize_gateway_request",
    "get_client_ip",
    "is_local_request",
    # HTTP common
    "send_json",
    "send_text",
    "send_unauthorized",
    "send_invalid_request",
    "send_not_found",
    "send_method_not_allowed",
    # HTTP Types
    "GatewayAuth",
    "HealthCheckResponse",
    "SessionListResponse",
    "ConfigSnapshotResponse",
    # WebSocket
    "WebSocketConnectionManager",
    "get_connection_manager",
    "broadcast_to_all",
    # WebSocket Types
    "WebSocketClient",
    "WebSocketFrame",
    "WebSocketRequest",
    "WebSocketResponse",
    "WebSocketEvent",
    "ConnectParams",
]
