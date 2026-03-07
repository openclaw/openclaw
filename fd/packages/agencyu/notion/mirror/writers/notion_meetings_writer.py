"""Mirror writer for Meetings database.

Source: GHL appointments + Calendly invitees (optional).
Target: Notion Meetings DB.

Identity: external_key = "ghl_appt:<id>" or "cal:<invitee_uuid>"

GHL is primary for status/showed; Calendly fills optional gaps.
"""
from __future__ import annotations

from typing import Any

from packages.agencyu.notion.audit_writer import AuditWriter
from packages.agencyu.notion.mirror.identity_map import IdentityMapStore
from packages.agencyu.notion.notion_api import NotionAPI
from packages.common.logging import get_logger

log = get_logger("agencyu.notion.mirror.writers.meetings")


def _rt(text: str) -> list[dict[str, Any]]:
    return [{"type": "text", "text": {"content": text}}]


class NotionMeetingsWriter:
    """Mirrors meetings into Notion for visibility.

    Source-of-truth remains:
      - GHL appointments for status/showed
      - Calendly for invitee UUIDs (optional)

    external_key format:
      - ghl_appt:<id>
      - cal:<invitee_uuid>
    """

    writer_name = "meetings"

    def __init__(
        self,
        notion: NotionAPI,
        audit: AuditWriter,
        ids: IdentityMapStore,
        meetings_db_id: str = "",
    ) -> None:
        self.notion = notion
        self.audit = audit
        self.ids = ids
        self.meetings_db_id = meetings_db_id

    def mirror(
        self,
        sources: dict[str, Any],
        correlation_id: str,
        *,
        safe_mode: bool = True,
        max_writes: int = 200,
    ) -> dict[str, Any]:
        """Mirror meetings from GHL + optional Calendly sources."""
        writes = 0
        warnings: list[str] = []

        if not self.meetings_db_id:
            return {"writes": 0, "warnings": ["no meetings_db_id configured"]}

        ghl = sources.get("ghl")
        calendly = sources.get("calendly")

        # A) GHL appointments
        if ghl:
            appointments = ghl.iter_appointments(limit=max_writes) if hasattr(ghl, "iter_appointments") else []
            for appt in appointments:
                if writes >= max_writes:
                    break

                ghl_appt_id = str(appt.get("id") or "")
                if not ghl_appt_id:
                    continue

                ghl_contact_id = appt.get("contact_id")
                client_key = self.ids.resolve_chain(ghl_contact_id=ghl_contact_id) if ghl_contact_id else None

                if not client_key:
                    warnings.append(
                        f"meeting missing client_key: ghl_appt_id={ghl_appt_id}, ghl_contact_id={ghl_contact_id}"
                    )

                ext_key = f"ghl_appt:{ghl_appt_id}"
                row = self._find_by_external_key(ext_key)

                if not row:
                    if safe_mode:
                        continue
                    self._create_meeting_row(ext_key, client_key, appt)
                    writes += 1
                    self.audit.write_event(
                        action="notion.meetings.create",
                        target_type="notion_page",
                        target_id="(new)",
                        details={"correlation_id": correlation_id, "external_key": ext_key},
                    )
                else:
                    payload = self._update_payload(appt)
                    if payload and not safe_mode:
                        self.notion.update_page(row["id"], {"properties": payload})
                        writes += 1
                        self.audit.write_event(
                            action="notion.meetings.update",
                            target_type="notion_page",
                            target_id=row["id"],
                            details={"correlation_id": correlation_id, "external_key": ext_key},
                        )

                # Upsert appointment_key normalization
                appointment_key = appt.get("appointment_key") or appt.get("id")
                if client_key and appointment_key and ghl_contact_id:
                    self.ids.upsert_mapping(
                        domain="meeting",
                        external_id=ext_key,
                        ghl_contact_id=ghl_contact_id,
                    )

        # B) Calendly invitees (optional mirror)
        if calendly:
            cal_limit = max(50, max_writes // 4)
            invitees = calendly.iter_invitees(limit=cal_limit) if hasattr(calendly, "iter_invitees") else []
            for inv in invitees:
                if writes >= max_writes:
                    break
                inv_uuid = inv.get("invitee_uuid")
                if not inv_uuid:
                    continue
                ext_key = f"cal:{inv_uuid}"
                row = self._find_by_external_key(ext_key)
                if row:
                    continue
                if safe_mode:
                    continue
                self._create_calendly_row(ext_key, inv)
                writes += 1

        return {"writes": writes, "warnings": warnings}

    def _find_by_external_key(self, external_key: str) -> dict[str, Any] | None:
        resp = self.notion.query_database(
            self.meetings_db_id,
            filter_obj={"property": "external_key", "rich_text": {"equals": external_key}},
            page_size=1,
        )
        res = resp.get("results", [])
        return res[0] if res else None

    def _create_meeting_row(
        self, ext_key: str, client_key: str | None, appt: dict[str, Any]
    ) -> None:
        title = appt.get("title") or appt.get("meeting_type") or "Meeting"
        props: dict[str, Any] = {
            "Meeting": {"title": _rt(title)},
            "external_key": {"rich_text": _rt(ext_key)},
        }
        if client_key:
            props["appointment_key"] = {
                "rich_text": _rt(str(appt.get("appointment_key") or appt.get("id") or ""))
            }
        if appt.get("start_time"):
            props["Date/Time"] = {"date": {"start": appt["start_time"]}}
        if appt.get("setter_id"):
            props["setter_id"] = {"rich_text": _rt(str(appt["setter_id"]))}
        if appt.get("showed") is not None:
            props["Showed"] = {"checkbox": bool(appt["showed"])}

        self.notion.create_page(
            {"type": "database_id", "database_id": self.meetings_db_id}, props
        )

    def _update_payload(self, appt: dict[str, Any]) -> dict[str, Any]:
        props: dict[str, Any] = {}
        if appt.get("start_time"):
            props["Date/Time"] = {"date": {"start": appt["start_time"]}}
        if appt.get("setter_id"):
            props["setter_id"] = {"rich_text": _rt(str(appt["setter_id"]))}
        if appt.get("showed") is not None:
            props["Showed"] = {"checkbox": bool(appt["showed"])}
        return props

    def _create_calendly_row(self, ext_key: str, inv: dict[str, Any]) -> None:
        title = inv.get("event_type_name") or "Calendly Meeting"
        props: dict[str, Any] = {
            "Meeting": {"title": _rt(title)},
            "external_key": {"rich_text": _rt(ext_key)},
        }
        if inv.get("start_time"):
            props["Date/Time"] = {"date": {"start": inv["start_time"]}}
        if inv.get("appointment_key"):
            props["appointment_key"] = {"rich_text": _rt(str(inv["appointment_key"]))}
        if inv.get("showed") is not None:
            props["Showed"] = {"checkbox": bool(inv["showed"])}
        self.notion.create_page(
            {"type": "database_id", "database_id": self.meetings_db_id}, props
        )
