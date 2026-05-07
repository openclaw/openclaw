#!/usr/bin/env python3
"""Regression tests for toolgen.py."""

from pathlib import Path
from unittest import TestCase, main
import importlib.util

MODULE_PATH = Path(__file__).with_name("toolgen.py")
spec = importlib.util.spec_from_file_location("toolgen", MODULE_PATH)
toolgen = importlib.util.module_from_spec(spec)
spec.loader.exec_module(toolgen)


class TestToolgen(TestCase):
    def test_generate_node_escapes_literal_js_object_braces(self):
        content = toolgen.generate_node(
            "fetcher",
            "Fetch URLs",
            [{"flag": "--url", "type": "string", "help": "URL"}],
        )

        self.assertIn("const args = {};", content)
        self.assertIn("console.log('Running fetcher with args:', args);", content)


if __name__ == "__main__":
    main()
