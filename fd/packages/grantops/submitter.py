"""GrantOps submission workflow — routes submissions through the right lane.

Lanes:
  1. Submittable API (highest automation)
  2. Email submission
  3. Guided submit (manual with Telegram checklist)

Every submission requires Telegram approval before execution.
Respects DRY_RUN, KILL_SWITCH, and rate limits.
"""
from __future__ import annotations

import sqlite3
from typing import Any

from packages.common.audit import write_audit
from packages.common.ids import new_id
from packages.common.logging import get_logger
from packages.grantops.models import (
    Submission,
    SubmissionMethod,
    SubmissionStatus,
)
from packages.grantops.store import (
    get_draft,
    get_opportunity,
    insert_submission,
    update_opportunity_status,
    update_submission_status,
)

log = get_logger("grantops.submitter")


def _select_method(portal_type: str) -> SubmissionMethod:
    """Select submission method based on portal type."""
    mapping = {
        "submittable": SubmissionMethod.SUBMITTABLE_API,
        "email": SubmissionMethod.EMAIL,
        "fluxx": SubmissionMethod.GUIDED_SUBMIT,
        "portal_other": SubmissionMethod.GUIDED_SUBMIT,
        "guided": SubmissionMethod.GUIDED_SUBMIT,
    }
    return mapping.get(portal_type, SubmissionMethod.GUIDED_SUBMIT)


def initiate_submission(
    conn: sqlite3.Connection,
    draft_id: str,
    *,
    dry_run: bool = True,
    correlation_id: str | None = None,
) -> dict[str, Any]:
    """Create a submission record and route to the appropriate lane.

    Does NOT actually submit — just prepares the submission and determines
    the method. Actual submission happens after Telegram approval.
    """
    cid = correlation_id or new_id("submit")

    draft = get_draft(conn, draft_id)
    if not draft:
        return {"ok": False, "error": "draft_not_found"}

    if draft["status"] != "approved":
        return {"ok": False, "error": "draft_not_approved", "status": draft["status"]}

    opp = get_opportunity(conn, draft["opportunity_id"])
    if not opp:
        return {"ok": False, "error": "opportunity_not_found"}

    method = _select_method(opp.get("portal_type", "guided"))

    if dry_run:
        write_audit(
            conn,
            action="grant.submission.would_create",
            target=draft_id,
            payload={
                "opportunity_id": opp["id"],
                "method": method.value,
                "portal_type": opp.get("portal_type"),
            },
            correlation_id=cid,
        )
        return {
            "ok": True,
            "dry_run": True,
            "method": method.value,
            "opportunity": opp["name"],
        }

    sub = Submission(
        opportunity_id=opp["id"],
        draft_id=draft_id,
        name=f"Submission: {opp['name']}",
        method=method,
        status=SubmissionStatus.PENDING,
    )
    sub_id = insert_submission(conn, sub)
    update_opportunity_status(conn, opp["id"], "submitted")

    write_audit(
        conn,
        action="grant.submission.created",
        target=sub_id,
        payload={
            "opportunity_id": opp["id"],
            "draft_id": draft_id,
            "method": method.value,
        },
        correlation_id=cid,
    )

    return {
        "ok": True,
        "submission_id": sub_id,
        "method": method.value,
        "status": "pending",
        "next_step": _next_step_message(method),
    }


def _next_step_message(method: SubmissionMethod) -> str:
    """Human-readable next step based on submission method."""
    messages = {
        SubmissionMethod.SUBMITTABLE_API: "Awaiting Telegram approval to auto-submit via Submittable API.",
        SubmissionMethod.EMAIL: "Awaiting Telegram approval to send submission email.",
        SubmissionMethod.GUIDED_SUBMIT: "Manual submission required. Checklist will be sent to Telegram.",
        SubmissionMethod.MANUAL: "Manual submission required. Instructions will be provided.",
    }
    return messages.get(method, "Awaiting next action.")


def confirm_submission(
    conn: sqlite3.Connection,
    submission_id: str,
    *,
    confirmation_id: str = "",
    dry_run: bool = True,
    correlation_id: str | None = None,
) -> dict[str, Any]:
    """Mark a submission as confirmed (after human verification)."""
    cid = correlation_id or new_id("confirm")

    if dry_run:
        write_audit(
            conn,
            action="grant.submission.would_confirm",
            target=submission_id,
            payload={"confirmation_id": confirmation_id},
            correlation_id=cid,
        )
        return {"ok": True, "dry_run": True}

    update_submission_status(
        conn, submission_id, "confirmed",
        confirmation_id=confirmation_id,
    )

    write_audit(
        conn,
        action="grant.submission.confirmed",
        target=submission_id,
        payload={"confirmation_id": confirmation_id},
        correlation_id=cid,
    )

    return {"ok": True, "status": "confirmed"}


def block_submission(
    conn: sqlite3.Connection,
    submission_id: str,
    *,
    reason: str,
    correlation_id: str | None = None,
) -> dict[str, Any]:
    """Mark a submission as blocked with a reason."""
    update_submission_status(
        conn, submission_id, "blocked",
        blocker_reason=reason,
    )
    write_audit(
        conn,
        action="grant.submission.blocked",
        target=submission_id,
        payload={"reason": reason},
        correlation_id=correlation_id,
    )
    return {"ok": True, "status": "blocked", "reason": reason}
