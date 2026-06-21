"""Fixture-first Gmail Media Intelligence sidecar."""

from .models import CONNECTOR_VERSION, SCHEMA_NAME, SCHEMA_VERSION, GmailMediaItem
from .parser import ParseError, parse_gmail_message

__all__ = [
    "CONNECTOR_VERSION",
    "SCHEMA_NAME",
    "SCHEMA_VERSION",
    "GmailMediaItem",
    "ParseError",
    "parse_gmail_message",
]
