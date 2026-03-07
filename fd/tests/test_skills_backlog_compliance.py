"""Tests for Skills Backlog schema, verifier, drift healer, and admin endpoints."""
from __future__ import annotations

from unittest.mock import MagicMock

import pytest


# ════════════════════════════════════════════
# Schema
# ════════════════════════════════════════════


class TestSkillsBacklogSchema:
    def test_required_props_count(self):
        from packages.agencyu.notion.skills_backlog_schema import SKILLS_BACKLOG_REQUIRED_PROPS

        assert len(SKILLS_BACKLOG_REQUIRED_PROPS) == 13

    def test_required_prop_map_keys(self):
        from packages.agencyu.notion.skills_backlog_schema import required_prop_map

        m = required_prop_map()
        assert "Name" in m
        assert "skill_key" in m
        assert "trust_tier" in m
        assert "pain_point" in m
        assert "created_at" in m

    def test_prop_spec_frozen(self):
        from packages.agencyu.notion.skills_backlog_schema import PropSpec

        p = PropSpec("test", "rich_text")
        with pytest.raises(AttributeError):
            p.key = "changed"  # type: ignore[misc]

    def test_select_options_frozen(self):
        from packages.agencyu.notion.skills_backlog_schema import SelectOptions

        s = SelectOptions(["a", "b"])
        with pytest.raises(AttributeError):
            s.required = []  # type: ignore[misc]

    def test_trust_tier_options(self):
        from packages.agencyu.notion.skills_backlog_schema import required_prop_map

        m = required_prop_map()
        assert m["trust_tier"].select_options is not None
        assert set(m["trust_tier"].select_options.required) == {
            "official", "curated", "community", "unknown",
        }

    def test_status_options(self):
        from packages.agencyu.notion.skills_backlog_schema import required_prop_map

        m = required_prop_map()
        assert m["status"].select_options is not None
        assert "New" in m["status"].select_options.required
        assert "Rejected" in m["status"].select_options.required

    def test_pain_point_is_multi_select(self):
        from packages.agencyu.notion.skills_backlog_schema import required_prop_map

        m = required_prop_map()
        assert m["pain_point"].notion_type == "multi_select"
        assert m["pain_point"].select_options is not None
        assert "Persistent Memory" in m["pain_point"].select_options.required

    def test_notion_prop_type_from_db_property(self):
        from packages.agencyu.notion.skills_backlog_schema import notion_prop_type_from_db_property

        assert notion_prop_type_from_db_property({"type": "select"}) == "select"
        assert notion_prop_type_from_db_property({}) is None


# ════════════════════════════════════════════
# Verifier
# ════════════════════════════════════════════


def _make_full_db_properties():
    """Build a mock DB properties dict that is fully compliant."""
    return {
        "Name": {"type": "title"},
        "skill_key": {"type": "rich_text"},
        "source_url": {"type": "url"},
        "trust_tier": {
            "type": "select",
            "options": ["official", "curated", "community", "unknown"],
        },
        "fit_score": {"type": "number"},
        "risk_score": {"type": "number"},
        "recommended_mode": {
            "type": "select",
            "options": ["safe_only", "safe_then_confirm", "confirm_only", "do_not_install"],
        },
        "status": {
            "type": "select",
            "options": ["New", "Reviewing", "Approved to Fork", "Forked", "Rejected"],
        },
        "pain_point": {
            "type": "multi_select",
            "options": ["Persistent Memory"],
        },
        "notes": {"type": "rich_text"},
        "checklist_page_url": {"type": "url"},
        "created_at": {"type": "date"},
        "last_updated_at": {"type": "date"},
    }


class TestSkillsBacklogVerifier:
    def test_fully_compliant(self):
        from packages.agencyu.notion.skills_backlog_verifier import verify_skills_backlog_db

        api = MagicMock()
        api.get_database.return_value = {
            "id": "db_123",
            "properties": _make_full_db_properties(),
        }

        result = verify_skills_backlog_db(api, "db_123")
        assert result.db_exists is True
        assert result.compliant is True
        assert result.missing_props == []
        assert result.mismatched_props == []
        assert result.missing_options == []

    def test_db_not_found(self):
        from packages.agencyu.notion.skills_backlog_verifier import verify_skills_backlog_db

        api = MagicMock()
        api.get_database.side_effect = RuntimeError("404")

        result = verify_skills_backlog_db(api, "db_missing")
        assert result.db_exists is False
        assert result.compliant is False

    def test_missing_properties(self):
        from packages.agencyu.notion.skills_backlog_verifier import verify_skills_backlog_db

        props = _make_full_db_properties()
        del props["skill_key"]
        del props["fit_score"]

        api = MagicMock()
        api.get_database.return_value = {"id": "db_123", "properties": props}

        result = verify_skills_backlog_db(api, "db_123")
        assert result.db_exists is True
        assert result.compliant is False
        assert len(result.missing_props) == 2
        missing_keys = {p.property_key for p in result.missing_props}
        assert missing_keys == {"skill_key", "fit_score"}

    def test_mismatched_type(self):
        from packages.agencyu.notion.skills_backlog_verifier import verify_skills_backlog_db

        props = _make_full_db_properties()
        props["fit_score"] = {"type": "rich_text"}  # wrong type

        api = MagicMock()
        api.get_database.return_value = {"id": "db_123", "properties": props}

        result = verify_skills_backlog_db(api, "db_123")
        assert result.compliant is False
        assert len(result.mismatched_props) == 1
        assert result.mismatched_props[0].property_key == "fit_score"
        assert result.mismatched_props[0].expected_type == "number"
        assert result.mismatched_props[0].actual_type == "rich_text"

    def test_missing_select_options(self):
        from packages.agencyu.notion.skills_backlog_verifier import verify_skills_backlog_db

        props = _make_full_db_properties()
        # Remove "unknown" from trust_tier options
        props["trust_tier"]["options"] = ["official", "curated", "community"]

        api = MagicMock()
        api.get_database.return_value = {"id": "db_123", "properties": props}

        result = verify_skills_backlog_db(api, "db_123")
        assert result.compliant is False
        assert len(result.missing_options) == 1
        assert result.missing_options[0].property_key == "trust_tier"
        assert result.missing_options[0].option_name == "unknown"

    def test_to_dict(self):
        from packages.agencyu.notion.skills_backlog_verifier import (
            MissingOption,
            MissingProp,
            MismatchedProp,
            SkillsBacklogCompliance,
        )

        c = SkillsBacklogCompliance(
            db_id="db_1",
            db_exists=True,
            compliant=False,
            missing_props=[MissingProp("x", "rich_text")],
            mismatched_props=[MismatchedProp("y", "number", "rich_text")],
            missing_options=[MissingOption("z", "opt1")],
        )
        d = c.to_dict()
        assert d["db_id"] == "db_1"
        assert len(d["missing_props"]) == 1
        assert len(d["mismatched_props"]) == 1
        assert len(d["missing_options"]) == 1

    def test_extra_properties_ignored(self):
        from packages.agencyu.notion.skills_backlog_verifier import verify_skills_backlog_db

        props = _make_full_db_properties()
        props["custom_user_field"] = {"type": "rich_text"}  # extra is fine

        api = MagicMock()
        api.get_database.return_value = {"id": "db_123", "properties": props}

        result = verify_skills_backlog_db(api, "db_123")
        assert result.compliant is True


# ════════════════════════════════════════════
# Drift Healer
# ════════════════════════════════════════════


class TestSkillsBacklogDriftHealer:
    def _make_api_compliant(self):
        api = MagicMock()
        api.get_database.return_value = {
            "id": "db_123",
            "properties": _make_full_db_properties(),
        }
        return api

    def _make_api_missing_props(self):
        props = _make_full_db_properties()
        del props["skill_key"]
        del props["notes"]

        api = MagicMock()
        api.get_database.return_value = {"id": "db_123", "properties": props}
        return api

    def _make_api_missing_options(self):
        props = _make_full_db_properties()
        props["trust_tier"]["options"] = ["official", "curated"]  # missing community, unknown

        api = MagicMock()
        api.get_database.return_value = {"id": "db_123", "properties": props}
        return api

    def test_simulate_no_drift(self):
        from packages.agencyu.notion.skills_backlog_drift_healer import heal_skills_backlog_db

        api = self._make_api_compliant()
        result = heal_skills_backlog_db(api, "db_123", safe_mode=True)

        assert result.ok is True
        assert result.mode == "simulate"
        assert result.actions_planned == []
        assert result.actions_applied == []
        api.update_database.assert_not_called()

    def test_simulate_with_missing_props(self):
        from packages.agencyu.notion.skills_backlog_drift_healer import heal_skills_backlog_db

        api = self._make_api_missing_props()
        result = heal_skills_backlog_db(api, "db_123", safe_mode=True)

        assert result.ok is True
        assert result.mode == "simulate"
        assert len(result.actions_planned) == 2
        assert all(a["action"] == "create_property" for a in result.actions_planned)
        assert result.actions_applied == []
        api.update_database.assert_not_called()

    def test_simulate_with_missing_options(self):
        from packages.agencyu.notion.skills_backlog_drift_healer import heal_skills_backlog_db

        api = self._make_api_missing_options()
        result = heal_skills_backlog_db(api, "db_123", safe_mode=True)

        assert result.ok is True
        assert result.mode == "simulate"
        option_actions = [a for a in result.actions_planned if a["action"] == "add_select_option"]
        assert len(option_actions) == 2  # community + unknown
        api.update_database.assert_not_called()

    def test_blocked_by_write_lock(self):
        from packages.agencyu.notion.skills_backlog_drift_healer import heal_skills_backlog_db

        api = self._make_api_missing_props()
        result = heal_skills_backlog_db(
            api, "db_123",
            safe_mode=False,
            write_lock=True,
            allow_schema_writes=True,
        )

        assert result.ok is False
        assert result.blocked_reason == "write_lock_enabled"
        api.update_database.assert_not_called()

    def test_blocked_by_allow_schema_writes(self):
        from packages.agencyu.notion.skills_backlog_drift_healer import heal_skills_backlog_db

        api = self._make_api_missing_props()
        result = heal_skills_backlog_db(
            api, "db_123",
            safe_mode=False,
            write_lock=False,
            allow_schema_writes=False,
        )

        assert result.ok is False
        assert result.blocked_reason == "allow_schema_writes_false"
        api.update_database.assert_not_called()

    def test_apply_missing_properties(self):
        from packages.agencyu.notion.skills_backlog_drift_healer import heal_skills_backlog_db

        api = self._make_api_missing_props()
        result = heal_skills_backlog_db(
            api, "db_123",
            safe_mode=False,
            write_lock=False,
            allow_schema_writes=True,
        )

        assert result.ok is True
        assert result.mode == "apply"
        assert len(result.actions_applied) == 2
        api.update_database.assert_called()

    def test_apply_missing_options(self):
        from packages.agencyu.notion.skills_backlog_drift_healer import heal_skills_backlog_db

        api = self._make_api_missing_options()
        result = heal_skills_backlog_db(
            api, "db_123",
            safe_mode=False,
            write_lock=False,
            allow_schema_writes=True,
        )

        assert result.ok is True
        assert result.mode == "apply"
        option_applied = [a for a in result.actions_applied if a["action"] == "add_select_option"]
        assert len(option_applied) == 2
        api.append_select_options.assert_called()

    def test_db_missing_returns_blocked(self):
        from packages.agencyu.notion.skills_backlog_drift_healer import heal_skills_backlog_db

        api = MagicMock()
        api.get_database.side_effect = RuntimeError("404")

        result = heal_skills_backlog_db(api, "db_missing", safe_mode=False)
        assert result.ok is False
        assert result.blocked_reason == "skills_backlog_db_missing"

    def test_type_mismatch_emits_warning(self):
        from packages.agencyu.notion.skills_backlog_drift_healer import heal_skills_backlog_db

        props = _make_full_db_properties()
        props["fit_score"] = {"type": "rich_text"}  # wrong type

        api = MagicMock()
        api.get_database.return_value = {"id": "db_123", "properties": props}

        result = heal_skills_backlog_db(api, "db_123", safe_mode=True)
        mismatch_actions = [
            a for a in result.actions_planned
            if a["action"] == "type_mismatch_detected"
        ]
        assert len(mismatch_actions) == 1
        assert mismatch_actions[0]["property_key"] == "fit_score"
        assert "Manual review" in mismatch_actions[0]["note"]


# ════════════════════════════════════════════
# Drift Healer — prop_create_payload
# ════════════════════════════════════════════


class TestPropCreatePayload:
    def test_rich_text(self):
        from packages.agencyu.notion.skills_backlog_drift_healer import _prop_create_payload

        assert _prop_create_payload("rich_text", None) == {"rich_text": {}}

    def test_url(self):
        from packages.agencyu.notion.skills_backlog_drift_healer import _prop_create_payload

        assert _prop_create_payload("url", None) == {"url": {}}

    def test_number(self):
        from packages.agencyu.notion.skills_backlog_drift_healer import _prop_create_payload

        assert _prop_create_payload("number", None) == {"number": {"format": "number"}}

    def test_date(self):
        from packages.agencyu.notion.skills_backlog_drift_healer import _prop_create_payload

        assert _prop_create_payload("date", None) == {"date": {}}

    def test_select_with_options(self):
        from packages.agencyu.notion.skills_backlog_drift_healer import _prop_create_payload

        result = _prop_create_payload("select", ["a", "b"])
        assert result == {"select": {"options": [{"name": "a"}, {"name": "b"}]}}

    def test_multi_select_with_options(self):
        from packages.agencyu.notion.skills_backlog_drift_healer import _prop_create_payload

        result = _prop_create_payload("multi_select", ["x"])
        assert result == {"multi_select": {"options": [{"name": "x"}]}}

    def test_title(self):
        from packages.agencyu.notion.skills_backlog_drift_healer import _prop_create_payload

        assert _prop_create_payload("title", None) == {"title": {}}

    def test_unsupported_raises(self):
        from packages.agencyu.notion.skills_backlog_drift_healer import _prop_create_payload

        with pytest.raises(ValueError, match="Unsupported"):
            _prop_create_payload("relation", None)


# ════════════════════════════════════════════
# Admin endpoint — HealRequest model
# ════════════════════════════════════════════


class TestHealRequestModel:
    def test_defaults(self):
        from services.webhook_gateway.routes.skills_backlog_compliance import HealRequest

        req = HealRequest()
        assert req.safe_mode is True
        assert req.allow_schema_writes is False
        assert req.write_lock is True

    def test_override(self):
        from services.webhook_gateway.routes.skills_backlog_compliance import HealRequest

        req = HealRequest(safe_mode=False, allow_schema_writes=True, write_lock=False)
        assert req.safe_mode is False
        assert req.allow_schema_writes is True
        assert req.write_lock is False
