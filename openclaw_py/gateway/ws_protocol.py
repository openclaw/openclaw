"""WebSocket protocol utilities.

This module provides functions for parsing and creating WebSocket frames.
"""

import json
from typing import Any

from pydantic import ValidationError

from openclaw_py.logging import log_error, log_warn

from .ws_types import (
    WebSocketError,
    WebSocketEvent,
    WebSocketFrame,
    WebSocketRequest,
    WebSocketResponse,
)


def parse_frame(raw_message: str) -> WebSocketFrame | None:
    """Parse a raw WebSocket message into a frame.

    Args:
        raw_message: Raw JSON string from WebSocket

    Returns:
        WebSocketFrame if valid, None if parsing fails

    Examples:
        >>> frame = parse_frame('{"type":"request","id":"1","method":"ping"}')
        >>> frame.type
        'request'
    """
    try:
        data = json.loads(raw_message)
        return WebSocketFrame(**data)
    except json.JSONDecodeError as e:
        log_warn("Failed to parse WebSocket message as JSON", error=str(e))
        return None
    except ValidationError as e:
        log_warn("Invalid WebSocket frame format", error=str(e))
        return None
    except Exception as e:
        log_error("Unexpected error parsing WebSocket frame", error=str(e))
        return None


def create_response(
    request_id: str,
    result: Any = None,
    error: WebSocketError | None = None,
) -> str:
    """Create a response frame JSON string.

    Args:
        request_id: ID of the request being responded to
        result: Result data (if successful)
        error: Error information (if failed)

    Returns:
        JSON string of the response frame

    Examples:
        >>> response = create_response("1", result={"status": "ok"})
        >>> "response" in response
        True
    """
    response = WebSocketResponse(
        id=request_id,
        result=result,
        error=error.model_dump() if error else None,
    )
    return response.model_dump_json(exclude_none=True)


def create_error_response(
    request_id: str,
    code: str,
    message: str,
    details: dict[str, Any] | None = None,
) -> str:
    """Create an error response frame.

    Args:
        request_id: ID of the request that failed
        code: Error code (e.g., "invalid_method", "unauthorized")
        message: Human-readable error message
        details: Additional error details

    Returns:
        JSON string of the error response

    Examples:
        >>> error = create_error_response("1", "not_found", "Method not found")
        >>> "error" in error
        True
    """
    error = WebSocketError(code=code, message=message, details=details)
    return create_response(request_id, error=error)


def create_event(event_name: str, params: dict[str, Any] | None = None) -> str:
    """Create an event frame JSON string.

    Args:
        event_name: Name of the event
        params: Event parameters/payload

    Returns:
        JSON string of the event frame

    Examples:
        >>> event = create_event("session.created", {"session_id": "123"})
        >>> "event" in event
        True
    """
    event = WebSocketEvent(
        event=event_name,
        params=params or {},
    )
    return event.model_dump_json(exclude_none=True)


def validate_request(frame: WebSocketFrame) -> WebSocketRequest | None:
    """Validate and convert a frame to a request.

    Args:
        frame: Parsed WebSocket frame

    Returns:
        WebSocketRequest if valid, None otherwise
    """
    if frame.type != "request":
        log_warn("Frame is not a request", frame_type=frame.type)
        return None

    if not frame.id:
        log_warn("Request frame missing ID")
        return None

    if not frame.method:
        log_warn("Request frame missing method")
        return None

    try:
        return WebSocketRequest(
            id=frame.id,
            method=frame.method,
            params=frame.params or {},
        )
    except ValidationError as e:
        log_error("Failed to validate request frame", error=str(e))
        return None


def serialize_frame(frame: WebSocketFrame | WebSocketRequest | WebSocketResponse | WebSocketEvent) -> str:
    """Serialize a frame to JSON string.

    Args:
        frame: Frame object to serialize

    Returns:
        JSON string

    Examples:
        >>> from ws_types import WebSocketEvent
        >>> event = WebSocketEvent(event="test", params={})
        >>> json_str = serialize_frame(event)
        >>> isinstance(json_str, str)
        True
    """
    return frame.model_dump_json(exclude_none=True)
