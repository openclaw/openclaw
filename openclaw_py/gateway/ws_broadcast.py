"""WebSocket broadcast utilities.

This module provides functions for broadcasting messages to WebSocket clients.
"""

from typing import Any

from fastapi import WebSocket, WebSocketDisconnect

from openclaw_py.logging import log_error, log_info, log_warn

from .ws_protocol import create_event
from .ws_types import ConnectionState


async def broadcast_event(
    event_name: str,
    params: dict[str, Any] | None = None,
    connections: set[ConnectionState] | None = None,
    drop_if_slow: bool = False,
) -> int:
    """Broadcast an event to all connected clients.

    Args:
        event_name: Name of the event to broadcast
        params: Event parameters/payload
        connections: Set of active connections (if None, broadcasts to none)
        drop_if_slow: If True, skip clients that are slow to receive

    Returns:
        Number of clients that received the event

    Examples:
        >>> # In a real WebSocket handler
        >>> count = await broadcast_event("config.updated", {"version": 2}, connections)
        >>> count >= 0
        True
    """
    if not connections:
        return 0

    event_json = create_event(event_name, params)
    sent_count = 0
    failed_clients = []

    for conn_state in list(connections):  # Copy to avoid modification during iteration
        if not conn_state.is_alive:
            failed_clients.append(conn_state)
            continue

        try:
            await conn_state.websocket.send_text(event_json)
            sent_count += 1
        except WebSocketDisconnect:
            log_info(
                "Client disconnected during broadcast",
                conn_id=conn_state.client.conn_id,
                event=event_name,
            )
            conn_state.is_alive = False
            failed_clients.append(conn_state)
        except Exception as e:
            if drop_if_slow:
                log_warn(
                    "Skipping slow client during broadcast",
                    conn_id=conn_state.client.conn_id,
                    event=event_name,
                    error=str(e),
                )
            else:
                log_error(
                    "Failed to broadcast to client",
                    conn_id=conn_state.client.conn_id,
                    event=event_name,
                    error=str(e),
                )
            if not drop_if_slow:
                failed_clients.append(conn_state)

    # Remove failed connections
    for failed in failed_clients:
        connections.discard(failed)

    if sent_count > 0:
        log_info(
            "Broadcast event sent",
            event=event_name,
            recipients=sent_count,
            failed=len(failed_clients),
        )

    return sent_count


async def send_to_client(
    websocket: WebSocket,
    message: str,
    conn_id: str | None = None,
) -> bool:
    """Send a message to a specific client.

    Args:
        websocket: WebSocket connection
        message: JSON message to send
        conn_id: Connection ID (for logging)

    Returns:
        True if sent successfully, False otherwise

    Examples:
        >>> # In a real WebSocket handler
        >>> success = await send_to_client(websocket, '{"type":"event"}')
        >>> isinstance(success, bool)
        True
    """
    try:
        await websocket.send_text(message)
        return True
    except WebSocketDisconnect:
        log_info("Client disconnected during send", conn_id=conn_id or "unknown")
        return False
    except Exception as e:
        log_error(
            "Failed to send message to client",
            conn_id=conn_id or "unknown",
            error=str(e),
        )
        return False


async def send_response_to_client(
    websocket: WebSocket,
    response_json: str,
    conn_id: str | None = None,
) -> bool:
    """Send a response frame to a client.

    This is a convenience wrapper around send_to_client for responses.

    Args:
        websocket: WebSocket connection
        response_json: JSON response string
        conn_id: Connection ID (for logging)

    Returns:
        True if sent successfully, False otherwise
    """
    return await send_to_client(websocket, response_json, conn_id)
