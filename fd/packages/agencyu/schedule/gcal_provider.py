"""Google Calendar Provider — reads/writes events via service account + domain-wide delegation.

Uses Google Calendar API v3 with service account credentials.
Domain: fulldigitalll.com Google Workspace.
Auth: service account JSON key + domain-wide delegation to impersonate a user.

Multi-calendar support: pulls from GCAL_CALENDAR_IDS_JSON list.
External key format: gcal:<calendar_id>:<event_id>

Read-only by default. Write support requires GCAL_WRITE_ENABLED=true.
Only system-owned events are written; Trello dues stay out of GCal
unless GCAL_WRITE_TRELLO_DUE=true.
"""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

import httpx
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential

from packages.agencyu.schedule.models import ScheduleEvent
from packages.agencyu.schedule.repo import ScheduleRepo
from packages.common.logging import get_logger

log = get_logger("agencyu.schedule.gcal_provider")

_CALENDAR_API = "https://www.googleapis.com/calendar/v3"
_SCOPES_READ = ["https://www.googleapis.com/auth/calendar.readonly"]
_SCOPES_WRITE = ["https://www.googleapis.com/auth/calendar"]

_RETRY = dict(
    reraise=True,
    stop=stop_after_attempt(4),
    wait=wait_exponential(multiplier=1, min=2, max=16),
    retry=retry_if_exception_type((httpx.HTTPStatusError, httpx.ConnectError)),
)


def _gcal_external_key(calendar_id: str, event_id: str) -> str:
    """Stable external key: gcal:<calendar_id>:<event_id>."""
    return f"gcal:{calendar_id}:{event_id}"


class GCalProvider:
    """Google Calendar provider using service account + domain-wide delegation.

    Supports reading from multiple calendars and optional write.

    Requires:
        - Service account JSON key (path or dict)
        - Impersonation email (user on fulldigitalll.com domain)
        - One or more calendar IDs
    """

    def __init__(
        self,
        service_account_key: dict[str, Any] | str,
        impersonate_email: str,
        calendar_ids: list[str] | None = None,
        *,
        write_enabled: bool = False,
    ) -> None:
        self._key = service_account_key
        self._impersonate_email = impersonate_email
        self._calendar_ids = calendar_ids or ["primary"]
        self._write_enabled = write_enabled
        self._client = httpx.Client(timeout=20.0)
        self._access_token: str | None = None
        self._token_expires_at: datetime | None = None

    @property
    def calendar_ids(self) -> list[str]:
        return list(self._calendar_ids)

    def _ensure_token(self) -> str:
        """Get or refresh the OAuth2 access token via service account JWT."""
        now = datetime.utcnow()
        if self._access_token and self._token_expires_at and now < self._token_expires_at:
            return self._access_token

        import json
        import time

        import jwt

        key_data = self._key
        if isinstance(key_data, str):
            with open(key_data) as f:
                key_data = json.load(f)

        scopes = _SCOPES_WRITE if self._write_enabled else _SCOPES_READ

        iat = int(time.time())
        payload = {
            "iss": key_data["client_email"],
            "sub": self._impersonate_email,
            "scope": " ".join(scopes),
            "aud": "https://oauth2.googleapis.com/token",
            "iat": iat,
            "exp": iat + 3600,
        }
        assertion = jwt.encode(payload, key_data["private_key"], algorithm="RS256")

        resp = self._client.post(
            "https://oauth2.googleapis.com/token",
            data={
                "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
                "assertion": assertion,
            },
        )
        resp.raise_for_status()
        token_data = resp.json()

        self._access_token = token_data["access_token"]
        self._token_expires_at = now + timedelta(seconds=token_data.get("expires_in", 3600) - 60)
        return self._access_token

    def _headers(self) -> dict[str, str]:
        token = self._ensure_token()
        return {"Authorization": f"Bearer {token}"}

    # ── Read ──

    @retry(**_RETRY)
    def list_events(
        self,
        calendar_id: str = "primary",
        time_min: datetime | None = None,
        time_max: datetime | None = None,
        max_results: int = 250,
    ) -> list[dict[str, Any]]:
        """List calendar events in a time range for a specific calendar."""
        if time_min is None:
            time_min = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
        if time_max is None:
            time_max = time_min + timedelta(days=1)

        params: dict[str, Any] = {
            "timeMin": time_min.isoformat() + "Z",
            "timeMax": time_max.isoformat() + "Z",
            "maxResults": max_results,
            "singleEvents": "true",
            "orderBy": "startTime",
        }

        url = f"{_CALENDAR_API}/calendars/{calendar_id}/events"
        resp = self._client.get(url, headers=self._headers(), params=params)
        resp.raise_for_status()
        return resp.json().get("items", [])

    def list_events_all_calendars(
        self,
        time_min: datetime | None = None,
        time_max: datetime | None = None,
    ) -> dict[str, list[dict[str, Any]]]:
        """List events from all configured calendars. Returns {calendar_id: [events]}."""
        results: dict[str, list[dict[str, Any]]] = {}
        for cal_id in self._calendar_ids:
            try:
                events = self.list_events(cal_id, time_min, time_max)
                results[cal_id] = events
            except Exception as exc:
                log.warning("gcal_list_events_error", extra={
                    "calendar_id": cal_id, "error": str(exc),
                })
                results[cal_id] = []
        return results

    # ── Write (only when write_enabled=True) ──

    @retry(**_RETRY)
    def create_event(
        self,
        calendar_id: str,
        event_body: dict[str, Any],
    ) -> dict[str, Any]:
        """Create a calendar event. Requires write_enabled=True."""
        if not self._write_enabled:
            raise PermissionError("GCal write not enabled (GCAL_WRITE_ENABLED=false)")

        url = f"{_CALENDAR_API}/calendars/{calendar_id}/events"
        resp = self._client.post(url, headers=self._headers(), json=event_body)
        resp.raise_for_status()
        return resp.json()

    @retry(**_RETRY)
    def update_event(
        self,
        calendar_id: str,
        event_id: str,
        event_body: dict[str, Any],
    ) -> dict[str, Any]:
        """Update an existing calendar event. Requires write_enabled=True."""
        if not self._write_enabled:
            raise PermissionError("GCal write not enabled (GCAL_WRITE_ENABLED=false)")

        url = f"{_CALENDAR_API}/calendars/{calendar_id}/events/{event_id}"
        resp = self._client.put(url, headers=self._headers(), json=event_body)
        resp.raise_for_status()
        return resp.json()

    @retry(**_RETRY)
    def delete_event(self, calendar_id: str, event_id: str) -> None:
        """Delete a calendar event. Requires write_enabled=True."""
        if not self._write_enabled:
            raise PermissionError("GCal write not enabled (GCAL_WRITE_ENABLED=false)")

        url = f"{_CALENDAR_API}/calendars/{calendar_id}/events/{event_id}"
        resp = self._client.delete(url, headers=self._headers())
        resp.raise_for_status()


# ── Sync helpers ──


def parse_gcal_event(event: dict[str, Any], calendar_id: str, brand: str) -> dict[str, Any]:
    """Parse a Google Calendar event into schedule_events-compatible dict.

    External key: gcal:<calendar_id>:<event_id>.
    Google Calendar is authoritative for time blocks (meetings/focus).
    """
    start_raw = event.get("start", {})
    end_raw = event.get("end", {})

    all_day = "date" in start_raw and "dateTime" not in start_raw

    if all_day:
        start_str = start_raw["date"] + "T00:00:00+00:00"
        end_str = end_raw.get("date", start_raw["date"]) + "T00:00:00+00:00"
    else:
        start_str = start_raw.get("dateTime", "")
        end_str = end_raw.get("dateTime", "")

    attendees = [
        a.get("email", "")
        for a in event.get("attendees", [])
        if a.get("email")
    ]

    event_type = "meeting"
    summary = event.get("summary", "")
    lower_summary = summary.lower()
    if "focus" in lower_summary or "block" in lower_summary:
        event_type = "focus_block"
    elif "reminder" in lower_summary:
        event_type = "reminder"

    event_id = event.get("id", "")

    return {
        "brand": brand,
        "source": "gcal",
        "external_key": _gcal_external_key(calendar_id, event_id),
        "event_type": event_type,
        "title": summary,
        "start_time": start_str,
        "end_time": end_str,
        "all_day": all_day,
        "location": event.get("location"),
        "attendees": attendees,
        "gcal_event_id": event_id,
        "status": "cancelled" if event.get("status") == "cancelled" else "scheduled",
    }


def sync_gcal_to_schedule(
    provider: GCalProvider,
    repo: ScheduleRepo,
    brand: str,
    *,
    past_days: int = 7,
    future_days: int = 30,
) -> dict[str, Any]:
    """Pull events from all configured calendars into schedule_events.

    Returns summary of sync results per calendar.
    """
    now = datetime.utcnow()
    time_min = now - timedelta(days=past_days)
    time_max = now + timedelta(days=future_days)

    all_events = provider.list_events_all_calendars(time_min, time_max)

    total_synced = 0
    total_errors = 0
    total_removed = 0
    per_calendar: dict[str, dict[str, Any]] = {}

    for cal_id, events in all_events.items():
        synced = 0
        errors = 0
        seen_keys: set[str] = set()

        for raw_event in events:
            parsed = parse_gcal_event(raw_event, cal_id, brand)
            ext_key = parsed["external_key"]
            seen_keys.add(ext_key)

            try:
                start_dt = datetime.fromisoformat(parsed["start_time"])
                end_dt = datetime.fromisoformat(parsed["end_time"]) if parsed["end_time"] else None

                event = ScheduleEvent(
                    brand=brand,
                    source="gcal",
                    external_key=ext_key,
                    event_type=parsed["event_type"],
                    title=parsed["title"],
                    start_time=start_dt,
                    end_time=end_dt,
                    all_day=parsed["all_day"],
                    location=parsed.get("location"),
                    attendees=parsed.get("attendees", []),
                    gcal_event_id=parsed["gcal_event_id"],
                    status=parsed["status"],
                )
                repo.upsert(event)
                synced += 1
            except Exception as exc:
                log.warning("gcal_sync_event_error", extra={
                    "calendar_id": cal_id,
                    "event_id": parsed.get("gcal_event_id"),
                    "error": str(exc),
                })
                errors += 1

        # Remove stale events for this calendar
        removed = _remove_stale_gcal_events(repo, cal_id, seen_keys)

        per_calendar[cal_id] = {
            "synced": synced,
            "errors": errors,
            "removed": removed,
        }
        total_synced += synced
        total_errors += errors
        total_removed += removed

    log.info("gcal_sync_complete", extra={
        "brand": brand,
        "calendars": len(all_events),
        "synced": total_synced,
        "errors": total_errors,
        "removed": total_removed,
    })

    return {
        "ok": total_errors == 0,
        "brand": brand,
        "synced": total_synced,
        "errors": total_errors,
        "removed": total_removed,
        "per_calendar": per_calendar,
    }


def _remove_stale_gcal_events(
    repo: ScheduleRepo,
    calendar_id: str,
    seen_keys: set[str],
) -> int:
    """Soft-delete GCal events that no longer exist in the source calendar."""
    prefix = f"gcal:{calendar_id}:"
    rows = repo.conn.execute(
        "SELECT id, external_key FROM schedule_events WHERE source='gcal' AND external_key LIKE ? AND status != 'cancelled'",
        (f"{prefix}%",),
    ).fetchall()

    removed = 0
    for row in rows:
        if row["external_key"] not in seen_keys:
            repo.conn.execute(
                "UPDATE schedule_events SET status='cancelled', updated_at=datetime('now') WHERE id=?",
                (row["id"],),
            )
            removed += 1
    if removed:
        repo.conn.commit()
    return removed
