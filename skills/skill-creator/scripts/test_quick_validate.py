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

    def test_rejects_allowed_tools_scalar_with_pyyaml(self):
        skill_dir = self.temp_dir / "scalar-skill"
        skill_dir.mkdir(parents=True, exist_ok=True)
        content = """---
name: scalar-skill
description: bad allowed-tools
allowed-tools: gh
---
# Skill
"""
        (skill_dir / "SKILL.md").write_text(content, encoding="utf-8")

        valid, message = quick_validate.validate_skill(skill_dir)

        self.assertFalse(valid)
        self.assertEqual(message, "allowed-tools must be a YAML list of non-empty strings")

    def test_rejects_allowed_tools_empty_entries_with_pyyaml(self):
        skill_dir = self.temp_dir / "empty-allowed-tools-skill"
        skill_dir.mkdir(parents=True, exist_ok=True)
        content = """---
name: empty-allowed-tools-skill
description: bad allowed-tools
allowed-tools:
  - gh
  - ""
---
# Skill
"""
        (skill_dir / "SKILL.md").write_text(content, encoding="utf-8")

        valid, message = quick_validate.validate_skill(skill_dir)

        self.assertFalse(valid)
        self.assertEqual(message, "allowed-tools must be a YAML list of non-empty strings")

    def test_rejects_allowed_tools_scalar_without_pyyaml(self):
        skill_dir = self.temp_dir / "scalar-skill-fallback"
        skill_dir.mkdir(parents=True, exist_ok=True)
        content = """---
name: scalar-skill-fallback
description: bad allowed-tools
allowed-tools: gh
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

        self.assertFalse(valid)
        self.assertEqual(message, "allowed-tools must be a YAML list of non-empty strings")

    def test_rejects_allowed_tools_non_list_syntax_without_pyyaml(self):
        skill_dir = self.temp_dir / "bad-list-skill-fallback"
        skill_dir.mkdir(parents=True, exist_ok=True)
        content = """---
name: bad-list-skill-fallback
description: bad allowed-tools
allowed-tools:
  gh
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

        self.assertFalse(valid)
        self.assertEqual(message, "allowed-tools must be a YAML list of non-empty strings")


if __name__ == "__main__":
    main()
