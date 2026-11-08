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
        self.assertTrue(*self.validate_content(content))

    def test_rejects_missing_frontmatter_closing_fence(self):
        content = "---\nname: bad-skill\ndescription: missing end\n# no closing fence\n"
        self.assertEqual(self.validate_content(content), (False, "Invalid frontmatter format"))

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
""".replace("\n---\n", "\n--- \t\n")
        with patch.object(quick_validate, "yaml", None):
            cases = [
                ("Works without pyyaml\n  Use for notes.", True),
                *[
                    (f"{header}\n  ---\n  Summarize meetings.\n  Use for notes.", True)
                    for header in (">", ">-", ">+", ">2-", ">-2", "> # notes", "|-", "|2+")
                ],
                ("'>'", False),
                ('">-"', False),
                (">-\n  Summarize\n  ---\n  <meetings>.", False),
                (">-\n  Summarize meetings.\n  # <notes>", False),
                (">-", False),
                ("|-", False),
                (">-\n  " + "x" * 1025, False),
            ]
            for description, expected in cases:
                with self.subTest(description=description):
                    rendered = content.replace("DESCRIPTION", description)
                    self.assertEqual(self.validate_content(rendered)[0], expected, description)

    def test_rejects_blank_name_or_description(self):
        cases = [
            ('""', "a valid description", "Name must not be empty"),
            ("'   '", "a valid description", "Name must not be empty"),
            ("valid-skill", '""', "Description must not be empty"),
            ("valid-skill", "'   '", "Description must not be empty"),
        ]
        for name, description, expected in cases:
            with self.subTest(name=name, description=description):
                self.assertEqual(
                    self.validate_content(f"---\nname: {name}\ndescription: {description}\n---\n# Skill\n"),
                    (False, expected),
                )

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
            ("comment-skill", "|\n  Summarize\n  ---\n  reports # <reports>", False),
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

    def test_accepts_colon_rich_description_in_both_parse_modes(self):
        content = (
            "---\n"
            "name: colon-skill\n"
            "description: Use anime style IMPORTANT: Must be kawaii\n"
            "---\n"
            "# Skill\n"
        )
        self.assertTrue(*self.validate_content(content))
        with patch.object(quick_validate, "yaml", None):
            self.assertTrue(*self.validate_content(content))

    def test_colon_rich_recovery_keeps_description_content_rules(self):
        content = (
            "---\n"
            "name: colon-skill\n"
            "description: Summarize <notes>: quick capture\n"
            "---\n"
            "# Skill\n"
        )
        self.assertEqual(
            self.validate_content(content),
            (False, "Description cannot contain angle brackets (< or >)"),
        )

    def test_colon_rich_recovery_requires_bare_key_form(self):
        for separator in (" : ", "\t: "):
            with self.subTest(separator=separator):
                content = f"---\nname: colon-skill\ndescription{separator}a: b\n---\n# Skill\n"
                self.assertFalse(self.validate_content(content)[0])

    def test_colon_rich_recovery_does_not_mask_flow_collection_errors(self):
        content = (
            "---\n"
            "name: colon-skill\n"
            "description: Summarize meetings\n"
            "metadata: [\n"
            "description: a: b\n"
            "]\n"
            "---\n"
            "# Skill\n"
        )
        valid, message = self.validate_content(content)
        self.assertFalse(valid)
        self.assertIn("Invalid YAML in frontmatter", message)

    def test_accepts_quoted_colon_rich_description_key(self):
        content = (
            "---\n"
            "name: colon-skill\n"
            '"description": Use anime style IMPORTANT: Must be kawaii\n'
            "---\n"
            "# Skill\n"
        )
        self.assertTrue(*self.validate_content(content))

    def test_colon_rich_recovery_rejects_duplicate_keys(self):
        content = (
            "---\n"
            "name: colon-skill\n"
            "description: Use anime style IMPORTANT: Must be kawaii\n"
            "name: other-skill\n"
            "---\n"
            "# Skill\n"
        )
        valid, message = self.validate_content(content)
        self.assertFalse(valid)
        self.assertIn("Invalid YAML in frontmatter", message)

    def test_colon_rich_recovery_keeps_astral_characters_whole(self):
        description = "x" * 1020 + "\U0001f600: y"
        self.assertEqual(len(description), 1024)
        content = f"---\nname: colon-skill\ndescription: {description}\n---\n# Skill\n"
        self.assertTrue(*self.validate_content(content))

    def test_rejects_unicode_line_separator_after_closing_fence(self):
        content = "---\nname: unicode-skill\ndescription: Summarize\n---\u2028Body\n"
        self.assertEqual(self.validate_content(content), (False, "Invalid frontmatter format"))

    def test_colon_rich_recovery_requires_mapping_value_error(self):
        for description in ("ab", '"a b"', "a:b", "https://example.com:8080/path"):
            with self.subTest(description=description):
                content = f"---\nname: dot-skill\ndescription:{description}\n---\n# Skill\n"
                self.assertFalse(self.validate_content(content)[0])
        content = "---\nname: colon-skill\ndescription: a:\n---\n# Skill\n"
        self.assertTrue(*self.validate_content(content))

    def test_duplicate_key_check_keeps_merge_keys(self):
        content = (
            "---\n"
            "name: merge-skill\n"
            "description: Summarize meetings\n"
            "metadata:\n"
            "  <<: &base\n"
            "    owner: team\n"
            "  extra: 1\n"
            "---\n"
            "# Skill\n"
        )
        self.assertTrue(*self.validate_content(content))

    def test_duplicate_key_check_uses_core_schema_scalar_identity(self):
        # The core schema keeps YAML 1.1 boolean spellings such as yes/on as
        # distinct strings; SafeLoader would construct both as True here.
        content = (
            "---\n"
            "name: core-keys-skill\n"
            "description: Summarize meetings\n"
            "metadata: {yes: enabled, on: active}\n"
            "---\n"
            "# Skill\n"
        )
        self.assertTrue(*self.validate_content(content))

    def test_duplicate_key_check_still_rejects_actual_duplicates(self):
        content = (
            "---\n"
            "name: duplicate-skill\n"
            "description: Summarize meetings\n"
            "metadata: {yes: enabled, yes: active}\n"
            "---\n"
            "# Skill\n"
        )
        valid, message = self.validate_content(content)
        self.assertFalse(valid)
        self.assertIn("found duplicate key", message)

    def test_colon_rich_recovery_keeps_other_yaml_errors(self):
        content = (
            "---\n"
            "name: broken-skill\n"
            "description: Use anime style IMPORTANT: Must be kawaii\n"
            "metadata: *missing\n"
            "---\n"
            "# Skill\n"
        )
        valid, message = self.validate_content(content)
        self.assertFalse(valid)
        self.assertIn("Invalid YAML in frontmatter", message)

    def test_rejects_indented_frontmatter_opening_fence(self):
        content = "  ---\nname: indented-skill\ndescription: Summarize meetings\n---\n# Skill\n"
        self.assertEqual(self.validate_content(content), (False, "Invalid frontmatter format"))
        with patch.object(quick_validate, "yaml", None):
            self.assertEqual(
                self.validate_content(content),
                (False, "Invalid frontmatter format"),
            )

    def test_accepts_opening_fence_with_trailing_whitespace(self):
        content = "--- \t\nname: spaced-skill\ndescription: Summarize meetings\n---\n# Skill\n"
        self.assertTrue(*self.validate_content(content))

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
        self.assertTrue(*self.validate_content(content))


if __name__ == "__main__":
    main()
