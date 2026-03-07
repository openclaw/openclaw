from __future__ import annotations

import json
import sqlite3
import time
from typing import Any

from packages.common.audit import write_audit
from packages.common.config import settings
from packages.common.ids import new_id
from packages.domain.assignment import create_assignment, pick_member_round_robin
from packages.domain.contact_map import upsert_contact_board_map
from packages.domain.timeline import log_timeline_event
from packages.domain.trello_webhook_registry import insert_webhook
from packages.integrations.ghl.client import GHLClient
from packages.integrations.trello.client import TrelloClient


def create_fulfillment_job(
    conn: sqlite3.Connection,
    *,
    brand: str,
    correlation_id: str | None,
    ghl_contact_id: str | None,
    customer_email: str | None,
    offer_key: str,
    metadata: dict[str, Any],
) -> dict[str, Any]:
    """
    Create a fulfillment job and (optionally) create a Trello board + lists + starter cards.
    In DRY_RUN, logs + persists the job record with status='dry_run_logged'.
    """
    job_id = new_id("fulfill")

    if settings.DRY_RUN:
        write_audit(
            conn,
            action="trello.fulfillment.create(dry_run)",
            target="trello",
            payload={
                "brand": brand,
                "ghl_contact_id": ghl_contact_id,
                "customer_email": customer_email,
                "offer_key": offer_key,
                "lists": TrelloClient().standard_lists(),
                "metadata": metadata,
            },
            correlation_id=correlation_id,
        )

        conn.execute(
            """
            INSERT INTO fulfillment_jobs
            (job_id, ts, brand, correlation_id, ghl_contact_id, customer_email, offer_key, trello_board_id, status, metadata_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                job_id,
                int(time.time()),
                brand,
                correlation_id,
                ghl_contact_id,
                customer_email,
                offer_key,
                None,
                "dry_run_logged",
                json.dumps(metadata, ensure_ascii=False),
            ),
        )
        conn.commit()

        return {"job_id": job_id, "status": "dry_run_logged", "trello_board_id": None}

    # Live mode
    tc = TrelloClient()
    board_name = metadata.get("trello_board_name") or f"{customer_email or ghl_contact_id or 'Client'} - Full Digital Project"
    board = tc.create_board(name=board_name, id_organization=settings.TRELLO_WORKSPACE_ID)
    board_id = str(board.get("id"))

    log_timeline_event(
        conn,
        trello_board_id=board_id,
        event_type="board_created",
        event_key=correlation_id or board_id,
        title="Board Created",
        human_fields={
            "Brand": brand,
            "Offer Key": offer_key,
            "Customer Email": customer_email,
            "GHL Contact ID": ghl_contact_id,
        },
        machine_fields={
            "brand": brand,
            "offer_key": offer_key,
            "customer_email": customer_email,
            "ghl_contact_id": ghl_contact_id,
        },
        correlation_id=correlation_id,
        primary_card_id=None,
    )

    # Auto-create Trello webhook for this board
    trello_webhook_id = None
    callback_url = ""
    if settings.TRELLO_AUTO_WEBHOOK_ENABLED:
        if not settings.PUBLIC_BASE_URL:
            write_audit(
                conn,
                action="trello.webhook.create.skipped_missing_public_base_url",
                target="trello",
                payload={"board_id": board_id},
                correlation_id=correlation_id,
            )
        elif not settings.TRELLO_WEBHOOK_SECRET:
            write_audit(
                conn,
                action="trello.webhook.create.skipped_missing_secret",
                target="trello",
                payload={"board_id": board_id},
                correlation_id=correlation_id,
            )
        else:
            callback_url = f"{settings.PUBLIC_BASE_URL.rstrip('/')}/webhooks/trello?secret={settings.TRELLO_WEBHOOK_SECRET}"
            if settings.DRY_RUN:
                write_audit(
                    conn,
                    action="trello.webhook.create(dry_run)",
                    target="trello",
                    payload={"board_id": board_id, "callback_url": callback_url},
                    correlation_id=correlation_id,
                )
            else:
                wh = tc.create_webhook(
                    board_id=board_id,
                    callback_url=callback_url,
                    description=f"OpenClaw Sync webhook for board {board_id}",
                )
                trello_webhook_id = str(wh.get("id"))
                insert_webhook(
                    conn,
                    trello_webhook_id=trello_webhook_id,
                    trello_board_id=board_id,
                    callback_url=callback_url,
                    correlation_id=correlation_id,
                )
                write_audit(
                    conn,
                    action="trello.webhook.created",
                    target="trello",
                    payload={"board_id": board_id, "trello_webhook_id": trello_webhook_id, "callback_url": callback_url},
                    correlation_id=correlation_id,
                )
                log_timeline_event(
                    conn,
                    trello_board_id=board_id,
                    event_type="trello_webhook_created",
                    event_key=trello_webhook_id,
                    title="Trello Webhook Created",
                    human_fields={
                        "Webhook ID": trello_webhook_id,
                        "Callback URL": callback_url,
                    },
                    machine_fields={
                        "trello_webhook_id": trello_webhook_id,
                        "callback_url": callback_url,
                    },
                    correlation_id=correlation_id,
                )

    # Create standard lists
    list_ids: dict[str, str] = {}
    for list_name in tc.standard_lists():
        lst = tc.create_list(board_id=board_id, name=list_name)
        list_ids[list_name] = str(lst.get("id"))

    # Create starter cards
    tc.create_card(list_id=list_ids["Requests"], name="Client Intake / Required Details")
    prod_card = tc.create_card(list_id=list_ids["In Progress"], name="Production Task(s)")
    primary_card_id = str(prod_card.get("id"))

    # Default Reference & Links cards
    ref_list_id = list_ids["Reference & Links"]
    for ref_name in [
        "Welcome / Onboarding",
        "Dropbox Folder",
        "Brand Guidelines",
        "Logos / Fonts",
        "Release Dates",
        "Deadlines",
    ]:
        tc.create_card(list_id=ref_list_id, name=ref_name)

    log_timeline_event(
        conn,
        trello_board_id=board_id,
        event_type="primary_card_created",
        event_key=primary_card_id,
        title="Primary Card Created",
        human_fields={"Primary Card ID": primary_card_id},
        machine_fields={"primary_card_id": primary_card_id},
        correlation_id=correlation_id,
        primary_card_id=primary_card_id,
    )

    # Auto-assign designer (local DB truth, zero Trello seats required)
    role = "designer_motion" if metadata.get("needs_motion") else "designer_static"
    member = pick_member_round_robin(conn, role=role)

    if member:
        assignment_id = create_assignment(
            conn,
            trello_board_id=board_id,
            card_id=primary_card_id,
            member_id=member["member_id"],
            reason="auto_round_robin",
            correlation_id=correlation_id,
        )

        # Mirror to Trello via label (free, no seats needed)
        if settings.ASSIGNMENT_MIRROR_TO_TRELLO_LABEL:
            label_name = f"{settings.ASSIGNMENT_LABEL_PREFIX} {member['display_name']}"
            label_id = None
            labels = tc.get_labels(board_id=board_id)
            for lbl in labels:
                if str(lbl.get("name") or "") == label_name:
                    label_id = str(lbl.get("id"))
                    break
            if not label_id:
                created_lbl = tc.create_label(board_id=board_id, name=label_name, color="blue")
                label_id = str(created_lbl.get("id"))
            tc.add_label_to_card(card_id=primary_card_id, label_id=label_id)

        # Optional: prefix card title
        if settings.ASSIGNMENT_PREFIX_CARD_TITLE:
            tc.update_card_name(
                card_id=primary_card_id,
                name=f"[{member['display_name']}] Production Task(s)",
            )

        # Timeline event
        if settings.ASSIGNMENT_MIRROR_TO_TIMELINE:
            log_timeline_event(
                conn,
                trello_board_id=board_id,
                primary_card_id=primary_card_id,
                event_type="designer_assigned",
                event_key=assignment_id,
                title="Designer Assigned",
                human_fields={
                    "Assigned To": member["display_name"],
                    "Role": role,
                    "Reason": "auto_round_robin",
                    "Assignment ID": assignment_id,
                },
                machine_fields={
                    "assignment_id": assignment_id,
                    "member_id": member["member_id"],
                    "display_name": member["display_name"],
                    "role": role,
                    "reason": "auto_round_robin",
                },
                correlation_id=correlation_id,
            )
    else:
        # Timeline note: no member available
        if settings.ASSIGNMENT_MIRROR_TO_TIMELINE:
            log_timeline_event(
                conn,
                trello_board_id=board_id,
                primary_card_id=primary_card_id,
                event_type="designer_assignment_skipped",
                event_key=correlation_id or board_id,
                title="Designer Assignment Skipped",
                human_fields={"Reason": "No active team members for role", "Role": role},
                machine_fields={"role": role, "skipped_reason": "no_active_members"},
                correlation_id=correlation_id,
            )

    write_audit(
        conn,
        action="trello.fulfillment.created",
        target="trello",
        payload={"board_id": board_id, "board_name": board_name, "list_ids": list_ids, "primary_card_id": primary_card_id},
        correlation_id=correlation_id,
    )

    # Local index: contact -> board (fast resolution without calling GHL)
    if ghl_contact_id:
        upsert_contact_board_map(
            conn,
            ghl_contact_id=str(ghl_contact_id),
            trello_board_id=board_id,
            primary_card_id=primary_card_id,
            correlation_id=correlation_id,
        )
        write_audit(
            conn,
            action="contact_board_map.upserted",
            target="localdb",
            payload={"ghl_contact_id": ghl_contact_id, "trello_board_id": board_id, "primary_card_id": primary_card_id},
            correlation_id=correlation_id,
        )

    # Persist Trello IDs back into GHL custom fields (so GHL->Trello sync can resolve board_id later)
    if ghl_contact_id:
        custom_fields = {
            settings.GHL_CUSTOM_FIELD_TRELLO_BOARD_ID_KEY: board_id,
            settings.GHL_CUSTOM_FIELD_TRELLO_PRIMARY_CARD_ID_KEY: primary_card_id,
        }

        ghl = GHLClient()
        resp = ghl.update_contact_custom_fields(str(ghl_contact_id), custom_fields)
        write_audit(
            conn,
            action="ghl.update_contact_custom_fields",
            target="gohighlevel",
            payload={"ghl_contact_id": ghl_contact_id, "response": resp, "custom_fields": custom_fields},
            correlation_id=correlation_id,
        )
    else:
        write_audit(
            conn,
            action="ghl.update_contact_custom_fields.skipped_missing_contact_id",
            target="gohighlevel",
            payload={"board_id": board_id, "primary_card_id": primary_card_id},
            correlation_id=correlation_id,
        )

    conn.execute(
        """
        INSERT INTO fulfillment_jobs
        (job_id, ts, brand, correlation_id, ghl_contact_id, customer_email, offer_key, trello_board_id, status, metadata_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            job_id,
            int(time.time()),
            brand,
            correlation_id,
            ghl_contact_id,
            customer_email,
            offer_key,
            board_id,
            "created",
            json.dumps(
                {**metadata, "list_ids": list_ids, "primary_card_id": primary_card_id, "trello_webhook_id": trello_webhook_id, "trello_webhook_callback_url": callback_url},
                ensure_ascii=False,
            ),
        ),
    )
    conn.commit()

    return {"job_id": job_id, "status": "created", "trello_board_id": board_id}
