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
description: DESCRIPTION
allowed-tools:
  - gh
metadata: |
  {
    "owners": ["team-openclaw"]
  }
---
# Skill
"""
        previous_yaml = quick_validate.yaml
        quick_validate.yaml = None
        try:
            cases = [
                ("Works without pyyaml\n  Use for notes.", True),
                *[
                    (f"{header}\n  Summarize meetings.\n  Use for notes.", True)
                    for header in (">", ">-", ">+", ">2-", ">-2", "> # notes", "|-", "|2+")
                ],
                ("'>'", False),
                ('">-"', False),
                (">-\n  Summarize <meetings>.", False),
                (">-\n  Summarize meetings.\n  # <notes>", False),
                (">-", False),
                ("|-", False),
                (">-\n  " + "x" * 1025, False),
            ]
            for description, expected in cases:
                with self.subTest(description=description):
                    (skill_dir / "SKILL.md").write_text(
                        content.replace("DESCRIPTION", description), encoding="utf-8"
                    )
                    valid, message = quick_validate.validate_skill(skill_dir)
                    self.assertEqual(valid, expected, message)
        finally:
            quick_validate.yaml = previous_yaml

    def test_rejects_blank_name_or_description(self):
        skill_dir = self.temp_dir / "blank-field-skill"
        skill_dir.mkdir(parents=True, exist_ok=True)
        cases = [
            ('""', "a valid description", "Name must not be empty"),
            ("'   '", "a valid description", "Name must not be empty"),
            ("valid-skill", '""', "Description must not be empty"),
            ("valid-skill", "'   '", "Description must not be empty"),
        ]
        for name, description, expected in cases:
            with self.subTest(name=name, description=description):
                (skill_dir / "SKILL.md").write_text(
                    f"---\nname: {name}\ndescription: {description}\n---\n# Skill\n",
                    encoding="utf-8",
                )
                valid, message = quick_validate.validate_skill(skill_dir)
                self.assertFalse(valid)
                self.assertEqual(message, expected)

    def test_fallback_distinguishes_inline_comments_from_scalar_content(self):
        skill_dir = self.temp_dir / "comment-skill"
        skill_dir.mkdir()
        cases = [
            ("comment-skill # identifier", "Summarize reports", True),
            ('"comment-skill" # identifier', "Summarize reports", True),
            ("comment-skill", "Summarize reports # <notes>", True),
            ("comment-skill", '"Summarize reports" # <notes>', True),
            ("comment-skill", "Summarize user's reports # <notes>", True),
            ("comment-skill", 'Summarize "reports" # <notes>', True),
            ("comment-skill", r'"Summarize \"reports\" # now" # <notes>', True),
            ("comment-skill", "'Summarize user''s # reports' # <notes>", True),
            ("comment-skill", "# notes", False),
            ("comment-skill", '"" # notes', False),
            ("comment-skill", '"Summarize # <reports>"', False),
            ("comment-skill", r'"Summarize \" # <reports>" # notes', False),
            ("comment-skill", "'Summarize user''s # <reports>' # notes", False),
            ("comment-skill", "Summarize#<reports>", False),
            ("comment-skill", "|\n  Summarize # <reports>", False),
        ]
        previous_yaml = quick_validate.yaml
        quick_validate.yaml = None
        try:
            for name, description, expected in cases:
                with self.subTest(name=name, description=description):
                    (skill_dir / "SKILL.md").write_text(
                        f"---\nname: {name}\ndescription: {description}\n---\n", encoding="utf-8"
                    )
                    valid, message = quick_validate.validate_skill(skill_dir)
                    self.assertEqual(valid, expected, message)
        finally:
            quick_validate.yaml = previous_yaml

    def test_accepts_openclaw_invocation_frontmatter(self):
        skill_dir = self.temp_dir / "invocable-skill"
        skill_dir.mkdir(parents=True, exist_ok=True)
        content = """---
name: invocable-skill
description: A manually invoked skill
user-invocable: true
disable-model-invocation: true
command-dispatch: tool
command-tool: example_tool
command-arg-mode: raw
---
# Skill
"""
        (skill_dir / "SKILL.md").write_text(content, encoding="utf-8")

        valid, message = quick_validate.validate_skill(skill_dir)

        self.assertTrue(valid, message)


if __name__ == "__main__":
    main()
