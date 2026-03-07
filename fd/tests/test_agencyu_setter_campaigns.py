from __future__ import annotations

import sqlite3

from packages.agencyu.campaigns.authority import (
    attach_lead_to_campaign,
    create_authority_campaign,
    get_campaign_report,
)
from packages.agencyu.campaigns.momentum import (
    create_momentum_campaign,
    stop_momentum_campaign,
)
from packages.agencyu.setter_os.metrics import (
    get_setter_daily_metrics,
    upsert_setter_daily_metrics,
)
from packages.agencyu.setter_os.touches import get_lead_touches, log_lead_touch
from packages.common.db import init_schema


def _mem_db() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    init_schema(conn)
    return conn


# ── Campaign tests ──


def test_create_authority_campaign():
    conn = _mem_db()
    cid = create_authority_campaign(conn, utm_campaign="jan_blueprint", notes="test")
    assert cid.startswith("camp_")

    report = get_campaign_report(conn, campaign_id=cid)
    assert report["type"] == "authority"
    assert report["utm_campaign"] == "jan_blueprint"
    assert report["contacts"] == 0


def test_create_momentum_campaign():
    conn = _mem_db()
    cid = create_momentum_campaign(conn, utm_campaign="warm_q1")
    assert cid.startswith("camp_")


def test_stop_momentum_dry_run():
    conn = _mem_db()
    result = stop_momentum_campaign(conn, campaign_id="camp_fake")
    assert result["action"] == "would_stop_momentum_campaign"


def test_campaign_report_not_found():
    conn = _mem_db()
    result = get_campaign_report(conn, campaign_id="nonexistent")
    assert result.get("error") == "campaign_not_found"


def test_attach_lead_to_campaign():
    conn = _mem_db()
    # Insert a lead first
    conn.execute(
        """INSERT INTO agencyu_leads
           (id, created_at, updated_at, stage) VALUES (?, ?, ?, ?)""",
        ("lead_001", "2026-01-01", "2026-01-01", "qualified"),
    )
    conn.commit()

    cid = create_authority_campaign(conn, utm_campaign="test_camp")
    cc_id = attach_lead_to_campaign(conn, campaign_id=cid, lead_id="lead_001")
    assert cc_id.startswith("cc_")

    report = get_campaign_report(conn, campaign_id=cid)
    assert report["contacts"] == 1


# ── Setter metrics tests ──


def test_upsert_setter_daily_metrics():
    conn = _mem_db()
    row_id = upsert_setter_daily_metrics(
        conn, date="2026-03-04", setter_id="setter_01",
        metrics={"dms_sent": 25, "convos_started": 8, "followups_sent": 12, "booked_calls": 3},
    )
    assert row_id.startswith("sdm_")

    result = get_setter_daily_metrics(conn, setter_id="setter_01", date="2026-03-04")
    assert result is not None
    assert result["dms_sent"] == 25
    assert result["booked_calls"] == 3


def test_upsert_setter_metrics_idempotent():
    conn = _mem_db()
    upsert_setter_daily_metrics(
        conn, date="2026-03-04", setter_id="setter_01",
        metrics={"dms_sent": 10},
    )
    upsert_setter_daily_metrics(
        conn, date="2026-03-04", setter_id="setter_01",
        metrics={"dms_sent": 20},
    )
    result = get_setter_daily_metrics(conn, setter_id="setter_01", date="2026-03-04")
    assert result["dms_sent"] == 20  # upserted, not duplicated


def test_get_setter_metrics_not_found():
    conn = _mem_db()
    result = get_setter_daily_metrics(conn, setter_id="unknown", date="2026-01-01")
    assert result is None


# ── Touch log tests ──


def test_log_lead_touch():
    conn = _mem_db()
    # Insert lead first
    conn.execute(
        """INSERT INTO agencyu_leads
           (id, created_at, updated_at, stage) VALUES (?, ?, ?, ?)""",
        ("lead_002", "2026-01-01", "2026-01-01", "new"),
    )
    conn.commit()

    tid = log_lead_touch(
        conn, lead_id="lead_002", channel="dm", action="sent_case_study",
        outcome="opened", correlation_id="corr_001",
    )
    assert tid.startswith("touch_")

    touches = get_lead_touches(conn, lead_id="lead_002")
    assert len(touches) == 1
    assert touches[0]["channel"] == "dm"
    assert touches[0]["action"] == "sent_case_study"
