"""
Tests for bodhi_vault.obsidian_sync.

No Obsidian installation needed. Tests write to tmp_path directories.
All tests set OBSIDIAN_VAULT_PATH via monkeypatch.
"""

import os
from pathlib import Path

import pytest
from bodhi_vault.obsidian_sync import (
    DOMAIN_DIR,
    _node_to_obsidian_md,
    _safe_filename,
    _safe_person_name,
    sync_node,
    sync_person_notes,
    sync_to_obsidian,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

VALID_UUID = "550e8400-e29b-41d4-a716-446655440000"

FULL_NODE = {
    "id": VALID_UUID,
    "type": "Idea",
    "content": "self-organized criticality explains why insight cascades feel sudden",
    "energy_level": 4,
    "created_at": "2026-03-15T08:30:00+00:00",
    "source": "telegram",
    "tags": ["soc", "insight", "cognitive"],
    "domain": "cognitive",
    "media_type": "text",
    "people": ["Dr. Beggs", "colleague"],
    "social_context": "professional",
}


@pytest.fixture
def obsidian_vault(tmp_path: Path) -> Path:
    """Isolated Obsidian vault root for each test."""
    return tmp_path


# ---------------------------------------------------------------------------
# Unit tests — formatters and validators
# ---------------------------------------------------------------------------


def test_safe_filename_valid_uuid():
    assert _safe_filename(VALID_UUID) is True


def test_safe_filename_rejects_path_traversal():
    assert _safe_filename("../../../etc/passwd") is False


def test_safe_filename_rejects_short_id():
    assert _safe_filename("abc123") is False


def test_safe_filename_rejects_empty():
    assert _safe_filename("") is False


def test_safe_person_name_strips_path_separators():
    assert "/" not in _safe_person_name("foo/bar")
    assert "\\" not in _safe_person_name("foo\\bar")


def test_safe_person_name_truncates_long_names():
    long_name = "A" * 200
    assert len(_safe_person_name(long_name)) <= 80


def test_safe_person_name_null_bytes():
    result = _safe_person_name("foo\x00bar")
    assert "\x00" not in result


class TestNodeToObsidianMd:
    def test_contains_yaml_frontmatter(self):
        md = _node_to_obsidian_md(FULL_NODE)
        assert md.startswith("---\n")
        # Second --- closes frontmatter
        assert "\n---\n" in md

    def test_frontmatter_has_bodhi_id(self):
        md = _node_to_obsidian_md(FULL_NODE)
        assert f"bodhi_id: {VALID_UUID}" in md

    def test_frontmatter_has_energy(self):
        md = _node_to_obsidian_md(FULL_NODE)
        assert "energy: 4" in md

    def test_frontmatter_has_domain(self):
        md = _node_to_obsidian_md(FULL_NODE)
        assert "domain: cognitive" in md

    def test_frontmatter_tags_as_yaml_list(self):
        md = _node_to_obsidian_md(FULL_NODE)
        assert "tags:" in md
        assert "  - soc" in md
        assert "  - insight" in md

    def test_frontmatter_people_as_yaml_list(self):
        md = _node_to_obsidian_md(FULL_NODE)
        assert "people:" in md
        assert '  - "Dr. Beggs"' in md

    def test_body_contains_content(self):
        md = _node_to_obsidian_md(FULL_NODE)
        assert FULL_NODE["content"] in md

    def test_enriched_content_as_callout(self):
        node = {**FULL_NODE, "content_enriched": "expanded analysis of SOC"}
        md = _node_to_obsidian_md(node)
        assert "> [!note]+ Enriched" in md
        assert "> expanded analysis of SOC" in md

    def test_telegram_file_id_not_written(self):
        node = {**FULL_NODE, "media_type": "image", "media_ref": "AgACAgIAAxkBAAIBnA"}
        md = _node_to_obsidian_md(node)
        # Non-URL media refs must not appear — they're Telegram internal IDs
        assert "AgACAgIAAxkBAAIBnA" not in md

    def test_url_media_ref_is_written(self):
        node = {**FULL_NODE, "media_type": "link", "media_ref": "https://example.com/article"}
        md = _node_to_obsidian_md(node)
        assert "https://example.com/article" in md

    def test_missing_tags_emits_empty_list(self):
        node = {**FULL_NODE, "tags": []}
        md = _node_to_obsidian_md(node)
        assert "tags: []" in md

    def test_default_domain_when_missing(self):
        node = {k: v for k, v in FULL_NODE.items() if k != "domain"}
        md = _node_to_obsidian_md(node)
        assert "domain: uncategorized" in md


# ---------------------------------------------------------------------------
# sync_node — filesystem tests
# ---------------------------------------------------------------------------


class TestSyncNode:
    def test_creates_file_in_domain_subdir(self, obsidian_vault):
        sync_node(FULL_NODE, obsidian_vault)
        date_prefix = "2026-03-15"
        expected = obsidian_vault / "domains" / "cognitive" / f"{date_prefix}-{VALID_UUID}.md"
        assert expected.exists()

    def test_file_content_has_yaml_frontmatter(self, obsidian_vault):
        sync_node(FULL_NODE, obsidian_vault)
        date_prefix = "2026-03-15"
        f = obsidian_vault / "domains" / "cognitive" / f"{date_prefix}-{VALID_UUID}.md"
        content = f.read_text()
        assert content.startswith("---\n")

    def test_creates_parent_directories(self, obsidian_vault):
        node = {**FULL_NODE, "domain": "trading"}
        sync_node(node, obsidian_vault)
        assert (obsidian_vault / "domains" / "trading").is_dir()

    def test_unknown_domain_goes_to_uncategorized(self, obsidian_vault):
        node = {**FULL_NODE, "domain": "unknown-future-domain"}
        sync_node(node, obsidian_vault)
        uncategorized = obsidian_vault / "domains" / "uncategorized"
        assert any(uncategorized.iterdir())

    def test_skips_invalid_node_id(self, obsidian_vault):
        node = {**FULL_NODE, "id": "../../etc/passwd"}
        sync_node(node, obsidian_vault)
        # Nothing should be written
        domains_dir = obsidian_vault / "domains"
        assert not domains_dir.exists() or not any(domains_dir.rglob("*.md"))

    def test_write_is_atomic(self, obsidian_vault):
        """Verify no .tmp files remain after a successful sync."""
        sync_node(FULL_NODE, obsidian_vault)
        tmp_files = list(obsidian_vault.rglob("*.tmp"))
        assert tmp_files == []

    def test_wellness_domain_routing(self, obsidian_vault):
        node = {**FULL_NODE, "id": "660e8400-e29b-41d4-a716-446655440001", "domain": "wellness"}
        sync_node(node, obsidian_vault)
        assert (obsidian_vault / "domains" / "wellness").is_dir()

    def test_business_domain_routing(self, obsidian_vault):
        node = {**FULL_NODE, "id": "660e8400-e29b-41d4-a716-446655440002", "domain": "business"}
        sync_node(node, obsidian_vault)
        assert (obsidian_vault / "domains" / "business").is_dir()


# ---------------------------------------------------------------------------
# sync_person_notes — filesystem tests
# ---------------------------------------------------------------------------


class TestSyncPersonNotes:
    def test_creates_person_file(self, obsidian_vault):
        sync_person_notes(FULL_NODE, obsidian_vault)
        assert (obsidian_vault / "people" / "Dr. Beggs.md").exists()

    def test_creates_file_for_each_person(self, obsidian_vault):
        sync_person_notes(FULL_NODE, obsidian_vault)
        assert (obsidian_vault / "people" / "colleague.md").exists()

    def test_person_file_contains_interaction(self, obsidian_vault):
        sync_person_notes(FULL_NODE, obsidian_vault)
        content = (obsidian_vault / "people" / "Dr. Beggs.md").read_text()
        assert FULL_NODE["content"] in content

    def test_person_file_appends_on_second_call(self, obsidian_vault):
        sync_person_notes(FULL_NODE, obsidian_vault)
        node2 = {
            **FULL_NODE,
            "id": "660e8400-e29b-41d4-a716-446655440010",
            "content": "follow-up thought about Beggs and criticality",
            "created_at": "2026-03-16T10:00:00+00:00",
        }
        sync_person_notes(node2, obsidian_vault)
        content = (obsidian_vault / "people" / "Dr. Beggs.md").read_text()
        assert FULL_NODE["content"] in content
        assert "follow-up thought about Beggs" in content

    def test_no_people_is_no_op(self, obsidian_vault):
        node = {k: v for k, v in FULL_NODE.items() if k != "people"}
        sync_person_notes(node, obsidian_vault)
        people_dir = obsidian_vault / "people"
        assert not people_dir.exists()

    def test_path_traversal_in_person_name(self, obsidian_vault):
        node = {**FULL_NODE, "people": ["../../etc/passwd"]}
        sync_person_notes(node, obsidian_vault)
        # File should be written with sanitized name, not at the traversed path
        etc_dir = obsidian_vault.parent / "etc"
        assert not etc_dir.exists() or not (etc_dir / "passwd").exists()

    def test_write_is_atomic(self, obsidian_vault):
        sync_person_notes(FULL_NODE, obsidian_vault)
        tmp_files = list(obsidian_vault.rglob("*.tmp"))
        assert tmp_files == []


# ---------------------------------------------------------------------------
# sync_to_obsidian — env var gating
# ---------------------------------------------------------------------------


class TestSyncToObsidian:
    def test_disabled_when_env_var_unset(self, tmp_path, monkeypatch):
        monkeypatch.delenv("OBSIDIAN_VAULT_PATH", raising=False)
        sync_to_obsidian(FULL_NODE)
        # Nothing written anywhere
        assert not any(tmp_path.rglob("*.md"))

    def test_disabled_when_path_does_not_exist(self, monkeypatch):
        monkeypatch.setenv("OBSIDIAN_VAULT_PATH", "/nonexistent/path/to/vault")
        # Should not raise — silently disabled
        sync_to_obsidian(FULL_NODE)

    def test_enabled_when_env_var_set(self, obsidian_vault, monkeypatch):
        monkeypatch.setenv("OBSIDIAN_VAULT_PATH", str(obsidian_vault))
        sync_to_obsidian(FULL_NODE)
        assert any(obsidian_vault.rglob("*.md"))

    def test_never_raises(self, monkeypatch):
        """sync_to_obsidian must never propagate exceptions."""
        monkeypatch.setenv("OBSIDIAN_VAULT_PATH", "/nonexistent/path")
        # Should complete silently
        sync_to_obsidian(FULL_NODE)

    def test_syncs_people_when_present(self, obsidian_vault, monkeypatch):
        monkeypatch.setenv("OBSIDIAN_VAULT_PATH", str(obsidian_vault))
        sync_to_obsidian(FULL_NODE)
        assert (obsidian_vault / "people" / "Dr. Beggs.md").exists()

    def test_no_people_sync_when_field_absent(self, obsidian_vault, monkeypatch):
        monkeypatch.setenv("OBSIDIAN_VAULT_PATH", str(obsidian_vault))
        node = {k: v for k, v in FULL_NODE.items() if k != "people"}
        sync_to_obsidian(node)
        assert not (obsidian_vault / "people").exists()


# ---------------------------------------------------------------------------
# Domain coverage — verify all domains in DOMAIN_DIR are reachable
# ---------------------------------------------------------------------------


def test_all_domain_dirs_are_reachable(tmp_path):
    """Every domain in DOMAIN_DIR must produce a file in its mapped subdirectory."""
    for domain, subdir in DOMAIN_DIR.items():
        node_id = f"550e8400-e29b-41d4-a716-{abs(hash(domain)):012x}"[:36]
        # Pad to valid UUID format if hash produced shorter string
        node = {
            **FULL_NODE,
            "id": VALID_UUID,
            "domain": domain,
            "created_at": "2026-03-15T00:00:00+00:00",
        }
        vault = tmp_path / domain
        vault.mkdir()
        sync_node(node, vault)
        expected_dir = vault / "domains" / subdir
        assert expected_dir.is_dir(), f"Expected dir {expected_dir} for domain {domain!r}"
