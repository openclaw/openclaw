"""WebSocket types and models.

This module defines data structures for WebSocket connections and messaging.
"""

from typing import Any

from fastapi import WebSocket
from pydantic import BaseModel, Field


class ConnectParams(BaseModel):
    """WebSocket connection parameters sent in the connect frame."""

    client_id: str | None = None
    client_version: str | None = None
    protocol_version: str = "1.0"
    device_id: str | None = None
    platform: str | None = None


class WebSocketClient(BaseModel):
    """WebSocket client information.

    Tracks connected client state and metadata.
    """

    conn_id: str  # Unique connection ID
    client_id: str | None = None  # Client-provided ID
    client_version: str | None = None
    protocol_version: str = "1.0"
    device_id: str | None = None
    platform: str | None = None
    client_ip: str | None = None
    authenticated: bool = False
    auth_source: str | None = None  # "token", "password", "local-direct"
    connected_at: int  # Timestamp in milliseconds

    class Config:
        arbitrary_types_allowed = True


class WebSocketFrame(BaseModel):
    """WebSocket message frame.

    Represents a JSON-RPC style message frame for bidirectional communication.
    """

    type: str  # "request", "response", "event"
    id: str | None = None  # Frame ID for request/response matching
    method: str | None = None  # Method name for requests
    params: dict[str, Any] | None = None  # Parameters for requests/events
    result: Any = None  # Result for successful responses
    error: dict[str, Any] | None = None  # Error for failed responses
    event: str | None = None  # Event name for event frames


class WebSocketRequest(BaseModel):
    """WebSocket request frame."""

    type: str = "request"
    id: str
    method: str
    params: dict[str, Any] = Field(default_factory=dict)


class WebSocketResponse(BaseModel):
    """WebSocket response frame."""

    type: str = "response"
    id: str
    result: Any = None
    error: dict[str, Any] | None = None


class WebSocketEvent(BaseModel):
    """WebSocket event frame (server -> client broadcast)."""

    type: str = "event"
    event: str
    params: dict[str, Any] = Field(default_factory=dict)


class WebSocketError(BaseModel):
    """WebSocket error information."""

    code: str
    message: str
    details: dict[str, Any] | None = None


# Connection state tracking
class ConnectionState:
    """Tracks the state of a WebSocket connection.

    This is not a Pydantic model because it contains non-serializable state.
    """

    def __init__(
        self,
        websocket: WebSocket,
        client: WebSocketClient,
    ):
        self.websocket = websocket
        self.client = client
        self.is_alive = True
        self.last_pong_at: int | None = None
