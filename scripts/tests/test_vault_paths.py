"""Tests for shared.vault_paths — centralized vault path definitions."""
import sys
from pathlib import Path

import pytest

# Ensure shared is importable
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from shared.vault_paths import (
    VAULT, INBOX, NOTES, STRUCTURE, INSIGHTS,
    ACTIVITY, OPS, SYSTEM, PROJECTS, DAILY, PLAYBOOK,
    REPORTS, EXECUTION, ONTOLOGY, CLASSIFICATION_FILE,
    VAULT_CATEGORY_DIRS, get, get_all_stages, _V3_MAP,
    INBOX_RAW, INBOX_HYPO, INBOX_SUMM, INBOX_DAILY,
    REPORTS_ARCHIVE, REPORTS_HYPO, REPORTS_VIZ, REPORTS_ANALYSIS,
    LEGACY_NOTES, LEGACY_MOC, LEGACY_AREAS,
    iter_inbox_notes, get_daily_inbox_dir,
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
        expected = {"캡처", "정리", "연결", "판단", "리소스", "활동", "운영", "시스템"}
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
    def test_inbox_is_100_capture(self):
        assert INBOX == VAULT / "100 캡처" / "110 수신함"

    def test_notes_is_200(self):
        assert NOTES == VAULT / "200 정리"

    def test_structure_is_400(self):
        assert STRUCTURE == VAULT / "400 연결"

    def test_insights_is_500(self):
        assert INSIGHTS == VAULT / "500 판단"

    def test_activity_is_700(self):
        assert ACTIVITY == VAULT / "700 활동"

    def test_ops_is_800(self):
        assert OPS == VAULT / "800 운영"

    def test_system_is_900(self):
        assert SYSTEM == VAULT / "900 시스템"

    def test_projects_under_activity(self):
        assert PROJECTS == ACTIVITY / "710 프로젝트"

    def test_daily_under_activity(self):
        assert DAILY == ACTIVITY / "730 일일"

    def test_playbook_under_ops(self):
        assert PLAYBOOK == OPS / "820 플레이북"

    def test_reports_under_ops(self):
        assert REPORTS == OPS / "840 리포트"

    def test_execution_under_ops(self):
        assert EXECUTION == OPS / "850 실행"

    def test_ontology_under_system(self):
        assert ONTOLOGY == SYSTEM / "910 온톨로지"

    def test_classification_file_is_json(self):
        assert str(CLASSIFICATION_FILE).endswith(".json")

    def test_classification_file_under_system(self):
        assert CLASSIFICATION_FILE == SYSTEM / "classification.json"

    def test_all_constants_under_vault(self):
        for name, val in [
            ("INBOX", INBOX), ("NOTES", NOTES),
            ("STRUCTURE", STRUCTURE), ("INSIGHTS", INSIGHTS),
            ("ACTIVITY", ACTIVITY), ("OPS", OPS), ("SYSTEM", SYSTEM),
            ("PROJECTS", PROJECTS), ("DAILY", DAILY),
            ("PLAYBOOK", PLAYBOOK), ("REPORTS", REPORTS),
            ("EXECUTION", EXECUTION), ("ONTOLOGY", ONTOLOGY),
            ("CLASSIFICATION_FILE", CLASSIFICATION_FILE),
        ]:
            assert str(val).startswith(str(VAULT)), f"{name} not under VAULT"


class TestInboxSubpaths:
    def test_inbox_raw(self):
        assert INBOX_RAW == INBOX / "111_raw"

    def test_inbox_hypo(self):
        assert INBOX_HYPO == INBOX / "112 가설"

    def test_inbox_summ_fallback_to_inbox(self):
        """INBOX_SUMM은 폐지됨 — INBOX 자체로 리다이렉트."""
        assert INBOX_SUMM == INBOX

    def test_inbox_daily_fallback_to_inbox(self):
        """INBOX_DAILY은 폐지됨 — INBOX 자체로 리다이렉트."""
        assert INBOX_DAILY == INBOX


class TestReportsSubpaths:
    def test_reports_archive(self):
        assert REPORTS_ARCHIVE == REPORTS / "841 아카이브"

    def test_reports_hypo(self):
        assert REPORTS_HYPO == REPORTS / "842 가설"

    def test_reports_viz(self):
        assert REPORTS_VIZ == REPORTS / "843 시각화"

    def test_reports_analysis(self):
        assert REPORTS_ANALYSIS == REPORTS / "844 분석"


class TestLegacyPaths:
    def test_legacy_notes(self):
        assert LEGACY_NOTES == VAULT / "100 지식" / "120 노트"

    def test_legacy_moc(self):
        assert LEGACY_MOC == VAULT / "100 지식" / "150 구조노트"

    def test_legacy_areas(self):
        assert LEGACY_AREAS == VAULT / "100 지식" / "120 영역"


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

    def test_category_dirs_v3_paths(self):
        assert VAULT_CATEGORY_DIRS["기업"] == VAULT / "200 정리" / "220 기업"
        assert VAULT_CATEGORY_DIRS["시장"] == VAULT / "200 정리" / "225 시장"
        assert VAULT_CATEGORY_DIRS["산업분석"] == VAULT / "200 정리" / "230 산업분석"
        assert VAULT_CATEGORY_DIRS["프로그래밍"] == VAULT / "200 정리" / "235 프로그래밍"
        assert VAULT_CATEGORY_DIRS["인사이트"] == VAULT / "500 판단"


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


class TestIterInboxNotes:
    """iter_inbox_notes — 루트 + YYYY-MM-DD/ 하위 .md 수집."""

    def test_collects_root_and_daily_md(self, tmp_path):
        """루트 .md + 날짜 폴더 .md 모두 수집."""
        inbox = tmp_path / "inbox"
        inbox.mkdir()
        (inbox / "root_note.md").write_text("root")
        (inbox / "2026-02-25").mkdir()
        (inbox / "2026-02-25" / "daily_note.md").write_text("daily")
        # 비-날짜 폴더는 제외
        (inbox / "111_raw").mkdir()
        (inbox / "111_raw" / "raw.md").write_text("raw")

        result = list(iter_inbox_notes(inbox))
        names = [p.name for p in result]
        assert "root_note.md" in names
        assert "daily_note.md" in names
        assert "raw.md" not in names

    def test_sorted_within_each_level(self, tmp_path):
        """각 레벨 내에서 정렬."""
        inbox = tmp_path / "inbox"
        inbox.mkdir()
        (inbox / "b.md").write_text("")
        (inbox / "a.md").write_text("")
        (inbox / "2026-01-01").mkdir()
        (inbox / "2026-01-01" / "z.md").write_text("")
        (inbox / "2026-01-01" / "x.md").write_text("")

        result = list(iter_inbox_notes(inbox))
        names = [p.name for p in result]
        assert names == ["a.md", "b.md", "x.md", "z.md"]

    def test_empty_inbox(self, tmp_path):
        """빈 수신함."""
        inbox = tmp_path / "inbox"
        inbox.mkdir()
        assert list(iter_inbox_notes(inbox)) == []

    def test_nonexistent_inbox(self, tmp_path):
        """존재하지 않는 수신함."""
        assert list(iter_inbox_notes(tmp_path / "nope")) == []

    def test_multiple_date_folders_sorted(self, tmp_path):
        """여러 날짜 폴더는 날짜순."""
        inbox = tmp_path / "inbox"
        inbox.mkdir()
        for d in ["2026-02-27", "2026-02-25", "2026-02-26"]:
            (inbox / d).mkdir()
            (inbox / d / "note.md").write_text(d)

        result = list(iter_inbox_notes(inbox))
        dates = [p.parent.name for p in result]
        assert dates == ["2026-02-25", "2026-02-26", "2026-02-27"]


class TestGetDailyInboxDir:
    """get_daily_inbox_dir — 일별 폴더 생성."""

    def test_creates_today_folder(self, tmp_path, monkeypatch):
        from datetime import date
        monkeypatch.setattr("shared.vault_paths.INBOX", tmp_path)
        result = get_daily_inbox_dir()
        assert result.exists()
        assert result.name == date.today().isoformat()

    def test_creates_specific_date_folder(self, tmp_path, monkeypatch):
        monkeypatch.setattr("shared.vault_paths.INBOX", tmp_path)
        result = get_daily_inbox_dir("2026-02-25")
        assert result == tmp_path / "2026-02-25"
        assert result.exists()

    def test_idempotent(self, tmp_path, monkeypatch):
        monkeypatch.setattr("shared.vault_paths.INBOX", tmp_path)
        r1 = get_daily_inbox_dir("2026-02-25")
        r2 = get_daily_inbox_dir("2026-02-25")
        assert r1 == r2
