"""Common utility functions for OpenClaw.

This module provides general-purpose utility functions used throughout the codebase.
"""

import json
import re
from pathlib import Path
from typing import Any


def ensure_dir(dir_path: str | Path) -> None:
    """Ensure directory exists (create if missing).

    Args:
        dir_path: Directory path to ensure exists
    """
    path = Path(dir_path)
    path.mkdir(parents=True, exist_ok=True)


async def path_exists(path: str | Path) -> bool:
    """Check if a file or directory exists.

    Args:
        path: Path to check

    Returns:
        True if path exists, False otherwise
    """
    return Path(path).exists()


def clamp(value: float, min_val: float, max_val: float) -> float:
    """Clamp a number to a range [min_val, max_val].

    Args:
        value: Value to clamp
        min_val: Minimum value
        max_val: Maximum value

    Returns:
        Clamped value

    Examples:
        >>> clamp(5, 0, 10)
        5
        >>> clamp(-5, 0, 10)
        0
        >>> clamp(15, 0, 10)
        10
    """
    return max(min_val, min(max_val, value))


def clamp_int(value: int | float, min_val: int, max_val: int) -> int:
    """Clamp an integer to a range [min_val, max_val].

    Args:
        value: Value to clamp (will be floored if float)
        min_val: Minimum value
        max_val: Maximum value

    Returns:
        Clamped integer value

    Examples:
        >>> clamp_int(5, 0, 10)
        5
        >>> clamp_int(5.7, 0, 10)
        5
        >>> clamp_int(-5, 0, 10)
        0
    """
    return int(clamp(float(int(value)), float(min_val), float(max_val)))


def clamp_number(value: float, min_val: float, max_val: float) -> float:
    """Alias for clamp() for compatibility.

    Args:
        value: Value to clamp
        min_val: Minimum value
        max_val: Maximum value

    Returns:
        Clamped value
    """
    return clamp(value, min_val, max_val)


def escape_regexp(text: str) -> str:
    """Escape special regex characters in a string.

    Args:
        text: String to escape

    Returns:
        String with regex special characters escaped

    Examples:
        >>> escape_regexp("hello.world")
        'hello\\\\.world'
        >>> escape_regexp("a*b+c?")
        'a\\\\*b\\\\+c\\\\?'
    """
    # Escape all special regex characters
    return re.escape(text)


def safe_parse_json(text: str) -> dict | list | Any | None:
    """Safely parse JSON, returning None on error.

    Args:
        text: JSON string to parse

    Returns:
        Parsed JSON (dict, list, or primitive) or None if parsing fails

    Examples:
        >>> safe_parse_json('{"key": "value"}')
        {'key': 'value'}
        >>> safe_parse_json('invalid json')
        None
        >>> safe_parse_json('[1, 2, 3]')
        [1, 2, 3]
    """
    try:
        return json.loads(text)
    except (json.JSONDecodeError, ValueError, TypeError):
        return None


def is_plain_object(value: Any) -> bool:
    """Type guard for plain dict objects (not arrays, None, etc.).

    Args:
        value: Value to check

    Returns:
        True if value is a plain dict, False otherwise

    Examples:
        >>> is_plain_object({'a': 1})
        True
        >>> is_plain_object([1, 2, 3])
        False
        >>> is_plain_object(None)
        False
        >>> is_plain_object("string")
        False
    """
    return (
        isinstance(value, dict)
        and type(value) is dict  # Ensure it's exactly dict, not a subclass
        and not isinstance(value, type)  # Not a class
    )


def is_record(value: Any) -> bool:
    """Type guard for dict-like objects (less strict than is_plain_object).

    Accepts any non-None dict-like object that isn't a list.

    Args:
        value: Value to check

    Returns:
        True if value is dict-like, False otherwise

    Examples:
        >>> is_record({'a': 1})
        True
        >>> is_record([1, 2, 3])
        False
        >>> is_record(None)
        False
    """
    return isinstance(value, dict) and not isinstance(value, list)


def normalize_path(path: str) -> str:
    """Normalize a path by ensuring it starts with /.

    Args:
        path: Path string

    Returns:
        Path with leading /

    Examples:
        >>> normalize_path("api/endpoint")
        '/api/endpoint'
        >>> normalize_path("/api/endpoint")
        '/api/endpoint'
    """
    if not path.startswith("/"):
        return f"/{path}"
    return path
