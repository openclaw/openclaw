"""GrantOps SQLite store — CRUD for opportunities, drafts, and submissions.

Follows existing OpenClaw patterns:
- sqlite3.Row for dict-like access
- content_hash for Notion mirror drift detection
- Idempotent upserts via external_id
"""
from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime
from typing import Any, Optional

from packages.grantops.models import (
    Draft,
    DraftStatus,
    Opportunity,
    OpportunityStatus,
    Submission,
    SubmissionOutcome,
    SubmissionStatus,
)


def _now() -> str:
    return datetime.now(tz=UTC).isoformat()


# ── Opportunities ──


def upsert_opportunity(conn: sqlite3.Connection, opp: Opportunity) -> str:
    """Insert or update an opportunity. Dedupe on external_id."""
    opp.updated_at = _now()
    conn.execute(
        """INSERT INTO grant_opportunities
           (id, external_id, name, funder, deadline, amount_min_usd, amount_max_usd,
            fit_score, effort_score, priority, status, portal_type, portal_url,
            source, brand, tags_json, raw_data_json, discovered_at, updated_at, content_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(external_id) DO UPDATE SET
            name=excluded.name, funder=excluded.funder, deadline=excluded.deadline,
            amount_min_usd=excluded.amount_min_usd, amount_max_usd=excluded.amount_max_usd,
            fit_score=excluded.fit_score, effort_score=excluded.effort_score,
            priority=excluded.priority, status=excluded.status,
            portal_type=excluded.portal_type, portal_url=excluded.portal_url,
            tags_json=excluded.tags_json, raw_data_json=excluded.raw_data_json,
            updated_at=excluded.updated_at, content_hash=excluded.content_hash""",
        (
            opp.id, opp.external_id, opp.name, opp.funder, opp.deadline,
            opp.amount_min_usd, opp.amount_max_usd, opp.fit_score, opp.effort_score,
            opp.priority.value, opp.status.value, opp.portal_type.value, opp.portal_url,
            opp.source.value, opp.brand, json.dumps(opp.tags),
            json.dumps(opp.raw_data), opp.discovered_at, opp.updated_at, opp.content_hash,
        ),
    )
    conn.commit()
    return opp.id


def get_opportunity(conn: sqlite3.Connection, opp_id: str) -> Optional[dict[str, Any]]:
    row = conn.execute("SELECT * FROM grant_opportunities WHERE id = ?", (opp_id,)).fetchone()
    return dict(row) if row else None


def get_opportunity_by_external_id(conn: sqlite3.Connection, external_id: str) -> Optional[dict[str, Any]]:
    row = conn.execute("SELECT * FROM grant_opportunities WHERE external_id = ?", (external_id,)).fetchone()
    return dict(row) if row else None


def list_opportunities(
    conn: sqlite3.Connection,
    *,
    status: Optional[str] = None,
    min_fit_score: Optional[float] = None,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """List opportunities with optional filters."""
    clauses = []
    params: list[Any] = []

    if status:
        clauses.append("status = ?")
        params.append(status)
    if min_fit_score is not None:
        clauses.append("fit_score >= ?")
        params.append(min_fit_score)

    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    rows = conn.execute(
        f"SELECT * FROM grant_opportunities {where} ORDER BY fit_score DESC, deadline ASC LIMIT ?",
        params + [limit],
    ).fetchall()
    return [dict(r) for r in rows]


def list_new_today(conn: sqlite3.Connection, *, limit: int = 10) -> list[dict[str, Any]]:
    """Opportunities discovered today."""
    today = datetime.now(tz=UTC).strftime("%Y-%m-%d")
    rows = conn.execute(
        "SELECT * FROM grant_opportunities WHERE discovered_at >= ? ORDER BY fit_score DESC LIMIT ?",
        (today, limit),
    ).fetchall()
    return [dict(r) for r in rows]


def update_opportunity_status(conn: sqlite3.Connection, opp_id: str, status: str) -> None:
    conn.execute(
        "UPDATE grant_opportunities SET status = ?, updated_at = ? WHERE id = ?",
        (status, _now(), opp_id),
    )
    conn.commit()


# ── Drafts ──


def insert_draft(conn: sqlite3.Connection, draft: Draft) -> str:
    draft.updated_at = _now()
    conn.execute(
        """INSERT INTO grant_drafts
           (id, opportunity_id, name, status, narrative, budget_json, timeline_json,
            attachments_ready, reviewer, review_notes, manifest_json,
            vault_snapshot_id, created_at, updated_at, content_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            draft.id, draft.opportunity_id, draft.name, draft.status.value,
            draft.narrative, json.dumps(draft.budget), json.dumps(draft.timeline),
            int(draft.attachments_ready), draft.reviewer, draft.review_notes,
            json.dumps(draft.manifest), draft.vault_snapshot_id,
            draft.created_at, draft.updated_at, draft.content_hash,
        ),
    )
    conn.commit()
    return draft.id


def get_draft(conn: sqlite3.Connection, draft_id: str) -> Optional[dict[str, Any]]:
    row = conn.execute("SELECT * FROM grant_drafts WHERE id = ?", (draft_id,)).fetchone()
    return dict(row) if row else None


def list_drafts(
    conn: sqlite3.Connection,
    *,
    status: Optional[str] = None,
    opportunity_id: Optional[str] = None,
    limit: int = 50,
) -> list[dict[str, Any]]:
    clauses = []
    params: list[Any] = []
    if status:
        clauses.append("status = ?")
        params.append(status)
    if opportunity_id:
        clauses.append("opportunity_id = ?")
        params.append(opportunity_id)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    rows = conn.execute(
        f"SELECT * FROM grant_drafts {where} ORDER BY updated_at DESC LIMIT ?",
        params + [limit],
    ).fetchall()
    return [dict(r) for r in rows]


def update_draft_status(conn: sqlite3.Connection, draft_id: str, status: str, *, review_notes: str = "") -> None:
    params: list[Any] = [status, _now()]
    extra = ""
    if review_notes:
        extra = ", review_notes = ?"
        params.append(review_notes)
    params.append(draft_id)
    conn.execute(f"UPDATE grant_drafts SET status = ?, updated_at = ?{extra} WHERE id = ?", params)
    conn.commit()


# ── Submissions ──


def insert_submission(conn: sqlite3.Connection, sub: Submission) -> str:
    sub.updated_at = _now()
    conn.execute(
        """INSERT INTO grant_submissions
           (id, opportunity_id, draft_id, name, method, status, submitted_at,
            confirmation_id, blocker_reason, follow_up_date, outcome,
            award_amount_usd, notes, created_at, updated_at, content_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            sub.id, sub.opportunity_id, sub.draft_id, sub.name,
            sub.method.value, sub.status.value, sub.submitted_at,
            sub.confirmation_id, sub.blocker_reason, sub.follow_up_date,
            sub.outcome.value, sub.award_amount_usd, sub.notes,
            sub.created_at, sub.updated_at, sub.content_hash,
        ),
    )
    conn.commit()
    return sub.id


def get_submission(conn: sqlite3.Connection, sub_id: str) -> Optional[dict[str, Any]]:
    row = conn.execute("SELECT * FROM grant_submissions WHERE id = ?", (sub_id,)).fetchone()
    return dict(row) if row else None


def list_submissions(
    conn: sqlite3.Connection,
    *,
    status: Optional[str] = None,
    outcome: Optional[str] = None,
    limit: int = 50,
) -> list[dict[str, Any]]:
    clauses = []
    params: list[Any] = []
    if status:
        clauses.append("status = ?")
        params.append(status)
    if outcome:
        clauses.append("outcome = ?")
        params.append(outcome)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    rows = conn.execute(
        f"SELECT * FROM grant_submissions {where} ORDER BY updated_at DESC LIMIT ?",
        params + [limit],
    ).fetchall()
    return [dict(r) for r in rows]


def list_action_needed(conn: sqlite3.Connection, *, limit: int = 20) -> list[dict[str, Any]]:
    """Submissions that need human attention."""
    rows = conn.execute(
        """SELECT s.*, o.name AS opp_name, o.funder, o.deadline
           FROM grant_submissions s
           JOIN grant_opportunities o ON o.id = s.opportunity_id
           WHERE s.status IN ('blocked', 'needs_resubmit')
              OR (s.follow_up_date IS NOT NULL AND s.follow_up_date <= date('now', '+3 days')
                  AND s.outcome = 'pending')
           ORDER BY s.follow_up_date ASC
           LIMIT ?""",
        (limit,),
    ).fetchall()
    return [dict(r) for r in rows]


def update_submission_status(
    conn: sqlite3.Connection,
    sub_id: str,
    status: str,
    *,
    confirmation_id: str = "",
    blocker_reason: str = "",
) -> None:
    conn.execute(
        """UPDATE grant_submissions
           SET status = ?, confirmation_id = COALESCE(NULLIF(?, ''), confirmation_id),
               blocker_reason = COALESCE(NULLIF(?, ''), blocker_reason),
               updated_at = ?
           WHERE id = ?""",
        (status, confirmation_id, blocker_reason, _now(), sub_id),
    )
    conn.commit()


def update_submission_outcome(
    conn: sqlite3.Connection,
    sub_id: str,
    outcome: str,
    *,
    award_amount_usd: Optional[float] = None,
) -> None:
    conn.execute(
        "UPDATE grant_submissions SET outcome = ?, award_amount_usd = ?, updated_at = ? WHERE id = ?",
        (outcome, award_amount_usd, _now(), sub_id),
    )
    conn.commit()


# ── Summary Stats ──


def get_summary_stats(conn: sqlite3.Connection) -> dict[str, Any]:
    """Dashboard summary numbers."""
    today = datetime.now(tz=UTC).strftime("%Y-%m-%d")

    new_today = conn.execute(
        "SELECT COUNT(*) FROM grant_opportunities WHERE discovered_at >= ?", (today,)
    ).fetchone()[0]

    high_fit = conn.execute(
        "SELECT COUNT(*) FROM grant_opportunities WHERE fit_score >= 0.7 AND status IN ('new', 'evaluating')"
    ).fetchone()[0]

    drafts_review = conn.execute(
        "SELECT COUNT(*) FROM grant_drafts WHERE status = 'review'"
    ).fetchone()[0]

    subs_pending = conn.execute(
        "SELECT COUNT(*) FROM grant_submissions WHERE status IN ('pending', 'blocked', 'needs_resubmit')"
    ).fetchone()[0]

    next_followup = conn.execute(
        "SELECT MIN(follow_up_date) FROM grant_submissions WHERE follow_up_date IS NOT NULL AND outcome = 'pending'"
    ).fetchone()[0]

    won_total = conn.execute(
        "SELECT COALESCE(SUM(award_amount_usd), 0) FROM grant_submissions WHERE outcome = 'awarded'"
    ).fetchone()[0]

    return {
        "new_today": new_today,
        "high_fit": high_fit,
        "drafts_in_review": drafts_review,
        "submissions_pending": subs_pending,
        "next_follow_up": next_followup,
        "total_awarded_usd": won_total,
    }
