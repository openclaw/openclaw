#!/usr/bin/env python3
"""
Regression tests for skill initialization helpers.
"""

import sys
from pathlib import Path
from unittest import TestCase, main
from unittest.mock import patch

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from init_skill import parse_resources


class TestParseResources(TestCase):
    def test_accepts_mixed_case_resources(self):
        resources = parse_resources("Scripts,References,ASSETS")

        self.assertEqual(resources, ["scripts", "references", "assets"])

    def test_dedupes_resources_case_insensitively(self):
        resources = parse_resources("scripts,Scripts,REFERENCES,references")

        self.assertEqual(resources, ["scripts", "references"])

    def test_ignores_empty_resource_tokens(self):
        resources = parse_resources(" scripts, , Assets ,")

        self.assertEqual(resources, ["scripts", "assets"])

    def test_reports_invalid_resources_with_original_spelling(self):
        with patch("builtins.print") as mock_print:
            with self.assertRaises(SystemExit) as raised:
                parse_resources("Scripts,BadThing")

        self.assertEqual(raised.exception.code, 1)
        messages = [call.args[0] for call in mock_print.call_args_list]
        self.assertEqual(messages[0], "[ERROR] Unknown resource type(s): BadThing")
        self.assertEqual(messages[1], "   Allowed: assets, references, scripts")


if __name__ == "__main__":
    main()
