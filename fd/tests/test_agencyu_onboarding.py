from __future__ import annotations

import sqlite3

from packages.agencyu.onboarding.installer import handle_stripe_paid_install
from packages.agencyu.onboarding.nurture import (
    schedule_pre_call_nurture,
    start_no_show_rescue,
)
from packages.common.db import init_schema


def _mem_db() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    init_schema(conn)
    return conn


def test_handle_stripe_paid_install_dry_run():
    conn = _mem_db()
    result = handle_stripe_paid_install(
        conn,
        ghl_contact_id="ghl_001",
        offer_code="fd_rollout_800",
        trello_template_id="tmpl_001",
        client_display_name="Test Client",
        correlation_id="corr_001",
    )
    assert result["safe_mode"] is True
    assert len(result["plan"]) > 0
    # Should have steps: resolve, trello board, webhook, ghl patch, store mapping, notion, reconcile
    step_names = [s["step"] for s in result["plan"]]
    assert "resolve_contact" in step_names
    assert "trello.create_board" in step_names
    assert "trello.create_webhook" in step_names
    assert "ghl.patch_contact" in step_names
    assert "notion.create_client_workspace" in step_names


def test_schedule_pre_call_nurture_dry_run():
    conn = _mem_db()
    result = schedule_pre_call_nurture(conn, lead_id="lead_001", correlation_id="corr_001")
    assert result["ok"] is True
    assert len(result["steps"]) == 3  # 3 nurture steps
    assert all(s["action"] == "would_schedule" for s in result["steps"])


def test_start_no_show_rescue_dry_run():
    conn = _mem_db()
    result = start_no_show_rescue(conn, lead_id="lead_001", correlation_id="corr_001")
    assert result["action"] == "would_schedule_no_show_rescue"
    assert result["delay_minutes"] == 30
