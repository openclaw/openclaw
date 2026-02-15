#!/usr/bin/env python3
"""Tests for package_skill.py symlink and path traversal protections."""

import os
import sys
import tempfile
import zipfile
from pathlib import Path
from unittest.mock import patch

import pytest

# Ensure the scripts directory is importable.
sys.path.insert(0, str(Path(__file__).parent))

from package_skill import package_skill

MINIMAL_SKILL_MD = """\
---
name: test-skill
description: A test skill
---
# Test Skill
"""

MINIMAL_VALIDATE_RETURN = (True, "Skill is valid!")


def _create_skill_dir(tmp: Path) -> Path:
    """Create a minimal valid skill directory."""
    skill_dir = tmp / "test-skill"
    skill_dir.mkdir()
    (skill_dir / "SKILL.md").write_text(MINIMAL_SKILL_MD)
    return skill_dir


@pytest.fixture
def skill_env(tmp_path):
    """Provide a temp dir with a valid skill and output directory."""
    skill_dir = _create_skill_dir(tmp_path)
    output_dir = tmp_path / "out"
    output_dir.mkdir()
    return skill_dir, output_dir


class TestSymlinkProtection:
    """Symlinks inside the skill directory must be skipped during packaging."""

    @patch("package_skill.validate_skill", return_value=MINIMAL_VALIDATE_RETURN)
    def test_symlink_to_external_file_is_skipped(self, _mock, skill_env):
        skill_dir, output_dir = skill_env

        # Create an external sensitive file and symlink to it.
        external_file = skill_dir.parent / "secret.txt"
        external_file.write_text("super-secret")
        (skill_dir / "linked.txt").symlink_to(external_file)

        result = package_skill(str(skill_dir), str(output_dir))
        assert result is not None

        with zipfile.ZipFile(result) as zf:
            names = zf.namelist()
            assert any("SKILL.md" in n for n in names)
            # The symlinked file must NOT appear.
            assert not any("linked.txt" in n for n in names)
            assert not any("secret" in n for n in names)

    @patch("package_skill.validate_skill", return_value=MINIMAL_VALIDATE_RETURN)
    def test_symlink_directory_is_skipped(self, _mock, skill_env):
        skill_dir, output_dir = skill_env

        external_dir = skill_dir.parent / "external"
        external_dir.mkdir()
        (external_dir / "data.txt").write_text("external data")
        (skill_dir / "ext-link").symlink_to(external_dir)

        result = package_skill(str(skill_dir), str(output_dir))
        assert result is not None

        with zipfile.ZipFile(result) as zf:
            names = zf.namelist()
            assert not any("data.txt" in n for n in names)
            assert not any("ext-link" in n for n in names)

    @patch("package_skill.validate_skill", return_value=MINIMAL_VALIDATE_RETURN)
    def test_symlink_within_skill_dir_still_skipped(self, _mock, skill_env):
        """Even internal symlinks are skipped (defense-in-depth)."""
        skill_dir, output_dir = skill_env

        (skill_dir / "real.txt").write_text("real content")
        (skill_dir / "internal-link.txt").symlink_to(skill_dir / "real.txt")

        result = package_skill(str(skill_dir), str(output_dir))
        assert result is not None

        with zipfile.ZipFile(result) as zf:
            names = zf.namelist()
            assert any("real.txt" in n for n in names)
            assert not any("internal-link" in n for n in names)


class TestPathTraversal:
    """Files that resolve outside the skill directory must be skipped."""

    @patch("package_skill.validate_skill", return_value=MINIMAL_VALIDATE_RETURN)
    def test_normal_files_are_included(self, _mock, skill_env):
        skill_dir, output_dir = skill_env

        sub = skill_dir / "scripts"
        sub.mkdir()
        (sub / "run.sh").write_text("#!/bin/sh\necho hi")

        result = package_skill(str(skill_dir), str(output_dir))
        assert result is not None

        with zipfile.ZipFile(result) as zf:
            names = zf.namelist()
            assert any("SKILL.md" in n for n in names)
            assert any("run.sh" in n for n in names)


class TestPackagingHappyPath:
    """Ensure normal packaging still works after hardening."""

    @patch("package_skill.validate_skill", return_value=MINIMAL_VALIDATE_RETURN)
    def test_creates_skill_file(self, _mock, skill_env):
        skill_dir, output_dir = skill_env
        result = package_skill(str(skill_dir), str(output_dir))
        assert result is not None
        assert Path(result).exists()
        assert str(result).endswith(".skill")

    @patch("package_skill.validate_skill", return_value=MINIMAL_VALIDATE_RETURN)
    def test_skill_file_is_valid_zip(self, _mock, skill_env):
        skill_dir, output_dir = skill_env
        result = package_skill(str(skill_dir), str(output_dir))
        assert zipfile.is_zipfile(result)
