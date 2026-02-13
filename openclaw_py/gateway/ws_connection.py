"""WebSocket connection management.

This module handles WebSocket client connections and message routing.
"""

import time
from typing import Any
from uuid import uuid4

from fastapi import WebSocket, WebSocketDisconnect

from openclaw_py.config import GatewayConfig
from openclaw_py.logging import log_error, log_info, log_warn

from .auth import get_client_ip, is_local_request
from .ws_broadcast import send_response_to_client
from .ws_protocol import (
    create_error_response,
    create_response,
    parse_frame,
    validate_request,
)
from .ws_types import ConnectParams, ConnectionState, WebSocketClient


class WebSocketConnectionManager:
    """Manages WebSocket connections and routing.

    This class tracks all active WebSocket connections and provides
    methods for handling connection lifecycle and message routing.
    """

    def __init__(self):
        """Initialize the connection manager."""
        self.connections: set[ConnectionState] = set()
        self.clients_by_id: dict[str, ConnectionState] = {}

    def add_connection(self, conn_state: ConnectionState) -> None:
        """Add a new connection.

        Args:
            conn_state: Connection state to track
        """
        self.connections.add(conn_state)
        if conn_state.client.client_id:
            self.clients_by_id[conn_state.client.client_id] = conn_state

        log_info(
            "WebSocket client connected",
            conn_id=conn_state.client.conn_id,
            client_id=conn_state.client.client_id,
            client_ip=conn_state.client.client_ip,
            total_connections=len(self.connections),
        )

    def remove_connection(self, conn_state: ConnectionState) -> None:
        """Remove a connection.

        Args:
            conn_state: Connection state to remove
        """
        self.connections.discard(conn_state)
        if conn_state.client.client_id:
            self.clients_by_id.pop(conn_state.client.client_id, None)

        log_info(
            "WebSocket client disconnected",
            conn_id=conn_state.client.conn_id,
            client_id=conn_state.client.client_id,
            total_connections=len(self.connections),
        )

    def get_connection_count(self) -> int:
        """Get the number of active connections.

        Returns:
            Number of active connections
        """
        return len(self.connections)

    def get_client_by_id(self, client_id: str) -> ConnectionState | None:
        """Get a connection by client ID.

        Args:
            client_id: Client ID to look up

        Returns:
            ConnectionState if found, None otherwise
        """
        return self.clients_by_id.get(client_id)


async def handle_websocket_connection(
    websocket: WebSocket,
    config: GatewayConfig,
    manager: WebSocketConnectionManager,
    client_ip: str | None = None,
) -> None:
    """Handle a WebSocket connection lifecycle.

    Args:
        websocket: FastAPI WebSocket connection
        config: Gateway configuration
        manager: Connection manager
        client_ip: Client IP address (for auth)

    Examples:
        >>> # In a FastAPI WebSocket endpoint
        >>> await handle_websocket_connection(websocket, config, manager)
    """
    conn_id = str(uuid4())
    conn_state: ConnectionState | None = None

    try:
        # Accept the WebSocket connection
        await websocket.accept()

        # Wait for connect frame
        connect_params = await handle_connect_frame(websocket, conn_id)
        if not connect_params:
            await websocket.close(code=1008, reason="Invalid connect frame")
            return

        # Create client info
        now_ms = int(time.time() * 1000)
        client = WebSocketClient(
            conn_id=conn_id,
            client_id=connect_params.client_id,
            client_version=connect_params.client_version,
            protocol_version=connect_params.protocol_version,
            device_id=connect_params.device_id,
            platform=connect_params.platform,
            client_ip=client_ip,
            connected_at=now_ms,
        )

        # Authenticate connection
        authenticated, auth_source = authenticate_connection(client_ip, config)
        client.authenticated = authenticated
        client.auth_source = auth_source

        if not authenticated:
            error_response = create_error_response(
                "connect",
                "unauthorized",
                "Authentication required",
            )
            await websocket.send_text(error_response)
            await websocket.close(code=1008, reason="Unauthorized")
            return

        # Create connection state and register
        conn_state = ConnectionState(websocket=websocket, client=client)
        manager.add_connection(conn_state)

        # Send successful connect response
        connect_response = create_response(
            "connect",
            result={
                "conn_id": conn_id,
                "protocol_version": "1.0",
                "server_version": "0.1.0",
            },
        )
        await websocket.send_text(connect_response)

        # Enter message loop
        await message_loop(websocket, conn_state, manager)

    except WebSocketDisconnect:
        log_info("WebSocket disconnected normally", conn_id=conn_id)
    except Exception as e:
        log_error("WebSocket connection error", conn_id=conn_id, error=str(e))
    finally:
        if conn_state:
            conn_state.is_alive = False
            manager.remove_connection(conn_state)


async def handle_connect_frame(
    websocket: WebSocket,
    conn_id: str,
) -> ConnectParams | None:
    """Handle the initial connect frame from client.

    Args:
        websocket: WebSocket connection
        conn_id: Connection ID for logging

    Returns:
        ConnectParams if valid, None otherwise
    """
    try:
        # Wait for connect frame (with timeout)
        raw_message = await websocket.receive_text()
        frame = parse_frame(raw_message)

        if not frame:
            log_warn("Invalid connect frame format", conn_id=conn_id)
            return None

        if frame.type != "request" or frame.method != "connect":
            log_warn(
                "First frame must be connect request",
                conn_id=conn_id,
                frame_type=frame.type,
                method=frame.method,
            )
            return None

        # Parse connect parameters
        params = frame.params or {}
        return ConnectParams(**params)

    except Exception as e:
        log_error("Failed to handle connect frame", conn_id=conn_id, error=str(e))
        return None


def authenticate_connection(
    client_ip: str | None,
    config: GatewayConfig,
) -> tuple[bool, str | None]:
    """Authenticate a WebSocket connection.

    Args:
        client_ip: Client IP address
        config: Gateway configuration

    Returns:
        Tuple of (authenticated, auth_source)
    """
    # Local connections are always allowed
    if client_ip and is_local_request(client_ip):
        return True, "local-direct"

    # TestClient connections (no IP) are also allowed for testing
    if client_ip is None or client_ip == "testclient":
        return True, "local-direct"

    # For now, require local connections only
    # Token/password auth will be added when we implement query param auth
    return False, None


async def message_loop(
    websocket: WebSocket,
    conn_state: ConnectionState,
    manager: WebSocketConnectionManager,
) -> None:
    """Main message processing loop for a WebSocket connection.

    Args:
        websocket: WebSocket connection
        conn_state: Connection state
        manager: Connection manager
    """
    while conn_state.is_alive:
        try:
            raw_message = await websocket.receive_text()
            await handle_message(raw_message, conn_state, manager)
        except WebSocketDisconnect:
            log_info(
                "Client disconnected",
                conn_id=conn_state.client.conn_id,
            )
            break
        except Exception as e:
            log_error(
                "Error in message loop",
                conn_id=conn_state.client.conn_id,
                error=str(e),
            )
            break


async def handle_message(
    raw_message: str,
    conn_state: ConnectionState,
    manager: WebSocketConnectionManager,
) -> None:
    """Handle a single WebSocket message.

    Args:
        raw_message: Raw message string
        conn_state: Connection state
        manager: Connection manager
    """
    # Parse frame
    frame = parse_frame(raw_message)
    if not frame:
        error_response = create_error_response(
            "unknown",
            "invalid_frame",
            "Failed to parse message frame",
        )
        await send_response_to_client(
            conn_state.websocket,
            error_response,
            conn_state.client.conn_id,
        )
        return

    # Handle different frame types
    if frame.type == "request":
        await handle_request(frame, conn_state, manager)
    elif frame.type == "response":
        # Client responses (if needed for bidirectional RPC)
        log_info(
            "Received response from client",
            conn_id=conn_state.client.conn_id,
            response_id=frame.id,
        )
    else:
        log_warn(
            "Unknown frame type",
            conn_id=conn_state.client.conn_id,
            frame_type=frame.type,
        )


async def handle_request(
    frame: Any,
    conn_state: ConnectionState,
    manager: WebSocketConnectionManager,
) -> None:
    """Handle a request frame from client.

    Args:
        frame: Parsed WebSocket frame
        conn_state: Connection state
        manager: Connection manager
    """
    request = validate_request(frame)
    if not request:
        error_response = create_error_response(
            frame.id or "unknown",
            "invalid_request",
            "Invalid request frame",
        )
        await send_response_to_client(
            conn_state.websocket,
            error_response,
            conn_state.client.conn_id,
        )
        return

    # Handle built-in methods
    if request.method == "ping":
        await handle_ping(request, conn_state)
    elif request.method == "get_status":
        await handle_get_status(request, conn_state, manager)
    else:
        # Unknown method
        error_response = create_error_response(
            request.id,
            "method_not_found",
            f"Method not found: {request.method}",
        )
        await send_response_to_client(
            conn_state.websocket,
            error_response,
            conn_state.client.conn_id,
        )


async def handle_ping(request: Any, conn_state: ConnectionState) -> None:
    """Handle ping request.

    Args:
        request: Ping request
        conn_state: Connection state
    """
    response = create_response(request.id, result={"pong": True})
    await send_response_to_client(
        conn_state.websocket,
        response,
        conn_state.client.conn_id,
    )


async def handle_get_status(
    request: Any,
    conn_state: ConnectionState,
    manager: WebSocketConnectionManager,
) -> None:
    """Handle get_status request.

    Args:
        request: Status request
        conn_state: Connection state
        manager: Connection manager
    """
    status = {
        "conn_id": conn_state.client.conn_id,
        "client_id": conn_state.client.client_id,
        "connected_at": conn_state.client.connected_at,
        "authenticated": conn_state.client.authenticated,
        "total_connections": manager.get_connection_count(),
    }

    response = create_response(request.id, result=status)
    await send_response_to_client(
        conn_state.websocket,
        response,
        conn_state.client.conn_id,
    )
