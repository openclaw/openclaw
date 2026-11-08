#!/usr/bin/env python3
"""
Regression tests for quick skill validation.
"""

import tempfile
from pathlib import Path
from unittest import TestCase, main
from unittest.mock import patch

import quick_validate


class TestQuickValidate(TestCase):
    def setUp(self):
        temp_dir = tempfile.TemporaryDirectory(prefix="test_quick_validate_")
        self.addCleanup(temp_dir.cleanup)
        self.skill_dir = Path(temp_dir.name)

    def validate_content(self, content):
        (self.skill_dir / "SKILL.md").write_text(content, encoding="utf-8")
        return quick_validate.validate_skill(self.skill_dir)

    def test_accepts_crlf_frontmatter(self):
        content = "---\r\nname: crlf-skill\r\ndescription: ok\r\n---\r\n# Skill\r\n"
        valid, message = self.validate_content(content)
        self.assertTrue(valid, message)

    def test_rejects_missing_frontmatter_closing_fence(self):
        content = "---\nname: bad-skill\ndescription: missing end\n# no closing fence\n"
        valid, message = self.validate_content(content)
        self.assertFalse(valid)
        self.assertEqual(message, "Invalid frontmatter format")

    def test_fallback_parser_handles_multiline_frontmatter_without_pyyaml(self):
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
        with patch.object(quick_validate, "yaml", None):
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
                    rendered = content.replace("DESCRIPTION", description)
                    valid, message = self.validate_content(rendered)
                    self.assertEqual(valid, expected, message)

    def test_rejects_blank_name_or_description(self):
        cases = [
            ('""', "a valid description", "Name must not be empty"),
            ("'   '", "a valid description", "Name must not be empty"),
            ("valid-skill", '""', "Description must not be empty"),
            ("valid-skill", "'   '", "Description must not be empty"),
        ]
        for name, description, expected in cases:
            with self.subTest(name=name, description=description):
                valid, message = self.validate_content(
                    f"---\nname: {name}\ndescription: {description}\n---\n# Skill\n"
                )
                self.assertFalse(valid)
                self.assertEqual(message, expected)

    def test_fallback_distinguishes_inline_comments_from_scalar_content(self):
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
            ("comment-skill", "Summarize\n  reports # <notes>", True),
            ("comment-skill", "\n  Summarize reports # <notes>", True),
            ("comment-skill", "Summarize\n  reports # " + "x" * 1024, True),
            ("comment-skill", 'Summarize\n  "reports # <notes>', True),
            ("comment-skill", '"Summarize\n  reports # <content>"', False),
            ("comment-skill", '\n  "Summarize # <content>"', False),
        ]
        with patch.object(quick_validate, "yaml", None):
            for name, description, expected in cases:
                with self.subTest(name=name, description=description):
                    valid, message = self.validate_content(
                        f"---\nname: {name}\ndescription: {description}\n---\n"
                    )
                    self.assertEqual(valid, expected, message)

    def test_accepts_openclaw_invocation_frontmatter(self):
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
        valid, message = self.validate_content(content)
        self.assertTrue(valid, message)


if __name__ == "__main__":
    main()
