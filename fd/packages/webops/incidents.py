"""WebOps incident lifecycle — upsert and close incidents in SQLite.

Each incident is keyed by a stable fingerprint (site_key + tool + check + reason).
On each run:
- New fingerprints → INSERT (open, severity)
- Existing fingerprints → UPDATE (bump occurrences, refresh last_seen)
- Missing fingerprints → CLOSE (mark resolved)
"""
from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime
from typing import Any


def _utc_now() -> str:
    return datetime.now(tz=UTC).isoformat()


def upsert_incidents(
    conn: sqlite3.Connection,
    incidents: list[dict[str, Any]],
) -> dict[str, int]:
    """Upsert incidents by fingerprint. Returns {created, updated}."""
    cur = conn.cursor()
    now = _utc_now()
    created = 0
    updated = 0

    for inc in incidents:
        fp = inc["fingerprint"]
        site_key = inc["site_key"]
        sev = inc["severity"]
        title = f"{inc['title']} ({inc['reason']})"
        details = inc.get("details", {})

        cur.execute(
            "SELECT id, occurrences FROM webops_incidents WHERE fingerprint = ?",
            (fp,),
        )
        row = cur.fetchone()
        if not row:
            cur.execute(
                "INSERT INTO webops_incidents "
                "(site_key, status, severity, title, fingerprint, first_seen_utc, "
                "last_seen_utc, occurrences, last_details_json) "
                "VALUES (?,?,?,?,?,?,?,?,?)",
                (site_key, "open", sev, title, fp, now, now, 1, json.dumps(details, default=str)),
            )
            created += 1
        else:
            inc_id, occ = row
            cur.execute(
                "UPDATE webops_incidents "
                "SET status='open', severity=?, title=?, last_seen_utc=?, "
                "occurrences=?, last_details_json=?, resolved_at_utc=NULL "
                "WHERE id=?",
                (sev, title, now, int(occ) + 1, json.dumps(details, default=str), inc_id),
            )
            updated += 1

    conn.commit()
    return {"created": created, "updated": updated}


def close_missing_incidents(
    conn: sqlite3.Connection,
    *,
    open_fingerprints: list[str],
) -> int:
    """Close any open incident whose fingerprint is NOT in current run."""
    cur = conn.cursor()
    now = _utc_now()

    if open_fingerprints:
        placeholders = ",".join(["?"] * len(open_fingerprints))
        cur.execute(
            f"UPDATE webops_incidents SET status='closed', resolved_at_utc=? "  # noqa: S608
            f"WHERE status='open' AND fingerprint NOT IN ({placeholders})",
            (now, *open_fingerprints),
        )
    else:
        cur.execute(
            "UPDATE webops_incidents SET status='closed', resolved_at_utc=? "
            "WHERE status='open'",
            (now,),
        )

    closed = cur.rowcount
    conn.commit()
    return int(closed)


def get_open_incidents(
    conn: sqlite3.Connection,
    *,
    limit: int = 200,
) -> list[dict[str, Any]]:
    """Return open incidents sorted by severity (red first) then last_seen."""
    cur = conn.cursor()
    cur.execute(
        "SELECT site_key, severity, title, fingerprint, first_seen_utc, "
        "last_seen_utc, occurrences, notion_page_id "
        "FROM webops_incidents WHERE status='open' "
        "ORDER BY severity DESC, last_seen_utc DESC LIMIT ?",
        (limit,),
    )
    out: list[dict[str, Any]] = []
    for row in cur.fetchall():
        site_key, severity, title, fp, first_seen, last_seen, occ, notion_page_id = row
        out.append({
            "site_key": site_key,
            "severity": severity,
            "title": title,
            "fingerprint": fp,
            "first_seen_utc": first_seen,
            "last_seen_utc": last_seen,
            "occurrences": occ,
            "notion_page_id": notion_page_id,
        })
    return out
