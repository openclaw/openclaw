from __future__ import annotations

import sqlite3

from packages.common.db import init_schema
from packages.domain.attribution import (
    extract_campaign_from_tags,
    get_attribution_backlog_count,
    record_touchpoint,
    resolve_contact_key,
    update_lead_attribution,
)


def _mem_db() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    init_schema(conn)
    return conn


# --- Tag parsing tests ---


def test_extract_campaign_from_tags_full():
    tags = ["campaign:fd_warm_mar26", "source:ig_dm", "status:qualified", "revenue:growth"]
    result = extract_campaign_from_tags(tags)
    assert result["campaign"] == "fd_warm_mar26"
    assert result["source"] == "ig_dm"
    assert result["status"] == "qualified"
    assert result["revenue"] == "growth"


def test_extract_campaign_from_tags_partial():
    tags = ["campaign:test_campaign", "random_tag"]
    result = extract_campaign_from_tags(tags)
    assert result["campaign"] == "test_campaign"
    assert result["source"] is None
    assert result["status"] is None
    assert result["revenue"] is None


def test_extract_campaign_from_tags_empty():
    result = extract_campaign_from_tags([])
    assert result["campaign"] is None
    assert result["source"] is None


def test_extract_campaign_from_tags_invalid_status():
    tags = ["status:invalid_status"]
    result = extract_campaign_from_tags(tags)
    assert result["status"] is None


def test_extract_campaign_from_tags_case_insensitive():
    tags = ["Campaign:FD_WARM", "Source:IG_DM"]
    result = extract_campaign_from_tags(tags)
    assert result["campaign"] == "fd_warm"
    assert result["source"] == "ig_dm"


# --- Contact key resolution tests ---


def test_resolve_contact_key_ghl_first():
    key = resolve_contact_key(ghl_contact_id="ghl_123", email="test@example.com")
    assert key == "ghl_123"


def test_resolve_contact_key_manychat_second():
    key = resolve_contact_key(manychat_subscriber_id="mc_456")
    assert key == "mc_456"


def test_resolve_contact_key_phone_third():
    key = resolve_contact_key(phone="(555) 123-4567")
    assert key == "phone:+15551234567"


def test_resolve_contact_key_email_last():
    key = resolve_contact_key(email="  Test@Example.COM  ")
    assert key == "email:test@example.com"


def test_resolve_contact_key_none():
    key = resolve_contact_key()
    assert key is None


# --- Touchpoint recording tests ---


def test_record_touchpoint_dry_run():
    conn = _mem_db()
    result = record_touchpoint(
        conn,
        contact_key="ghl_123",
        touch_type="ad_click",
        source="instagram",
        campaign="test_campaign",
    )
    assert result["action"] == "would_record_touchpoint"


def test_record_touchpoint_idempotent():
    conn = _mem_db()
    # Insert a touchpoint directly
    conn.execute(
        "INSERT INTO attribution_touchpoints (touch_id, contact_key, touch_type, source, campaign, utm_json, ts) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ("evt_123", "ghl_123", "ad_click", "instagram", "test", "{}", "2026-01-01T00:00:00"),
    )
    conn.commit()

    result = record_touchpoint(
        conn,
        contact_key="ghl_123",
        touch_type="ad_click",
        source="instagram",
        event_id="evt_123",
    )
    assert result["action"] == "touchpoint_already_exists"


# --- Lead attribution tests ---


def test_update_lead_attribution_no_touchpoints():
    conn = _mem_db()
    result = update_lead_attribution(conn, contact_key="unknown_contact")
    assert result["action"] == "no_touchpoints"


def test_update_lead_attribution_dry_run():
    conn = _mem_db()
    # Insert touchpoints directly (bypass DRY_RUN)
    conn.execute(
        "INSERT INTO attribution_touchpoints (touch_id, contact_key, touch_type, source, campaign, utm_json, ts) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ("t1", "ghl_123", "ad_click", "instagram", "fd_warm", '{"utm_campaign": "fd_warm"}', "2026-01-01T00:00:00"),
    )
    conn.execute(
        "INSERT INTO attribution_touchpoints (touch_id, contact_key, touch_type, source, campaign, utm_json, ts) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ("t2", "ghl_123", "dm_keyword", "manychat", "fd_warm", "{}", "2026-01-02T00:00:00"),
    )
    conn.commit()

    result = update_lead_attribution(conn, contact_key="ghl_123")
    assert result["action"] == "would_update_lead_attribution"
    assert result["primary_campaign"] == "fd_warm"
    assert result["confidence"] == "high"


# --- Attribution backlog count ---


def test_attribution_backlog_count_empty():
    conn = _mem_db()
    assert get_attribution_backlog_count(conn) == 0


def test_attribution_backlog_count_with_unprocessed():
    conn = _mem_db()
    conn.execute(
        "INSERT INTO attribution_touchpoints (touch_id, contact_key, touch_type, source, campaign, utm_json, ts) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ("t1", "ghl_123", "ad_click", "ig", None, "{}", "2026-01-01T00:00:00"),
    )
    conn.commit()
    assert get_attribution_backlog_count(conn) == 1
