"""Tests for shared.vault_paths — centralized vault path definitions."""
import sys
from pathlib import Path

import pytest

# Ensure shared is importable
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from shared.vault_paths import (
    VAULT, INBOX, NOTES, AREAS, STRUCTURE, INSIGHTS,
    ACTIVITY, OPS, SYSTEM, PROJECTS, DAILY, PLAYBOOK,
    REPORTS, EXECUTION, ONTOLOGY, CLASSIFICATION_FILE,
    VAULT_CATEGORY_DIRS, get, get_all_stages, _V3_MAP,
)


class TestVaultRoot:
    def test_vault_is_path(self):
        assert isinstance(VAULT, Path)

    def test_vault_points_to_knowledge(self):
        assert VAULT == Path.home() / "knowledge"

    def test_vault_str(self):
        assert str(VAULT).endswith("/knowledge")


class TestV3Map:
    def test_has_8_stages(self):
        assert len(_V3_MAP) == 8

    def test_all_stages_present(self):
        expected = {"캡처", "정리", "지식화", "연결", "판단", "활동", "운영", "시스템"}
        assert set(_V3_MAP.keys()) == expected

    def test_all_values_are_paths(self):
        for stage, path in _V3_MAP.items():
            assert isinstance(path, Path), f"{stage} is not Path"

    def test_all_values_under_vault(self):
        for stage, path in _V3_MAP.items():
            assert str(path).startswith(str(VAULT)), (
                f"{stage}: {path} not under VAULT"
            )


class TestConstants:
    def test_inbox_is_110(self):
        assert INBOX == VAULT / "100 지식" / "110 수신함"

    def test_notes_is_121(self):
        assert NOTES == VAULT / "100 지식" / "121 노트"

    def test_areas_is_125(self):
        assert AREAS == VAULT / "100 지식" / "125 영역"

    def test_structure_is_130(self):
        assert STRUCTURE == VAULT / "100 지식" / "130 구조노트"

    def test_insights_is_140(self):
        assert INSIGHTS == VAULT / "100 지식" / "140 인사이트"

    def test_activity_is_200(self):
        assert ACTIVITY == VAULT / "200 활동"

    def test_ops_is_300(self):
        assert OPS == VAULT / "300 운영"

    def test_system_is_900(self):
        assert SYSTEM == VAULT / "900 시스템"

    def test_projects_under_activity(self):
        assert PROJECTS == ACTIVITY / "210 프로젝트"

    def test_daily_under_activity(self):
        assert DAILY == ACTIVITY / "230 일일"

    def test_playbook_under_ops(self):
        assert PLAYBOOK == OPS / "320 플레이북"

    def test_reports_under_ops(self):
        assert REPORTS == OPS / "340 리포트"

    def test_execution_under_ops(self):
        assert EXECUTION == OPS / "350 실행"

    def test_ontology_under_system(self):
        assert ONTOLOGY == SYSTEM / "910 온톨로지"

    def test_classification_file_is_json(self):
        assert str(CLASSIFICATION_FILE).endswith(".json")

    def test_classification_file_under_system(self):
        assert CLASSIFICATION_FILE == SYSTEM / "classification.json"

    def test_all_constants_under_vault(self):
        for name, val in [
            ("INBOX", INBOX), ("NOTES", NOTES), ("AREAS", AREAS),
            ("STRUCTURE", STRUCTURE), ("INSIGHTS", INSIGHTS),
            ("ACTIVITY", ACTIVITY), ("OPS", OPS), ("SYSTEM", SYSTEM),
            ("PROJECTS", PROJECTS), ("DAILY", DAILY),
            ("PLAYBOOK", PLAYBOOK), ("REPORTS", REPORTS),
            ("EXECUTION", EXECUTION), ("ONTOLOGY", ONTOLOGY),
            ("CLASSIFICATION_FILE", CLASSIFICATION_FILE),
        ]:
            assert str(val).startswith(str(VAULT)), f"{name} not under VAULT"


class TestVaultCategoryDirs:
    def test_has_5_categories(self):
        assert len(VAULT_CATEGORY_DIRS) == 5

    def test_expected_categories(self):
        expected = {"기업", "시장", "산업분석", "프로그래밍", "인사이트"}
        assert set(VAULT_CATEGORY_DIRS.keys()) == expected

    def test_all_under_vault(self):
        for cat, path in VAULT_CATEGORY_DIRS.items():
            assert str(path).startswith(str(VAULT)), f"{cat} not under VAULT"

    def test_all_are_paths(self):
        for cat, path in VAULT_CATEGORY_DIRS.items():
            assert isinstance(path, Path), f"{cat} is not Path"


class TestGetFunction:
    def test_get_valid_stage(self):
        assert get("캡처") == INBOX
        assert get("운영") == OPS

    def test_get_invalid_raises(self):
        with pytest.raises(KeyError):
            get("invalid_stage")

    def test_get_returns_path(self):
        for stage in _V3_MAP:
            assert isinstance(get(stage), Path)


class TestGetAllStages:
    def test_returns_dict(self):
        result = get_all_stages()
        assert isinstance(result, dict)

    def test_returns_copy(self):
        result = get_all_stages()
        assert result is not _V3_MAP
        result["test"] = Path("/tmp")
        assert "test" not in _V3_MAP

    def test_same_content(self):
        result = get_all_stages()
        assert result == _V3_MAP

    def test_has_8_entries(self):
        assert len(get_all_stages()) == 8
