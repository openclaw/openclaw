#!/usr/bin/env python3
"""
Regression tests for skill initializer parsing behavior.
"""

import io
import sys
from contextlib import redirect_stdout
from pathlib import Path
from unittest import TestCase, main

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from init_skill import parse_resources


class TestParseResources(TestCase):
    def test_accepts_mixed_case_resources_with_order_preserving_deduplication(self):
        resources = parse_resources("Scripts, references,ASSETS,scripts,REFERENCES")

        self.assertEqual(resources, ["scripts", "references", "assets"])

    def test_ignores_empty_tokens_after_case_normalization(self):
        resources = parse_resources(" scripts, ,REFERENCES,,assets ")

        self.assertEqual(resources, ["scripts", "references", "assets"])

    def test_reports_invalid_resource_with_original_spelling(self):
        output = io.StringIO()

        with redirect_stdout(output), self.assertRaises(SystemExit) as raised:
            parse_resources("Scripts, BadResource")

        self.assertEqual(raised.exception.code, 1)
        self.assertIn("Unknown resource type(s): BadResource", output.getvalue())


if __name__ == "__main__":
    main()
