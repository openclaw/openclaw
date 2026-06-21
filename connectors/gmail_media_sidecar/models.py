"""Data model for normalized Gmail media source records.

The schema stores source content and provenance only. It intentionally has no
summary, classification, priority, memory, or editorial fields.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from typing import Any

SCHEMA_NAME = "gmail_media_item"
SCHEMA_VERSION = "0.1.0"
CONNECTOR_VERSION = "0.1.0"


@dataclass(frozen=True)
class EmailParticipant:
    raw: str
    name: str | None = None
    address: str | None = None


@dataclass(frozen=True)
class AttachmentMetadata:
    filename: str | None
    mime_type: str | None
    size_bytes: int | None
    part_id: str | None
    attachment_id_present: bool
    content_disposition: str | None = None
    content_id: str | None = None
    fetched: bool = False


@dataclass(frozen=True)
class UrlReference:
    url: str
    sources: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class GmailMediaItem:
    schema_name: str
    schema_version: str
    connector_version: str
    ingestion_run_id: str
    source_account: str
    source_profile_id: str
    source_selector: dict[str, str | None]
    gmail_message_id: str
    gmail_thread_id: str | None
    rfc822_message_id: str | None
    subject: str | None
    sender: EmailParticipant | None
    recipients: dict[str, list[EmailParticipant]]
    received_at: str | None
    sent_at: str | None
    date_header: str | None
    internal_date_ms: int | None
    labels: list[str]
    snippet: str | None
    body_plain: str
    body_html_text: str
    body_text: str
    body_available: bool
    body_chars: int
    body_sha256: str
    plain_text_present: bool
    html_present: bool
    raw_payload_sha256: str
    raw_payload_size_bytes: int
    attachments: list[AttachmentMetadata]
    extracted_urls: list[UrlReference]
    provenance: dict[str, Any]
    hostile_content: dict[str, Any]
    dedupe_key: str
    parse_warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return _strip_none(asdict(self))

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _strip_none(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: _strip_none(item) for key, item in value.items() if item is not None}
    if isinstance(value, list):
        return [_strip_none(item) for item in value]
    return value
