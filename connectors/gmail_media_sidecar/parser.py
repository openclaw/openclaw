"""Pure Gmail fixture parser.

Inputs are Gmail API `users.messages.get(format=full)`-style JSON objects. The
parser never calls Gmail, follows URLs, opens attachments, or treats source
content as instructions.
"""

from __future__ import annotations

import base64
import binascii
import json
import re
from datetime import datetime, timezone
from email.utils import getaddresses, parsedate_to_datetime
from html.parser import HTMLParser
from pathlib import Path
from typing import Any

from .dedupe import build_dedupe_key, canonical_json_bytes, sha256_bytes, sha256_text
from .models import (
    CONNECTOR_VERSION,
    SCHEMA_NAME,
    SCHEMA_VERSION,
    AttachmentMetadata,
    EmailParticipant,
    GmailMediaItem,
    UrlReference,
)

DEFAULT_SOURCE_ACCOUNT = "synthetic-gmail-fixtures@example.invalid"
DEFAULT_SOURCE_PROFILE_ID = "gmail-media-sidecar-fixtures"
URL_RE = re.compile(r"https?://[^\s<>'\"\\]+", re.IGNORECASE)


class ParseError(ValueError):
    """Raised when a fixture cannot be normalized into a GmailMediaItem."""


class _HTMLTextExtractor(HTMLParser):
    _block_tags = {
        "address",
        "article",
        "aside",
        "blockquote",
        "br",
        "div",
        "footer",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "header",
        "li",
        "main",
        "p",
        "section",
        "table",
        "tr",
    }
    _url_attrs = {"action", "cite", "href", "src"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._chunks: list[str] = []
        self.urls: list[str] = []
        self._skip_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        normalized = tag.lower()
        if normalized in {"script", "style", "noscript"}:
            self._skip_depth += 1
        if normalized in self._block_tags:
            self._chunks.append("\n")
        for attr_name, attr_value in attrs:
            if attr_name.lower() in self._url_attrs and attr_value:
                self.urls.extend(_extract_urls_from_text(attr_value))

    def handle_endtag(self, tag: str) -> None:
        normalized = tag.lower()
        if normalized in {"script", "style", "noscript"} and self._skip_depth:
            self._skip_depth -= 1
        if normalized in self._block_tags:
            self._chunks.append("\n")

    def handle_data(self, data: str) -> None:
        if not self._skip_depth:
            self._chunks.append(data)

    def text(self) -> str:
        return _normalize_text("".join(self._chunks))


def parse_gmail_message(
    message: dict[str, Any],
    *,
    ingestion_run_id: str,
    source_account: str = DEFAULT_SOURCE_ACCOUNT,
    source_profile_id: str = DEFAULT_SOURCE_PROFILE_ID,
    source_selector: dict[str, str | None] | None = None,
    fixture_path: str | None = None,
) -> GmailMediaItem:
    if not isinstance(message, dict):
        raise ParseError("Gmail fixture must be a JSON object")

    gmail_message_id = _string_or_none(message.get("id"))
    if not gmail_message_id:
        raise ParseError("Gmail message is missing id")

    payload = message.get("payload")
    if not isinstance(payload, dict):
        raise ParseError(f"Gmail message {gmail_message_id} is missing payload")

    headers = _header_map(payload.get("headers", []))
    subject = _first_header(headers, "subject")
    sender = _first_participant(_first_header(headers, "from"))
    recipients = {
        "to": _participants(_header_values(headers, "to")),
        "cc": _participants(_header_values(headers, "cc")),
        "bcc": _participants(_header_values(headers, "bcc")),
    }
    date_header = _first_header(headers, "date")
    sent_at = _iso_from_date_header(date_header)
    internal_date_ms = _internal_date_ms(message.get("internalDate"))
    received_at = _iso_from_internal_date(internal_date_ms) or sent_at
    rfc822_message_id = _first_header(headers, "message-id")

    parse_state = _ParseState()
    _walk_payload(payload, parse_state)

    body_plain = _normalize_text("\n\n".join(parse_state.plain_texts))
    body_html_text = _normalize_text("\n\n".join(parse_state.html_texts))
    body_text = body_plain if body_plain else body_html_text
    body_sha256 = sha256_text(body_text)
    raw_payload_bytes = canonical_json_bytes(message)
    raw_payload_sha256 = sha256_bytes(raw_payload_bytes)

    urls = _merged_url_references(
        [
            ("plain_text", body_plain),
            ("html_text", body_html_text),
        ],
        html_attribute_urls=parse_state.html_attribute_urls,
    )
    labels = sorted(str(label) for label in message.get("labelIds", []) if isinstance(label, str))
    selector = {
        "query": None,
        "label_id": None,
        "label_name": None,
    }
    if source_selector:
        selector.update(source_selector)

    dedupe_key = build_dedupe_key(
        source_account=source_account,
        gmail_message_id=gmail_message_id,
        gmail_thread_id=_string_or_none(message.get("threadId")),
        rfc822_message_id=rfc822_message_id,
        internal_date_ms=internal_date_ms,
        normalized_text_sha256=body_sha256,
    )

    return GmailMediaItem(
        schema_name=SCHEMA_NAME,
        schema_version=SCHEMA_VERSION,
        connector_version=CONNECTOR_VERSION,
        ingestion_run_id=ingestion_run_id,
        source_account=source_account,
        source_profile_id=source_profile_id,
        source_selector=selector,
        gmail_message_id=gmail_message_id,
        gmail_thread_id=_string_or_none(message.get("threadId")),
        rfc822_message_id=rfc822_message_id,
        subject=subject,
        sender=sender,
        recipients=recipients,
        received_at=received_at,
        sent_at=sent_at,
        date_header=date_header,
        internal_date_ms=internal_date_ms,
        labels=labels,
        snippet=_string_or_none(message.get("snippet")),
        body_plain=body_plain,
        body_html_text=body_html_text,
        body_text=body_text,
        body_available=bool(body_text),
        body_chars=len(body_text),
        body_sha256=body_sha256,
        plain_text_present=bool(body_plain),
        html_present=bool(body_html_text),
        raw_payload_sha256=raw_payload_sha256,
        raw_payload_size_bytes=len(raw_payload_bytes),
        attachments=parse_state.attachments,
        extracted_urls=urls,
        provenance={
            "input_kind": "gmail_api_message_full_fixture",
            "fixture_path": fixture_path,
            "parser": "connectors.gmail_media_sidecar.parser",
            "raw_payload_sha256": raw_payload_sha256,
        },
        hostile_content={
            "is_untrusted": True,
            "email_content_may_contain_instructions": True,
            "links_followed": False,
            "attachments_downloaded": False,
            "interpretation_performed": False,
        },
        dedupe_key=dedupe_key,
        parse_warnings=parse_state.warnings,
    )


def load_fixture(path: Path, *, fixture_ref: str | None = None, **kwargs: Any) -> GmailMediaItem:
    with path.open("r", encoding="utf-8") as handle:
        message = json.load(handle)
    return parse_gmail_message(message, fixture_path=fixture_ref or str(path), **kwargs)


class _ParseState:
    def __init__(self) -> None:
        self.plain_texts: list[str] = []
        self.html_texts: list[str] = []
        self.html_attribute_urls: list[str] = []
        self.attachments: list[AttachmentMetadata] = []
        self.warnings: list[str] = []


def _walk_payload(part: dict[str, Any], state: _ParseState) -> None:
    mime_type = _string_or_none(part.get("mimeType")) or ""
    body = part.get("body") if isinstance(part.get("body"), dict) else {}
    part_headers = _header_map(part.get("headers", []))
    filename = _string_or_none(part.get("filename"))
    content_disposition = _first_header(part_headers, "content-disposition")
    is_attachment = bool(
        filename
        or body.get("attachmentId")
        or (content_disposition and "attachment" in content_disposition.lower())
    )

    if is_attachment:
        state.attachments.append(
            AttachmentMetadata(
                filename=filename,
                mime_type=mime_type or None,
                size_bytes=_int_or_none(body.get("size")),
                part_id=_string_or_none(part.get("partId")),
                attachment_id_present=bool(body.get("attachmentId")),
                content_disposition=content_disposition,
                content_id=_first_header(part_headers, "content-id"),
                fetched=False,
            )
        )
        return

    if mime_type.lower() == "text/plain":
        decoded = _decode_body_text(body, state)
        if decoded is not None:
            state.plain_texts.append(decoded)
    elif mime_type.lower() == "text/html":
        decoded = _decode_body_text(body, state)
        if decoded is not None:
            extractor = _HTMLTextExtractor()
            extractor.feed(decoded)
            state.html_texts.append(extractor.text())
            state.html_attribute_urls.extend(extractor.urls)

    for child in part.get("parts", []) or []:
        if isinstance(child, dict):
            _walk_payload(child, state)
        else:
            state.warnings.append("ignored non-object MIME part")


def _decode_body_text(body: dict[str, Any], state: _ParseState) -> str | None:
    data = body.get("data")
    if not data:
        return ""
    if not isinstance(data, str):
        state.warnings.append("ignored non-string body data")
        return None
    padded = data + "=" * (-len(data) % 4)
    try:
        return base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8", errors="replace")
    except (binascii.Error, ValueError):
        state.warnings.append("ignored invalid base64url body data")
        return None


def _header_map(headers: Any) -> dict[str, list[str]]:
    mapped: dict[str, list[str]] = {}
    if not isinstance(headers, list):
        return mapped
    for header in headers:
        if not isinstance(header, dict):
            continue
        name = _string_or_none(header.get("name"))
        value = _string_or_none(header.get("value"))
        if name and value is not None:
            mapped.setdefault(name.lower(), []).append(value)
    return mapped


def _header_values(headers: dict[str, list[str]], name: str) -> list[str]:
    return headers.get(name.lower(), [])


def _first_header(headers: dict[str, list[str]], name: str) -> str | None:
    values = _header_values(headers, name)
    return values[0] if values else None


def _first_participant(value: str | None) -> EmailParticipant | None:
    participants = _participants([value] if value else [])
    return participants[0] if participants else None


def _participants(values: list[str]) -> list[EmailParticipant]:
    raw_pairs = getaddresses(values)
    if not raw_pairs and values:
        return [EmailParticipant(raw=value) for value in values if value]
    participants: list[EmailParticipant] = []
    for name, address in raw_pairs:
        raw = f"{name} <{address}>" if name and address else address or name
        if raw:
            participants.append(
                EmailParticipant(raw=raw, name=name or None, address=address or None)
            )
    return participants


def _internal_date_ms(value: Any) -> int | None:
    parsed = _int_or_none(value)
    return parsed if parsed is not None and parsed >= 0 else None


def _int_or_none(value: Any) -> int | None:
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return None
    return None


def _iso_from_internal_date(value: int | None) -> str | None:
    if value is None:
        return None
    return datetime.fromtimestamp(value / 1000, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def _iso_from_date_header(value: str | None) -> str | None:
    if not value:
        return None
    try:
        parsed = parsedate_to_datetime(value)
    except (TypeError, ValueError, IndexError, OverflowError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _merged_url_references(
    text_sources: list[tuple[str, str]],
    *,
    html_attribute_urls: list[str],
) -> list[UrlReference]:
    by_url: dict[str, set[str]] = {}
    for source, text in text_sources:
        for url in _extract_urls_from_text(text):
            by_url.setdefault(url, set()).add(source)
    for url in html_attribute_urls:
        by_url.setdefault(url, set()).add("html_attribute")
    return [UrlReference(url=url, sources=sorted(sources)) for url, sources in sorted(by_url.items())]


def _extract_urls_from_text(value: str) -> list[str]:
    urls: list[str] = []
    for match in URL_RE.finditer(value):
        url = match.group(0).rstrip(".,;:!?)\"]}")
        if url:
            urls.append(url)
    return urls


def _normalize_text(value: str) -> str:
    lines = [" ".join(line.split()) for line in value.replace("\r\n", "\n").split("\n")]
    normalized = "\n".join(line for line in lines if line)
    return normalized.strip()


def _string_or_none(value: Any) -> str | None:
    if isinstance(value, str):
        return value
    return None
