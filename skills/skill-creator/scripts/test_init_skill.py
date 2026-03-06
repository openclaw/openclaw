#!/usr/bin/env python3
"""Tests for init_skill helpers."""

from unittest import TestCase, main

from init_skill import parse_resources


class TestInitSkill(TestCase):
    def test_parse_resources_accepts_case_insensitive_values(self):
        parsed = parse_resources("Scripts, references,ASSETS,scripts")

        self.assertEqual(parsed, ["scripts", "references", "assets"])

    def test_parse_resources_rejects_unknown_values(self):
        with self.assertRaises(SystemExit) as ctx:
            parse_resources("scripts,unknown")

        self.assertEqual(ctx.exception.code, 1)


if __name__ == "__main__":
    main()
