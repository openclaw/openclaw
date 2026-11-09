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

    def test_duplicate_key_check_keeps_typed_core_values_distinct(self):
        # A plain `true` is a boolean and a quoted `"true"` is a string under
        # the core schema; an explicit `!!str` tag also wins over the spelling.
        for metadata in (
            '{true: enabled, "true": active}',
            '{1: a, "1": b}',
            '{!!str true: enabled, TRUE: active}',
            '{!!int 012: enabled, "012": active}',
            '{!!float .inf: enabled, ".inf": active}',
            '{.nan: enabled, .NaN: active}',
            '{!!bool yes: enabled, true: active}',
            '{!!null bogus: enabled, null: active}',
            '{&key yes: enabled, *key : active}',
            '{! true: enabled, true: active}',
            '{!!binary YWJj: enabled, YWJj: active}',
            '{!!timestamp 2026-01-01: enabled, "2026-01-01": active}',
            '{&key !!str true: enabled, TRUE: active}',
        ):
            with self.subTest(metadata=metadata):
                content = (
                    "---\n"
                    "name: typed-keys-skill\n"
                    "description: Summarize meetings\n"
                    f"metadata: {metadata}\n"
                    "---\n"
                    "# Skill\n"
                )
                self.assertTrue(*self.validate_content(content))

    def test_duplicate_key_check_still_rejects_actual_duplicates(self):
        for left, right in (
            ("yes", "yes"),
            (".inf", ".inf"),
            ("1", "1.0"),
            (".inf", "1e999"),
            ("! true", '"true"'),
            ('"😀"', r'"\uD83D\uDE00"'),
        ):
            with self.subTest(left=left, right=right):
                content = (
                    "---\n"
                    "name: duplicate-skill\n"
                    "description: Summarize meetings\n"
                    f"metadata: {{{left}: enabled, {right}: active}}\n"
                    "---\n"
                    "# Skill\n"
                )
                valid, message = self.validate_content(content)
                self.assertFalse(valid)
                self.assertIn("found duplicate key", message)

    def test_unicode_placeholder_does_not_collide_with_escaped_keys(self):
        content = (
            "---\n"
            "name: unicode-keys-skill\n"
            "description: Summarize meetings\n"
            "# literal NEL: \u0085\n"
            r'metadata: {"\u0085": enabled, "\uE000": active}' + "\n"
            "---\n"
            "# Skill\n"
        )
        self.assertTrue(*self.validate_content(content))

    def test_unicode_placeholder_does_not_rewrite_description_escapes(self):
        content = (
            "---\n"
            "name: unicode-description-skill\n"
            r'description: "\uE000"' + "\n"
            "# literal NEL: \u0085\n"
            "---\n"
            "# Skill\n"
        )
        self.assertTrue(*self.validate_content(content))

    def test_nel_keys_survive_private_use_exhaustion(self):
        private_use = "".join(
            chr(codepoint)
            for start, end in ((0xE000, 0xF900), (0xF0000, 0xFFFFD), (0x100000, 0x10FFFD))
            for codepoint in range(start, end)
        )
        content = (
            "---\n"
            "name: unicode-exhaustion-skill\n"
            "description: Summarize meetings\n"
            "metadata:\n"
            "  ? \"a\u0085b\"\n"
            "  : enabled\n"
            "  ? \"a b\"\n"
            "  : active\n"
            f"# {private_use}\n"
            "---\n"
            "# Skill\n"
        )
        self.assertTrue(*self.validate_content(content))

    def test_multiline_unicode_breaks_are_not_folded_as_lf(self):
        for character, escape in (("\u0085", "u0085"), ("\u2028", "u2028"), ("\u2029", "u2029")):
            for second_key, expected in ((r'"a\nb"', True), (f'"a \\{escape}b"', False)):
                with self.subTest(escape=escape, second_key=second_key, expected=expected):
                    content = (
                        "---\n"
                        "name: multiline-unicode-skill\n"
                        "description: Summarize meetings\n"
                        "metadata:\n"
                        f"  ? \"a\n    {character}b\"\n"
                        "  : first\n"
                        f"  ? {second_key}\n"
                        "  : second\n"
                        "---\n"
                        "# Skill\n"
                    )
                    self.assertEqual(self.validate_content(content)[0], expected)

    def test_multiline_unicode_breaks_reject_unindented_document_markers(self):
        for character in ("\u0085", "\u2028", "\u2029"):
            for marker in ("---", "..."):
                with self.subTest(character=ord(character), marker=marker):
                    content = (
                        "---\n"
                        "name: unicode-skill\n"
                        "description: Summarize meetings\n"
                        f"metadata: \"a\n{marker}{character}b\"\n"
                        "---\n"
                    )
                    self.assertFalse(self.validate_content(content)[0])

    def test_multiline_unicode_breaks_allow_indented_document_markers(self):
        content = (
            "---\n"
            "name: unicode-skill\n"
            "description: Summarize meetings\n"
            "metadata: \"a\n  ---\u2028b\"\n"
            "---\n"
        )
        self.assertTrue(*self.validate_content(content))

    def test_duplicate_key_check_preserves_nel_in_quoted_keys(self):
        content = (
            "---\n"
            "name: unicode-keys-skill\n"
            "description: Summarize meetings\n"
            "metadata:\n"
            "  ? \"a\u0085b\"\n"
            "  : enabled\n"
            "  ? \"a b\"\n"
            "  : active\n"
            "---\n"
            "# Skill\n"
        )
        self.assertTrue(*self.validate_content(content))

    def test_duplicate_key_check_honors_tag_after_anchor_comment(self):
        content = (
            "---\n"
            "name: tagged-keys-skill\n"
            "description: Summarize meetings\n"
            "metadata:\n"
            "  ? &key # note\n"
            "    !!str true\n"
            "  : enabled\n"
            "  ? true\n"
            "  : active\n"
            "---\n"
            "# Skill\n"
        )
        self.assertTrue(*self.validate_content(content))

    def test_duplicate_key_check_rejects_merge_mapping_duplicates(self):
        for metadata in ("{<<: {a: 1}, <<: {b: 2}}", "{<<: {a: 1, a: 2}}"):
            with self.subTest(metadata=metadata):
                content = (
                    "---\n"
                    "name: duplicate-skill\n"
                    "description: Summarize meetings\n"
                    f"metadata: {metadata}\n"
                    "---\n"
                    "# Skill\n"
                )
                valid, message = self.validate_content(content)
                self.assertFalse(valid)
                self.assertIn("found duplicate key", message)

    def test_duplicate_key_check_rejects_omap_duplicates(self):
        for metadata in (
            "!!omap [a: 1, a: 2]",
            "!!omap [.nan: a, .NaN: b]",
            "!!omap [{&key a: 1}, {*key : 2}]",
            "!!omap [{&key !!binary YWJj: 1}, {*key : 2}]",
        ):
            with self.subTest(metadata=metadata):
                content = (
                    "---\n"
                    "name: duplicate-skill\n"
                    "description: Summarize meetings\n"
                    f"metadata: {metadata}\n"
                    "---\n"
                    "# Skill\n"
                )
                valid, message = self.validate_content(content)
                self.assertFalse(valid)
                self.assertIn("found duplicate key", message)

    def test_omap_alias_object_key_coexists_with_string_key(self):
        content = (
            "---\n"
            "name: omap-keys-skill\n"
            "description: Summarize meetings\n"
            "metadata: {defaults: &pair {a: 1}, entries: !!omap [*pair, {a: 2}]}\n"
            "---\n"
            "# Skill\n"
        )
        self.assertTrue(*self.validate_content(content))

    def test_duplicate_key_check_rejects_repeated_omap_pair_aliases(self):
        content = (
            "---\n"
            "name: duplicate-skill\n"
            "description: Summarize meetings\n"
            "metadata:\n"
            "  defaults: &pair {a: 1}\n"
            "  entries: !!omap [*pair, *pair]\n"
            "---\n"
            "# Skill\n"
        )
        valid, message = self.validate_content(content)
        self.assertFalse(valid)
        self.assertIn("found duplicate key", message)

    def test_duplicate_key_check_rejects_omap_complex_alias_keys(self):
        content = (
            "---\n"
            "name: duplicate-skill\n"
            "description: Summarize meetings\n"
            "metadata: {defaults: &pair {a: 1}, entries: !!omap [*pair, {? *pair : 2}]}\n"
            "---\n"
            "# Skill\n"
        )
        valid, message = self.validate_content(content)
        self.assertFalse(valid)
        self.assertIn("found duplicate key", message)

    def test_duplicate_key_check_accepts_long_decimal_zero(self):
        content = (
            "---\n"
            "name: long-number-skill\n"
            "description: Summarize meetings\n"
            "metadata:\n"
            f"  ? {'0' * 4301}\n"
            "  : enabled\n"
            "---\n"
            "# Skill\n"
        )
        self.assertTrue(*self.validate_content(content))

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
