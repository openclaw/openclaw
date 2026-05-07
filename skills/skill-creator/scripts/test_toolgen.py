#!/usr/bin/env python3
"""Regression tests for toolgen.py."""

import importlib.util
import subprocess
import sys
import tempfile
from pathlib import Path
from unittest import TestCase, main

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

    def test_generated_node_script_consumes_flag_values(self):
        content = toolgen.generate_node(
            "fetcher",
            "Fetch URLs",
            [
                {"flag": "--url", "type": "string", "help": "URL"},
                {"flag": "--timeout", "type": "int", "help": "Timeout"},
            ],
        )

        with tempfile.TemporaryDirectory(prefix="test_toolgen_node_") as tmp:
            script = Path(tmp, "fetcher.js")
            script.write_text(content)
            result = subprocess.run(
                [
                    "node",
                    str(script),
                    "--url",
                    "https://example.com",
                    "--timeout",
                    "5",
                ],
                capture_output=True,
                text=True,
                check=False,
            )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("url: 'https://example.com'", result.stdout)
        self.assertIn("timeout: '5'", result.stdout)

    def test_generate_python_escapes_single_quotes_in_help_text(self):
        content = toolgen.generate_python(
            "demo",
            "Bob's tool",
            [{"flag": "--name", "type": "str", "help": "Person's name"}],
        )

        with tempfile.TemporaryDirectory(prefix="test_toolgen_python_") as tmp:
            script = Path(tmp, "demo.py")
            script.write_text(content)
            result = subprocess.run(
                [sys.executable, "-m", "py_compile", str(script)],
                capture_output=True,
                text=True,
                check=False,
            )

        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    main()
