"""Tests for the GrantOps Finance sub-module.

Covers: models, store CRUD, scoring engine, scanner ingestion,
drafter package assembly, submitter lane routing, and digest formatting.
"""
from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime, timedelta

import pytest

from packages.grantops.models import (
    Draft,
    DraftStatus,
    Opportunity,
    OpportunitySource,
    OpportunityStatus,
    PortalType,
    Priority,
    Submission,
    SubmissionMethod,
    SubmissionOutcome,
    SubmissionStatus,
)
from packages.grantops.scoring import (
    BusinessProfile,
    compute_effort_score,
    compute_fit_score,
    derive_priority,
    score_opportunity,
)
from packages.grantops.store import (
    get_opportunity,
    get_opportunity_by_external_id,
    get_summary_stats,
    insert_draft,
    insert_submission,
    list_action_needed,
    list_drafts,
    list_new_today,
    list_opportunities,
    update_draft_status,
    update_opportunity_status,
    update_submission_outcome,
    update_submission_status,
    upsert_opportunity,
)
from packages.grantops.scanner import ingest_opportunities
from packages.grantops.drafter import (
    create_draft_package,
    extract_requirements,
    generate_budget,
    generate_narrative,
    generate_timeline,
)
from packages.grantops.submitter import (
    block_submission,
    confirm_submission,
    initiate_submission,
)
from packages.grantops.digest import (
    format_daily_digest,
    format_high_priority_alert,
    format_outcome_alert,
    format_package_approval_request,
)


@pytest.fixture()
def db():
    """In-memory SQLite DB with grant tables + audit_log."""
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    # Create grant tables
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS audit_log (
            id TEXT PRIMARY KEY,
            ts INTEGER NOT NULL,
            action TEXT NOT NULL,
            target TEXT NOT NULL,
            correlation_id TEXT,
            payload_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS grant_opportunities (
            id TEXT PRIMARY KEY,
            external_id TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL,
            funder TEXT NOT NULL DEFAULT '',
            deadline TEXT,
            amount_min_usd REAL,
            amount_max_usd REAL,
            fit_score REAL DEFAULT 0.0,
            effort_score REAL DEFAULT 0.0,
            priority TEXT DEFAULT 'medium',
            status TEXT DEFAULT 'new',
            portal_type TEXT DEFAULT 'guided',
            portal_url TEXT DEFAULT '',
            source TEXT DEFAULT 'manual',
            brand TEXT DEFAULT 'fulldigital',
            tags_json TEXT DEFAULT '[]',
            raw_data_json TEXT DEFAULT '{}',
            discovered_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            content_hash TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS grant_drafts (
            id TEXT PRIMARY KEY,
            opportunity_id TEXT NOT NULL,
            name TEXT NOT NULL,
            status TEXT DEFAULT 'requirements_extracted',
            narrative TEXT DEFAULT '',
            budget_json TEXT DEFAULT '{}',
            timeline_json TEXT DEFAULT '[]',
            attachments_ready INTEGER DEFAULT 0,
            reviewer TEXT DEFAULT '',
            review_notes TEXT DEFAULT '',
            manifest_json TEXT DEFAULT '{}',
            vault_snapshot_id TEXT DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            content_hash TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS grant_submissions (
            id TEXT PRIMARY KEY,
            opportunity_id TEXT NOT NULL,
            draft_id TEXT,
            name TEXT NOT NULL,
            method TEXT DEFAULT 'guided_submit',
            status TEXT DEFAULT 'pending',
            submitted_at TEXT,
            confirmation_id TEXT DEFAULT '',
            blocker_reason TEXT DEFAULT '',
            follow_up_date TEXT,
            outcome TEXT DEFAULT 'pending',
            award_amount_usd REAL,
            notes TEXT DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            content_hash TEXT NOT NULL DEFAULT ''
        );
    """)
    yield conn
    conn.close()


def _make_opp(**kwargs) -> Opportunity:
    defaults = dict(
        external_id="candid:test_001",
        name="Digital Arts Innovation Fund",
        funder="National Arts Council",
        deadline=(datetime.now(tz=UTC) + timedelta(days=30)).strftime("%Y-%m-%d"),
        amount_min_usd=10000,
        amount_max_usd=50000,
        portal_type=PortalType.SUBMITTABLE,
        source=OpportunitySource.CANDID,
        brand="fulldigital",
    )
    defaults.update(kwargs)
    return Opportunity(**defaults)


# ── Model Tests ──


class TestModels:
    def test_opportunity_content_hash_stable(self):
        opp = _make_opp()
        h1 = opp.content_hash
        h2 = opp.content_hash
        assert h1 == h2
        assert len(h1) == 16

    def test_opportunity_amount_display(self):
        assert _make_opp(amount_min_usd=10000, amount_max_usd=50000).amount_display == "$10,000 - $50,000"
        assert _make_opp(amount_min_usd=None, amount_max_usd=25000).amount_display == "Up to $25,000"
        assert _make_opp(amount_min_usd=5000, amount_max_usd=None).amount_display == "From $5,000"
        assert _make_opp(amount_min_usd=None, amount_max_usd=None).amount_display == "TBD"

    def test_draft_content_hash(self):
        draft = Draft(opportunity_id="opp_1", name="Test Draft")
        assert len(draft.content_hash) == 16

    def test_submission_content_hash(self):
        sub = Submission(opportunity_id="opp_1", name="Test Sub")
        assert len(sub.content_hash) == 16


# ── Store Tests ──


class TestStore:
    def test_upsert_and_get(self, db):
        opp = _make_opp()
        upsert_opportunity(db, opp)
        result = get_opportunity(db, opp.id)
        assert result is not None
        assert result["name"] == "Digital Arts Innovation Fund"

    def test_dedupe_on_external_id(self, db):
        opp1 = _make_opp(name="Version 1")
        upsert_opportunity(db, opp1)
        opp2 = _make_opp(name="Version 2")  # same external_id
        upsert_opportunity(db, opp2)

        by_ext = get_opportunity_by_external_id(db, "candid:test_001")
        assert by_ext["name"] == "Version 2"

        # Should still be one row
        all_opps = list_opportunities(db)
        assert len(all_opps) == 1

    def test_list_with_filters(self, db):
        upsert_opportunity(db, _make_opp(external_id="a", fit_score=0.9))
        upsert_opportunity(db, _make_opp(external_id="b", fit_score=0.3))
        upsert_opportunity(db, _make_opp(external_id="c", fit_score=0.7, status=OpportunityStatus.SKIPPED))

        high_fit = list_opportunities(db, min_fit_score=0.7)
        assert len(high_fit) == 2

        new_only = list_opportunities(db, status="new")
        assert len(new_only) == 2  # "c" is skipped

    def test_new_today(self, db):
        opp = _make_opp()
        upsert_opportunity(db, opp)
        today = list_new_today(db)
        assert len(today) == 1

    def test_draft_lifecycle(self, db):
        opp = _make_opp()
        upsert_opportunity(db, opp)

        draft = Draft(opportunity_id=opp.id, name="Draft 1")
        insert_draft(db, draft)

        drafts = list_drafts(db, status="requirements_extracted")
        assert len(drafts) == 1

        update_draft_status(db, draft.id, "review", review_notes="Looks good")
        updated = list_drafts(db, status="review")
        assert len(updated) == 1
        assert updated[0]["review_notes"] == "Looks good"

    def test_submission_lifecycle(self, db):
        opp = _make_opp()
        upsert_opportunity(db, opp)

        sub = Submission(opportunity_id=opp.id, name="Sub 1")
        insert_submission(db, sub)

        update_submission_status(db, sub.id, "confirmed", confirmation_id="CONF-123")
        result = db.execute("SELECT * FROM grant_submissions WHERE id = ?", (sub.id,)).fetchone()
        assert dict(result)["status"] == "confirmed"
        assert dict(result)["confirmation_id"] == "CONF-123"

        update_submission_outcome(db, sub.id, "awarded", award_amount_usd=25000)
        result = db.execute("SELECT * FROM grant_submissions WHERE id = ?", (sub.id,)).fetchone()
        assert dict(result)["outcome"] == "awarded"
        assert dict(result)["award_amount_usd"] == 25000

    def test_action_needed(self, db):
        opp = _make_opp()
        upsert_opportunity(db, opp)

        blocked = Submission(
            opportunity_id=opp.id, name="Blocked Sub",
            status=SubmissionStatus.BLOCKED, blocker_reason="Unknown field",
        )
        insert_submission(db, blocked)

        items = list_action_needed(db)
        assert len(items) == 1
        assert items[0]["blocker_reason"] == "Unknown field"

    def test_summary_stats(self, db):
        opp = _make_opp(fit_score=0.8)
        upsert_opportunity(db, opp)

        draft = Draft(opportunity_id=opp.id, name="D1", status=DraftStatus.REVIEW)
        insert_draft(db, draft)

        sub = Submission(
            opportunity_id=opp.id, name="S1",
            outcome=SubmissionOutcome.AWARDED, award_amount_usd=15000,
        )
        insert_submission(db, sub)

        stats = get_summary_stats(db)
        assert stats["new_today"] == 1
        assert stats["high_fit"] == 1
        assert stats["drafts_in_review"] == 1
        assert stats["total_awarded_usd"] == 15000


# ── Scoring Tests ──


class TestScoring:
    def test_fit_score_range(self):
        opp = _make_opp().model_dump()
        opp["raw_data"] = {"description": "digital media arts technology creative services"}
        score = compute_fit_score(opp)
        assert 0.0 <= score <= 1.0

    def test_high_fit_for_matching_opp(self):
        profile = BusinessProfile(
            industries=["digital media", "creative services"],
            org_type="for_profit",
            location="US",
            typical_project_min_usd=10000,
            typical_project_max_usd=50000,
            team_size=5,
            past_funders=["National Arts Council"],
        )
        opp = _make_opp(funder="National Arts Council").model_dump()
        opp["raw_data"] = {
            "description": "Supporting digital media and creative services innovation",
            "geographic_scope": "national",
            "eligible_org_types": ["for_profit", "nonprofit"],
        }
        score = compute_fit_score(opp, profile)
        assert score >= 0.6  # Should be high with matching industry + funder + geo + type

    def test_effort_score_submittable_low(self):
        opp = {"portal_type": "submittable", "raw_data": {"required_attachments": []}}
        score = compute_effort_score(opp)
        assert score < 0.3  # Submittable + no attachments = easy

    def test_effort_score_complex_high(self):
        opp = {
            "portal_type": "portal_other",
            "raw_data": {
                "required_attachments": ["budget", "narrative", "timeline", "letters", "financials"],
                "narrative_word_limit": 3000,
                "budget_detail": "line_item",
                "references_required": 3,
            },
        }
        score = compute_effort_score(opp)
        assert score > 0.5  # Complex portal + many requirements = hard

    def test_priority_derivation(self):
        assert derive_priority(0.9, 0.3) == Priority.URGENT
        assert derive_priority(0.75, 0.6) == Priority.HIGH
        assert derive_priority(0.55, 0.5) == Priority.MEDIUM
        assert derive_priority(0.3, 0.8) == Priority.LOW

    def test_score_opportunity_returns_all_fields(self):
        opp = _make_opp().model_dump()
        result = score_opportunity(opp)
        assert "fit_score" in result
        assert "effort_score" in result
        assert "priority" in result


# ── Scanner Tests ──


class TestScanner:
    def test_ingest_creates_opportunities(self, db):
        raw_results = [
            {
                "id": "candid_123",
                "title": "Creative Tech Grant",
                "funder_name": "Tech Foundation",
                "deadline": "2026-06-01",
                "amount_max": 30000,
                "application_url": "https://submittable.com/submit/abc",
            },
            {
                "id": "candid_456",
                "title": "Arts Innovation Award",
                "funder_name": "Arts Council",
                "deadline": "2026-07-15",
                "amount_min": 5000,
                "amount_max": 25000,
            },
        ]
        stats = ingest_opportunities(db, raw_results, source="candid", dry_run=False)
        assert stats["new"] == 2
        assert stats["errors"] == 0

        all_opps = list_opportunities(db)
        assert len(all_opps) == 2

    def test_ingest_dedupes(self, db):
        raw = [{"id": "dup_001", "title": "Same Grant", "funder_name": "F"}]
        ingest_opportunities(db, raw, source="candid", dry_run=False)
        ingest_opportunities(db, raw, source="candid", dry_run=False)

        all_opps = list_opportunities(db)
        assert len(all_opps) == 1

    def test_ingest_dry_run(self, db):
        raw = [{"id": "dry_001", "title": "Dry Run Grant", "funder_name": "F"}]
        stats = ingest_opportunities(db, raw, source="candid", dry_run=True)
        assert stats["new"] == 1

        # Should NOT be in DB
        all_opps = list_opportunities(db)
        assert len(all_opps) == 0

    def test_ingest_detects_submittable_portal(self, db):
        raw = [{
            "id": "portal_001",
            "title": "Submittable Grant",
            "funder_name": "F",
            "application_url": "https://xyz.submittable.com/submit/abc",
        }]
        ingest_opportunities(db, raw, source="candid", dry_run=False)
        opp = list_opportunities(db)[0]
        assert opp["portal_type"] == "submittable"


# ── Drafter Tests ──


class TestDrafter:
    def test_extract_requirements(self):
        opp = {"raw_data_json": json.dumps({
            "narrative_word_limit": 2000,
            "budget_detail": "line_item",
            "required_attachments": ["budget", "letters"],
        })}
        reqs = extract_requirements(opp)
        assert reqs["narrative_word_limit"] == 2000
        assert reqs["budget_detail"] == "line_item"
        assert len(reqs["required_attachments"]) == 2

    def test_generate_narrative(self):
        opp = {"funder": "Test Foundation", "name": "Innovation Grant"}
        text = generate_narrative(opp, {})
        assert "Test Foundation" in text
        assert len(text) > 50

    def test_generate_budget(self):
        opp = {"amount_max_usd": 50000}
        budget = generate_budget(opp, {})
        assert budget["total_requested"] == 50000
        total_items = sum(item["amount"] for item in budget["line_items"])
        assert total_items == 50000

    def test_generate_timeline(self):
        timeline = generate_timeline({})
        assert len(timeline) >= 4

    def test_create_draft_package(self, db):
        opp = _make_opp()
        upsert_opportunity(db, opp)

        result = create_draft_package(db, opp.id, dry_run=False)
        assert result["ok"] is True
        assert "draft_id" in result
        assert "manifest" in result

        drafts = list_drafts(db, opportunity_id=opp.id)
        assert len(drafts) == 1

    def test_create_draft_dry_run(self, db):
        opp = _make_opp()
        upsert_opportunity(db, opp)

        result = create_draft_package(db, opp.id, dry_run=True)
        assert result["ok"] is True
        assert result["dry_run"] is True
        assert list_drafts(db) == []  # Nothing created


# ── Submitter Tests ──


class TestSubmitter:
    def _setup_approved_draft(self, db):
        opp = _make_opp()
        upsert_opportunity(db, opp)
        draft = Draft(
            opportunity_id=opp.id, name="Approved Draft",
            status=DraftStatus.APPROVED,
        )
        insert_draft(db, draft)
        return opp, draft

    def test_initiate_submission(self, db):
        opp, draft = self._setup_approved_draft(db)
        result = initiate_submission(db, draft.id, dry_run=False)
        assert result["ok"] is True
        assert result["method"] == "submittable_api"  # opp has submittable portal
        assert "submission_id" in result

    def test_initiate_rejects_unapproved(self, db):
        opp = _make_opp()
        upsert_opportunity(db, opp)
        draft = Draft(opportunity_id=opp.id, name="Not Approved", status=DraftStatus.REVIEW)
        insert_draft(db, draft)

        result = initiate_submission(db, draft.id, dry_run=False)
        assert result["ok"] is False
        assert result["error"] == "draft_not_approved"

    def test_confirm_submission(self, db):
        opp, draft = self._setup_approved_draft(db)
        sub_result = initiate_submission(db, draft.id, dry_run=False)
        sub_id = sub_result["submission_id"]

        confirm = confirm_submission(db, sub_id, confirmation_id="CONF-XYZ", dry_run=False)
        assert confirm["ok"] is True

    def test_block_submission(self, db):
        opp, draft = self._setup_approved_draft(db)
        sub_result = initiate_submission(db, draft.id, dry_run=False)
        sub_id = sub_result["submission_id"]

        block = block_submission(db, sub_id, reason="Unknown custom field")
        assert block["ok"] is True
        assert block["reason"] == "Unknown custom field"


# ── Digest Tests ──


class TestDigest:
    def test_daily_digest_format(self, db):
        opp = _make_opp(fit_score=0.85)
        upsert_opportunity(db, opp)

        text = format_daily_digest(db)
        assert "[GrantOps] Daily Digest" in text
        assert "New today:" in text

    def test_high_priority_alert(self):
        opp = {
            "name": "Innovation Grant",
            "funder": "Tech Foundation",
            "deadline": "2026-04-15",
            "amount_min_usd": 25000,
            "amount_max_usd": 50000,
            "fit_score": 0.92,
            "portal_type": "submittable",
        }
        text = format_high_priority_alert(opp)
        assert "High-Fit Opportunity" in text
        assert "Tech Foundation" in text
        assert "0.92" in text

    def test_package_approval_request(self):
        draft = {"name": "Draft: Innovation Grant", "attachments_ready": True}
        opp = {"name": "Innovation Grant", "funder": "Tech Foundation", "deadline": "2026-04-15"}
        text = format_package_approval_request(draft, opp)
        assert "Package Ready for Review" in text
        assert "Attachments: Ready" in text

    def test_outcome_alert_awarded(self):
        sub = {"name": "Innovation Grant", "outcome": "awarded", "award_amount_usd": 50000}
        text = format_outcome_alert(sub)
        assert "Awarded" in text
        assert "$50,000" in text
