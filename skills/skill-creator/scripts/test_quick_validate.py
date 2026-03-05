#!/usr/bin/env python3
"""
Regression tests for quick skill validation.
"""

import tempfile
from pathlib import Path
from unittest import TestCase, main

import quick_validate


class TestQuickValidate(TestCase):
    def setUp(self):
        self.temp_dir = Path(tempfile.mkdtemp(prefix="test_quick_validate_"))

    def tearDown(self):
        import shutil

        if self.temp_dir.exists():
            shutil.rmtree(self.temp_dir)

    def test_accepts_crlf_frontmatter(self):
        skill_dir = self.temp_dir / "crlf-skill"
        skill_dir.mkdir(parents=True, exist_ok=True)
        content = "---\r\nname: crlf-skill\r\ndescription: ok\r\n---\r\n# Skill\r\n"
        (skill_dir / "SKILL.md").write_text(content, encoding="utf-8")

        valid, message = quick_validate.validate_skill(skill_dir)

        self.assertTrue(valid, message)

    def test_rejects_missing_frontmatter_closing_fence(self):
        skill_dir = self.temp_dir / "bad-skill"
        skill_dir.mkdir(parents=True, exist_ok=True)
        content = "---\nname: bad-skill\ndescription: missing end\n# no closing fence\n"
        (skill_dir / "SKILL.md").write_text(content, encoding="utf-8")

        valid, message = quick_validate.validate_skill(skill_dir)

        self.assertFalse(valid)
        self.assertEqual(message, "Invalid frontmatter format")

    def test_fallback_parser_handles_multiline_frontmatter_without_pyyaml(self):
        skill_dir = self.temp_dir / "multiline-skill"
        skill_dir.mkdir(parents=True, exist_ok=True)
        content = """---
name: multiline-skill
description: Works without pyyaml
allowed-tools:
  - gh
metadata: |
  {
    "owners": ["team-openclaw"]
  }
---
# Skill
"""
        (skill_dir / "SKILL.md").write_text(content, encoding="utf-8")

        previous_yaml = quick_validate.yaml
        quick_validate.yaml = None
        try:
            valid, message = quick_validate.validate_skill(skill_dir)
        finally:
            quick_validate.yaml = previous_yaml

        self.assertTrue(valid, message)

    def _make_skill(self, name: str, description: str) -> Path:
        safe_name = name.strip().replace("/", "") or "unnamed-skill"
        skill_dir = self.temp_dir / safe_name
        skill_dir.mkdir(parents=True, exist_ok=True)
        content = f"---\nname: {name}\ndescription: {description}\n---\n# Skill\n"
        (skill_dir / "SKILL.md").write_text(content, encoding="utf-8")
        return skill_dir

    def test_rejects_empty_name(self):
        skill_dir = self._make_skill("", "valid description")
        valid, message = quick_validate.validate_skill(skill_dir)
        self.assertFalse(valid)
        self.assertEqual(message, "Name cannot be empty")

    def test_rejects_empty_description(self):
        skill_dir = self._make_skill("valid-name", "")
        valid, message = quick_validate.validate_skill(skill_dir)
        self.assertFalse(valid)
        self.assertEqual(message, "Description cannot be empty")

    def test_rejects_leading_hyphen_name(self):
        skill_dir = self._make_skill("-bad-name", "valid description")
        valid, message = quick_validate.validate_skill(skill_dir)
        self.assertFalse(valid)
        self.assertIn("kebab-case", message)

    def test_rejects_trailing_hyphen_name(self):
        skill_dir = self._make_skill("bad-name-", "valid description")
        valid, message = quick_validate.validate_skill(skill_dir)
        self.assertFalse(valid)
        self.assertIn("kebab-case", message)

    def test_rejects_consecutive_hyphens(self):
        skill_dir = self._make_skill("bad--name", "valid description")
        valid, message = quick_validate.validate_skill(skill_dir)
        self.assertFalse(valid)
        self.assertIn("kebab-case", message)

    def test_accepts_valid_kebab_name(self):
        skill_dir = self._make_skill("my-skill", "valid description")
        valid, message = quick_validate.validate_skill(skill_dir)
        self.assertTrue(valid, message)

    def test_accepts_name_with_digits(self):
        skill_dir = self._make_skill("skill-v2", "valid description")
        valid, message = quick_validate.validate_skill(skill_dir)
        self.assertTrue(valid, message)


if __name__ == "__main__":
    main()
