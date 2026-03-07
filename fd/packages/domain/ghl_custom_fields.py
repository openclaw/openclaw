from __future__ import annotations

import sqlite3

from packages.common.audit import write_audit
from packages.common.config import settings
from packages.integrations.ghl.client import GHLClient


def get_dropbox_folder_url(
    conn: sqlite3.Connection,
    *,
    ghl_contact_id: str,
    correlation_id: str | None,
) -> str | None:
    """Read the Dropbox folder URL from a GHL contact's custom fields."""
    if not (settings.GHL_API_KEY and settings.GHL_DROPBOX_FOLDER_URL_CUSTOM_FIELD_KEY):
        write_audit(
            conn,
            action="ghl.dropbox_field.unconfigured",
            target=ghl_contact_id,
            payload={},
            correlation_id=correlation_id,
        )
        return None

    gh = GHLClient()
    mp = gh.get_contact_custom_fields_map(contact_id=ghl_contact_id)
    url = mp.get(settings.GHL_DROPBOX_FOLDER_URL_CUSTOM_FIELD_KEY)
    if url and isinstance(url, str):
        url = url.strip()
    write_audit(
        conn,
        action="ghl.dropbox_field.read",
        target=ghl_contact_id,
        payload={"has_url": bool(url)},
        correlation_id=correlation_id,
    )
    return url or None
