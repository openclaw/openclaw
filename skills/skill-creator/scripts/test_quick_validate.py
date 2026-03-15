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

    def test_rejects_allowed_tools_when_not_a_list(self):
        skill_dir = self.temp_dir / "bad-allowed-tools"
        skill_dir.mkdir(parents=True, exist_ok=True)
        content = """---
name: bad-allowed-tools
description: invalid allowed tools
allowed-tools: gh
---
# Skill
"""
        (skill_dir / "SKILL.md").write_text(content, encoding="utf-8")

        valid, message = quick_validate.validate_skill(skill_dir)

        self.assertFalse(valid)
        self.assertEqual(message, "'allowed-tools' must be a list of tool names")

    def test_rejects_allowed_tools_non_string_entries(self):
        skill_dir = self.temp_dir / "non-string-allowed-tools"
        skill_dir.mkdir(parents=True, exist_ok=True)
        content = """---
name: non-string-allowed-tools
description: invalid list entries
allowed-tools:
  - gh
  - 123
---
# Skill
"""
        (skill_dir / "SKILL.md").write_text(content, encoding="utf-8")

        class _YamlStub:
            YAMLError = Exception

            @staticmethod
            def safe_load(_text):
                return {
                    "name": "non-string-allowed-tools",
                    "description": "invalid list entries",
                    "allowed-tools": ["gh", 123],
                }

        previous_yaml = quick_validate.yaml
        quick_validate.yaml = _YamlStub
        try:
            valid, message = quick_validate.validate_skill(skill_dir)
        finally:
            quick_validate.yaml = previous_yaml

        self.assertFalse(valid)
        self.assertEqual(message, "'allowed-tools' entry #2 must be a string")

    def test_rejects_allowed_tools_empty_entries(self):
        skill_dir = self.temp_dir / "empty-allowed-tool"
        skill_dir.mkdir(parents=True, exist_ok=True)
        content = """---
name: empty-allowed-tool
description: invalid empty tool
allowed-tools:
  - gh
  - "   "
---
# Skill
"""
        (skill_dir / "SKILL.md").write_text(content, encoding="utf-8")

        class _YamlStub:
            YAMLError = Exception

            @staticmethod
            def safe_load(_text):
                return {
                    "name": "empty-allowed-tool",
                    "description": "invalid empty tool",
                    "allowed-tools": ["gh", "   "],
                }

        previous_yaml = quick_validate.yaml
        quick_validate.yaml = _YamlStub
        try:
            valid, message = quick_validate.validate_skill(skill_dir)
        finally:
            quick_validate.yaml = previous_yaml

        self.assertFalse(valid)
        self.assertEqual(message, "'allowed-tools' entry #2 cannot be empty")

    def test_fallback_rejects_non_string_allowed_tools_entries(self):
        skill_dir = self.temp_dir / "fallback-non-string-allowed-tools"
        skill_dir.mkdir(parents=True, exist_ok=True)
        content = """---
name: fallback-non-string-allowed-tools
description: invalid fallback list entries
allowed-tools: ["gh", 123]
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
        self.assertEqual(message, "'allowed-tools' entry #2 must be a string")

    def test_fallback_rejects_empty_dash_allowed_tools_entry(self):
        skill_dir = self.temp_dir / "fallback-empty-dash-allowed-tools"
        skill_dir.mkdir(parents=True, exist_ok=True)
        content = """---
name: fallback-empty-dash-allowed-tools
description: invalid fallback empty list entry
allowed-tools:
  - gh
  -
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
        self.assertEqual(message, "'allowed-tools' entry #2 cannot be empty")

    def test_rejects_allowed_tools_explicit_null(self):
        skill_dir = self.temp_dir / "null-allowed-tools"
        skill_dir.mkdir(parents=True, exist_ok=True)
        content = """---
name: null-allowed-tools
description: invalid null allowed tools
allowed-tools: null
---
# Skill
"""
        (skill_dir / "SKILL.md").write_text(content, encoding="utf-8")

        class _YamlStub:
            YAMLError = Exception

            @staticmethod
            def safe_load(_text):
                return {
                    "name": "null-allowed-tools",
                    "description": "invalid null allowed tools",
                    "allowed-tools": None,
                }

        previous_yaml = quick_validate.yaml
        quick_validate.yaml = _YamlStub
        try:
            valid, message = quick_validate.validate_skill(skill_dir)
        finally:
            quick_validate.yaml = previous_yaml

        self.assertFalse(valid)
        self.assertEqual(message, "'allowed-tools' must be a list of tool names")

    def test_fallback_accepts_yaml_flow_style_allowed_tools(self):
        skill_dir = self.temp_dir / "fallback-flow-allowed-tools"
        skill_dir.mkdir(parents=True, exist_ok=True)
        content = """---
name: fallback-flow-allowed-tools
description: flow list without pyyaml
allowed-tools: [gh, 'git status', "npm test"]
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

    def test_fallback_rejects_non_string_yaml_flow_scalars(self):
        skill_dir = self.temp_dir / "fallback-flow-non-string-scalars"
        skill_dir.mkdir(parents=True, exist_ok=True)
        content = """---
name: fallback-flow-non-string-scalars
description: flow list has non-string scalars
allowed-tools: [gh, 123, true]
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
        self.assertEqual(message, "'allowed-tools' entry #2 must be a string")

    def test_fallback_invalid_escape_does_not_crash(self):
        skill_dir = self.temp_dir / "fallback-flow-invalid-escape"
        skill_dir.mkdir(parents=True, exist_ok=True)
        content = """---
name: fallback-flow-invalid-escape
description: invalid escape should fail validation
allowed-tools: [gh, "\\x"]
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
        self.assertEqual(message, "'allowed-tools' must be a list of tool names")


if __name__ == "__main__":
    main()
